// The WASI module in the extension host (SPEC §4, tier 4): `opentide serve` and `opentide lsp start` run
// under @vscode/wasm-wasi (the ms-vscode.wasm-wasi-core extension, which also runs on vscode.dev), with the
// workspace mounted as the module's file system and tenant requests answered by @opentide/wasi-host's
// FetchHost. The one module, compiled once per window, starts each process. The mapping of paths, the wire
// and the environment are vscode-free modules (src/core/wasi/); this file is the glue to VS Code.
import type { RootFileSystem, Wasm, WasmProcess } from "@vscode/wasm-wasi/v1";
import { Wasm as WasmApi } from "@vscode/wasm-wasi/v1";
import * as vscode from "vscode";
import {
  Emitter,
  type MessageReader,
  type MessageWriter,
  ReadableStreamMessageReader,
  WriteableStreamMessageWriter,
} from "vscode-jsonrpc";
import type { MessageTransports } from "vscode-languageclient/node";
import type { ServeProcess } from "../backend/process";
import type { Logger } from "../context";
import type { Runtime } from "../runtime/types";
import { GUEST_HOME, wasiEnv } from "../wasi/env";
import { GuestPaths, guestPathOf, type Mount } from "../wasi/paths";
import { wasiServeWire } from "../wasi/wire";

/** The extension that hosts WASI modules in VS Code. */
export const WASM_WASI_CORE = "ms-vscode.wasm-wasi-core";

/**
 * `initialize`'s params for the server: ask for `opentide/fetch`, so tenant requests reach the extension
 * host. `@opentide/wasi-host`'s `FETCH_CAPABILITY`, which test/scripts/wasi-host.test.mjs holds it to.
 */
export const WASI_INITIALIZE_PARAMS: object = { capabilities: { fetch: true } };

/** A WASI process started under @vscode/wasm-wasi, with the guest paths of the folders it was given. */
interface StartedProcess {
  readonly process: WasmProcess;
  readonly paths: GuestPaths;
}

/** The language server's transports, and how to end its process. */
export interface WasiLanguageServer {
  readonly transports: MessageTransports;
  /** End the process: the client's `exit` normally has, so this is for one that did not. */
  terminate(): void;
}

/**
 * The window's WASI host: loads @vscode/wasm-wasi once, compiles the module once, and starts a process per
 * protocol. Nothing here runs until the first process is asked for.
 */
