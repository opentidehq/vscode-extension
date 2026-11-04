// Node implementations of the resolver's probes: PATH lookup and `--version` runs. vscode-free.
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { processEnv } from "./env";
import type { ProbeOptions, ProbeResult } from "./resolve";

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH (with PATHEXT on Windows), like `which`. On Windows a name that already has an
 * extension (`opentide.exe`, as an MCP entry may say) is tried as it is first, as Windows does.
 */
export function which(
  name: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean = isFile,
  pathExt = process.env.PATHEXT,
): string | undefined {
  if (!envPath) return undefined;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathExts = (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions = platform !== "win32" ? [""] : path.win32.extname(name) ? ["", ...pathExts] : pathExts;
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      if (exists(candidate)) return candidate;
      if (extension && exists(path.join(dir, name + extension))) return path.join(dir, name + extension);
    }
  }
  return undefined;
}

/** Run `command args` and collect its output; never rejects. */
export function probe(
  command: string,
  args: readonly string[],
  options: ProbeOptions,
  base: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ProbeResult> {
  const env = processEnv(
    base,
    { env: options.env, restricted: options.restricted, binDirs: options.binDirs },
    platform,
    {
      NO_COLOR: "1",
    },
  );
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.execFile(
        command,
        [...args],
        { env, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? null
                : 0;
          const failure =
            error && code === null
              ? (error as { killed?: boolean }).killed
                ? `timed out after ${options.timeoutMs} ms`
                : error.message
              : undefined;
          resolve({
            code,
            stdout: String(stdout),
            stderr: String(stderr),
            ...(failure ? { error: failure } : {}),
          });
        },
      );
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: String(error) });
      return;
    }
    child.stdin?.end();
  });
}
