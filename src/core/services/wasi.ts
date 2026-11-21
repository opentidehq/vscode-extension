// The WASI module in the extension host (SPEC §4, tier 4): `opentide serve` and `opentide lsp start` with the
// workspace mounted as the module's file system and tenant requests answered by @opentide/wasi-host's
// FetchHost. Two hosts run the one module, with the same paths mapping, wire and environment (the vscode-free
// modules in src/core/wasi/):
//
//   - @vscode/wasm-wasi, when the ms-vscode.wasm-wasi-core extension is installed: the module is compiled once
//     per window and each process runs in the extension host (it also runs on vscode.dev);
//   - otherwise VS Code's own Node running the launcher (dist/wasi/launcher.cjs, `node:wasi`) as a child
//     process of the window, one per protocol, with the folders the host names mounted
//     (`OPENTIDE_WASI_MOUNTS`). Nothing to install: this is the zero-setup path.
//
// ms-vscode.wasm-wasi-core is no manifest dependency: it declares no support for untrusted workspaces, so VS
// Code disables it in Restricted Mode, and an extension that depended on it would not activate there.
import * as cp from "node:child_process";
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
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { MessageTransports } from "vscode-languageclient/node";
import { fromChildProcess, type ServeProcess } from "../backend/process";
import { terminateChild } from "../backend/terminate";
import type { Logger } from "../context";
import { cliCommand, type Runtime } from "../runtime/types";
import { Buffered } from "../wasi/buffered";
import { GUEST_HOME, wasiEnv } from "../wasi/env";
import { GuestPaths, guestPathOf, launcherMounts, type Mount } from "../wasi/paths";
import { wasiServeWire } from "../wasi/wire";

/** The extension that hosts WASI modules in VS Code. */
export const WASM_WASI_CORE = "ms-vscode.wasm-wasi-core";

/**
 * `initialize`'s params for the server: ask for `opentide/fetch`, so tenant requests reach the extension
 * host. `@opentide/wasi-host`'s `FETCH_CAPABILITY`, which test/unit/wasi/fetch-host.test.ts holds it to.
 */
export const WASI_INITIALIZE_PARAMS: object = { capabilities: { fetch: true } };

/** The language server's transports, and how to end its process. */
export interface WasiLanguageServer {
  readonly transports: MessageTransports;
  /** End the process: the client's `exit` normally has, so this is for one that did not. */
  terminate(): void;
}

/**
 * The language client's transports over a reader and a writer on the module's pipes, with the folders' URIs
 * (and `rootPath`) mapped to guest paths going out and back coming in.
 */
function mapped(inner: MessageReader, writable: MessageWriter, paths: GuestPaths): MessageTransports {
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
  return { reader, writer };
}

/**
 * The window's WASI host: starts a process per protocol on whichever host is there. Nothing here runs until
 * the first process is asked for.
 */