export class WasiHost implements vscode.Disposable {
  private api: Promise<Wasm> | undefined;
  private compiled: Promise<WebAssembly.Module> | undefined;
  private readonly live = new Set<WasmProcess>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: () => Runtime | undefined,
    /** The environment of the extension host the module is given a filtered copy of (`wasiEnv`). */
    private readonly baseEnv: () => Readonly<Record<string, string | undefined>>,
    private readonly log: Logger,
  ) {}

  /**
   * The WASM WASI Core extension's API, or why there is none. The manifest does not depend on it: VS Code
   * disables an extension that does not support untrusted workspaces (it declares no such capability) in
   * Restricted Mode, and an extension that depends on it would not activate there. So it is looked for
   * here, and offered once when it is missing.
   */
  private load(): Promise<Wasm> {
    this.api ??= this.loadApi().catch((error: unknown) => {
      this.api = undefined;
      throw error;
    });
    return this.api;
  }

  private async loadApi(): Promise<Wasm> {
    if (!vscode.extensions.getExtension(WASM_WASI_CORE)) {
      this.offerCore();
      throw new Error(`the WASM WASI Core extension (${WASM_WASI_CORE}) is not installed`);
    }
    try {
      return await WasmApi.load();
    } catch (error) {
      throw new Error(
        `the WASM WASI Core extension (${WASM_WASI_CORE}) did not load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private offered = false;

  /** Say once per window what runs the module and offer to install it; the runtime restarts once it is. */
  private offerCore(): void {
    if (this.offered) return;
    this.offered = true;
    void vscode.window
      .showWarningMessage(
        "opentide runs its bundled WebAssembly module with the WASM WASI Core extension, which is not installed. Without it only the editor features of the opentide engine run, and commands run without a warm server.",
        "Install",
      )
      .then(async (choice) => {
        if (choice !== "Install") return;
        await vscode.commands.executeCommand("workbench.extensions.installExtension", WASM_WASI_CORE);
        this.api = undefined;
        this.onInstalled?.();
      });
  }

  /** Called after the user installed the core extension: re-resolve and restart. */
  onInstalled: (() => void) | undefined;

  /** The module, compiled on first use and kept for every process of the window. */
  private module(wasm: Wasm, runtime: Runtime): Promise<WebAssembly.Module> {
    if (!runtime.wasi) throw new Error("the runtime is not the WASI module");
    const began = Date.now();
    this.compiled ??= wasm.compile(vscode.Uri.file(runtime.wasi.module)).then(
      (module) => {
        this.log.info(`WASI: compiled ${runtime.wasi?.module} in ${Date.now() - began} ms`);
        return module;
      },
      (error: unknown) => {
        this.compiled = undefined;
        throw error;
      },
    );
    return this.compiled;
  }

  /** The window's folders and the extension's global storage, as one root file system, and their guest paths. */
  private async mount(wasm: Wasm): Promise<{ root: RootFileSystem; paths: GuestPaths; pwd: string }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const root = await wasm.createRootFileSystem([
      { kind: "workspaceFolder" },
      { kind: "vscodeFileSystem", uri: this.context.globalStorageUri, mountPoint: GUEST_HOME },
    ]);
    const mounts: Mount[] = [];
    for (const folder of folders) {
      if (folder.uri.scheme !== "file") continue;
      const guest = (await root.toWasm(folder.uri)) ?? guestPathOf(folder.name, folders.length === 1);
      mounts.push({
        host: folder.uri.fsPath,
        hostUri: folder.uri.toString(),
        guest,
        guestUri: vscode.Uri.file(guest).toString(),
      });
    }
    return { root, paths: new GuestPaths(mounts), pwd: mounts[0]?.guest ?? "/workspace" };
  }

  private async start(args: readonly string[]): Promise<StartedProcess> {
    const runtime = this.runtime();
    if (!runtime?.wasi) throw new Error("no WASI runtime");
    const wasm = await this.load();
    const module = await this.module(wasm, runtime);
    const { root, paths, pwd } = await this.mount(wasm);
    const process = await wasm.createProcess("opentide", module, {
      args: [...args],
      env: wasiEnv(this.baseEnv(), { pwd, home: true }),
      rootFileSystem: root,
      stdio: { in: { kind: "pipeIn" }, out: { kind: "pipeOut" }, err: { kind: "pipeOut" } },
    });
    this.live.add(process);
    return { process, paths };
  }

  /** `opentide serve`: the process `ServeClient` drives, with paths mapped and `opentide/fetch` answered. */
  async startServe(): Promise<ServeProcess> {
    // The package is ESM only: loaded when the first server starts, not at activation.
    const { FetchHost } = await import("@opentide/wasi-host");
    const started = await this.start(["serve"]);
    const raw = this.rawProcess(started.process, "serve");
    return wasiServeWire(raw, started.paths, (send) => new FetchHost(send));
  }

  /** `opentide lsp start`: the language client's transports, with URIs and paths mapped. */
  async startLanguageServer(onStderr: (text: string) => void): Promise<WasiLanguageServer> {
    const started = await this.start(["lsp", "start"]);
    const proc = started.process;
    const { paths } = started;

    const dataEmitter = new Emitter<Uint8Array>();
    const closeEmitter = new Emitter<void>();
    const errorEmitter = new Emitter<[Error, unknown, number | undefined]>();
    proc.stdout?.onData((chunk) => dataEmitter.fire(chunk));
    const stderrDecoder = new TextDecoder();
    proc.stderr?.onData((chunk) => onStderr(stderrDecoder.decode(chunk, { stream: true })));
    void proc.run().then(
      (code) => {
        this.live.delete(proc);
        if (code !== 0) this.log.warn(`WASI: opentide lsp start exited with code ${code}`);
        closeEmitter.fire();
      },
      (error: unknown) => {
        this.live.delete(proc);
        this.log.warn(`WASI: opentide lsp start ended: ${String(error)}`);
        closeEmitter.fire();
      },
    );

    const inner = new ReadableStreamMessageReader({
      onData: (listener) => dataEmitter.event(listener),
      onClose: (listener) => closeEmitter.event(listener),
      onError: (listener) => errorEmitter.event((args) => listener(args[0])),
      onEnd: (listener) => closeEmitter.event(listener),
    });
    const writable = new WriteableStreamMessageWriter({
      onClose: (listener) => closeEmitter.event(listener),
      onError: (listener) => errorEmitter.event((args) => listener(args[0])),
      onEnd: (listener) => closeEmitter.event(listener),
      write: async (data) => {
        if (typeof data === "string") await proc.stdin?.write(data);
        else await proc.stdin?.write(new Uint8Array(data));
      },
      end: () => undefined,
    });
    const reader: MessageReader = {
      onError: inner.onError,
      onClose: inner.onClose,
      onPartialMessage: inner.onPartialMessage,
      listen: (callback) => inner.listen((message) => callback(paths.lspToHost(message))),
      dispose: () => inner.dispose(),
    };
    const writer: MessageWriter = {
      onError: writable.onError,
      onClose: writable.onClose,
      write: (message) => writable.write(paths.lspToGuest(message)),
      end: () => writable.end(),
      dispose: () => writable.dispose(),
    };
    return {
      transports: { reader, writer },
      terminate: () => {
        this.live.delete(proc);
        void proc.terminate().catch(() => undefined);
      },
    };
  }

  /** A WASI process as the `ServeProcess` the wire wraps: text in, text out, an exit code. */
  private rawProcess(proc: WasmProcess, name: string): ServeProcess {
    const decoder = new TextDecoder();
    const out = new Buffered<string>();
    const err = new Buffered<string>();
    const close = new Buffered<[number | null, string | null]>();
    const fail = new Buffered<Error>();
    proc.stdout?.onData((chunk) => out.push(decoder.decode(chunk, { stream: true })));
    const errDecoder = new TextDecoder();
    proc.stderr?.onData((chunk) => err.push(errDecoder.decode(chunk, { stream: true })));
    void proc.run().then(
      (code) => {
        this.live.delete(proc);
        close.push([code, null]);
      },
      (error: unknown) => {
        this.live.delete(proc);
        this.log.warn(`WASI: opentide ${name} ended: ${String(error)}`);
        close.push([null, null]);
      },
    );
    return {
      write: (text) => {
        void proc.stdin
          ?.write(text)
          .catch((error: unknown) => fail.push(error instanceof Error ? error : new Error(String(error))));
      },
      onStdout: (listener) => out.listen(listener),
      onStderr: (listener) => err.listen(listener),
      onError: (listener) => fail.listen(listener),
      onClose: (listener) => close.listen(([code, signal]) => listener(code, signal)),
      kill: () => {
        this.live.delete(proc);
        void proc.terminate().catch(() => undefined);
      },
    };
  }

  dispose(): void {
    for (const proc of this.live) void proc.terminate().catch(() => undefined);
    this.live.clear();
  }
}

/** Values that may arrive before anyone listens (a process starts running at once): held, then replayed. */
class Buffered<T> {
  private readonly held: T[] = [];
  private listener: ((value: T) => void) | undefined;

  push(value: T): void {
    if (this.listener) this.listener(value);
    else this.held.push(value);
  }

  listen(listener: (value: T) => void): void {
    this.listener = listener;
    for (const value of this.held.splice(0)) listener(value);
  }
}
