// Which host runs the WASI module in a desktop extension host. vscode-free.
//
//   - launcher: VS Code's own Node runs dist/wasi/launcher.cjs (`node:wasi`) as a child process, one per protocol.
//     Nothing to install. A 1,000-rule workspace gets its first diagnostics in 4.5 s (QA, rc.3 round, #100).
//   - wasm-wasi: @vscode/wasm-wasi, through the ms-vscode.wasm-wasi-core extension, in the extension host. The same
//     workspace takes 10.6 s, and the gap grows with the number of objects: the module's file reads go through that
//     host's file system layer.
//
// So where the launcher can run it runs the module, even when ms-vscode.wasm-wasi-core is installed (which other
// extensions make common). @vscode/wasm-wasi stays for the hosts the launcher cannot run in, and for the person who
// asks for it with `opentide.wasi.host`.

/** `opentide.wasi.host`. */
export type WasiHostSetting = "auto" | "launcher" | "wasm-wasi";

/** The host that runs the module. */
export type WasiHostKind = "launcher" | "wasm-wasi";

export function wasiHostSetting(value: unknown): WasiHostSetting {
  return value === "launcher" || value === "wasm-wasi" ? value : "auto";
}

export interface WasiHostInputs {
  readonly setting: WasiHostSetting;
  /** `ms-vscode.wasm-wasi-core` is installed. */
  readonly wasmWasiInstalled: boolean;
  /** Node can run the launcher here: it is in the package and the window has a folder on disk (or none at all). */
  readonly launcherUsable: boolean;
}

export interface WasiHostChoice {
  readonly host: WasiHostKind;
  /** What the output channel says about the choice. */
  readonly note: string;
}

const CORE = "ms-vscode.wasm-wasi-core";

export function chooseWasiHost({
  setting,
  wasmWasiInstalled,
  launcherUsable,
}: WasiHostInputs): WasiHostChoice {
  if (setting === "wasm-wasi") {
    return wasmWasiInstalled
      ? { host: "wasm-wasi", note: `opentide.wasi.host is wasm-wasi` }
      : {
          host: "launcher",
          note: `opentide.wasi.host is wasm-wasi, but ${CORE} is not installed: the module runs through VS Code's Node (the launcher)`,
        };
  }
  if (setting === "launcher") {
    if (launcherUsable) return { host: "launcher", note: `opentide.wasi.host is launcher` };
    return wasmWasiInstalled
      ? {
          host: "wasm-wasi",
          note: `opentide.wasi.host is launcher, but the launcher cannot run here: the module runs under @vscode/wasm-wasi`,
        }
      : { host: "launcher", note: `opentide.wasi.host is launcher` };
  }
  if (launcherUsable) {
    return {
      host: "launcher",
      note: wasmWasiInstalled
        ? `${CORE} is installed and not used: the module runs through VS Code's Node (the launcher), which starts faster on a large workspace (opentide.wasi.host: wasm-wasi asks for ${CORE})`
        : `${CORE} is not installed: the module runs through VS Code's Node (the launcher), one process per protocol`,
    };
  }
  return wasmWasiInstalled
    ? {
        host: "wasm-wasi",
        note: `the launcher cannot run here: the module runs under @vscode/wasm-wasi (${CORE})`,
      }
    : {
        host: "launcher",
        note: `the launcher cannot be checked here and ${CORE} is not installed: the module runs through the launcher`,
      };
}

/**
 * How the exit of the language server's process is logged: a process the extension ended itself (a restart, a
 * shutdown) is no failure, whatever code the host reports for it (@vscode/wasm-wasi reports 1 for a terminated
 * process, #99); one nobody asked to end, with a code other than 0, is.
 */
export function exitNote(
  name: string,
  code: number,
  endedByUs: boolean,
): { readonly level: "warn" | "debug"; readonly text: string } | undefined {
  if (endedByUs) return { level: "debug", text: `WASI: ${name} ended on request (exit code ${code})` };
  if (code !== 0) return { level: "warn", text: `WASI: ${name} exited with code ${code}` };
  return undefined;
}