export class WasiHost implements vscode.Disposable {
  private api: Promise<Wasm | undefined> | undefined;
  private compiled: Promise<WebAssembly.Module> | undefined;
  private readonly live = new Set<WasmProcess>();
  private readonly children = new Set<cp.ChildProcess>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: () => Runtime | undefined,
    /** The environment of the extension host the module is given a filtered copy of (`wasiEnv`). */
    private readonly baseEnv: () => Readonly<Record<string, string | undefined>>,
    private readonly log: Logger,
  ) {}

  /**
   * The WASM WASI Core extension's API when it is installed and loads, else undefined, and the launcher
   * runs the module. Decided once per window (a restart after installing the extension asks again).
   */
  private wasmWasi(): Promise<Wasm | undefined> {
    this.api ??= (async () => {
      if (!vscode.extensions.getExtension(WASM_WASI_CORE)) {
        this.log.info(
          `WASI: ${WASM_WASI_CORE} is not installed: the module runs through VS Code's Node (the launcher), one process per protocol`,
        );
        return undefined;
      }
      try {
        const wasm = await WasmApi.load();
        this.log.info(`WASI: running under @vscode/wasm-wasi (${WASM_WASI_CORE} ${wasm.versions.extension})`);
        return wasm;
      } catch (error) {
        this.log.warn(
          `WASI: ${WASM_WASI_CORE} did not load (${error instanceof Error ? error.message : String(error)}): the module runs through VS Code's Node (the launcher)`,
        );
        return undefined;
      }
    })();
    return this.api;
  }

  /** Forget which host runs the module: the next process asks again (the runtime restarted). */
  reset(): void {
    this.api = undefined;
  }

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

  private folders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
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

  /** A WASI process under @vscode/wasm-wasi, with the guest paths of the folders it was given. */
  private async startWasm(
    wasm: Wasm,
    args: readonly string[],
  ): Promise<{ process: WasmProcess; paths: GuestPaths }> {
    const runtime = this.runtime();
    if (!runtime?.wasi) throw new Error("no WASI runtime");
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

  /** The launcher as a child process of the window, with every folder mounted (`OPENTIDE_WASI_MOUNTS`). */
  private startChild(args: readonly string[]): { child: cp.ChildProcess; paths: GuestPaths } {
    const runtime = this.runtime();
    if (!runtime?.wasi) throw new Error("no WASI runtime");
    const folders = this.folders();
    const mounts = launcherMounts(
      folders.map((folder) => ({
        name: folder.name,
        fsPath: folder.uri.fsPath,
        uri: folder.uri.toString(),
      })),
      process.platform,
      (guest) => vscode.Uri.file(guest).toString(),
    );
    const { command, args: launch } = cliCommand(runtime, args);
    const env: Record<string, string> = {
      ...wasiEnv(this.baseEnv(), { pwd: mounts[0]?.guest ?? "/workspace" }),
      ...runtime.env,
      OPENTIDE_WASI_MOUNTS: JSON.stringify(mounts.map(({ host, guest }) => ({ host, guest }))),
    };
    // Node on Windows needs these to start.
    for (const name of ["SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
      const value = this.baseEnv()[name];
      if (value) env[name] = value;
    }
    const child = cp.spawn(command, launch, {
      cwd: folders[0]?.uri.fsPath ?? this.context.globalStorageUri.fsPath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return { child, paths: new GuestPaths(mounts) };
  }

  /** `opentide serve`: the process `ServeClient` drives, with paths mapped and `opentide/fetch` answered. */
  async startServe(): Promise<ServeProcess> {
    // The package is ESM only: loaded when the first server starts, not at activation.
    const { FetchHost } = await import("@opentide/wasi-host");
    const wasm = await this.wasmWasi();
    if (!wasm) {
      const { child, paths } = this.startChild(["serve"]);
      return wasiServeWire(fromChildProcess(child), paths, (send) => new FetchHost(send));
    }
    const started = await this.startWasm(wasm, ["serve"]);
    const raw = this.rawProcess(started.process, "serve");
    return wasiServeWire(raw, started.paths, (send) => new FetchHost(send));
  }

  /** `opentide lsp start`: the language client's transports, with URIs and paths mapped. */
  async startLanguageServer(onStderr: (text: string) => void): Promise<WasiLanguageServer> {
    const wasm = await this.wasmWasi();
    if (!wasm) {
      const { child, paths } = this.startChild(["lsp", "start"]);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (text: string) => onStderr(text));
      child.stdin?.on("error", () => undefined);
      if (!child.stdout || !child.stdin) throw new Error("the launcher has no stdio");
      return {
        transports: mapped(
          new StreamMessageReader(child.stdout),
          new StreamMessageWriter(child.stdin),
          paths,
        ),
        terminate: () => {
          void terminateChild(child);
        },
      };
    }
    const { process: proc, paths } = await this.startWasm(wasm, ["lsp", "start"]);

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
    return {
      transports: mapped(inner, writable, paths),
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
    // The exit is a fact: a listener that comes after it still hears it.
    const close = new Buffered<[number | null, string | null]>(true);
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

  /**
   * End every process of the window and wait until they are gone: a launcher child gets the termination every path
   * uses (a polite stop, then its tree), so the extension host does not leave before they have.
   */
  async shutdown(): Promise<void> {
    const ending: Promise<unknown>[] = [];
    for (const proc of this.live) ending.push(proc.terminate().catch(() => undefined));
    this.live.clear();
    for (const child of this.children) ending.push(terminateChild(child));
    this.children.clear();
    await Promise.all(ending);
  }

  dispose(): void {
    void this.shutdown();
  }
}
