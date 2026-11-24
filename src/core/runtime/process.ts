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

/** `isFile` without blocking the thread. */
export async function isFileAsync(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The files a lookup of `name` on PATH tries, in order: each PATH folder, and on Windows each PATHEXT extension in
 * it. A name that already has an extension (`opentide.exe`, as an MCP entry may say) is tried as it is first, as
 * Windows does. One spelling per extension: Windows paths are case-insensitive, so `opentide.exe` finds
 * `opentide.EXE` too.
 */
export function pathCandidates(
  name: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (!envPath) return [];
  const delimiter = platform === "win32" ? ";" : ":";
  const pathExts = (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions = platform !== "win32" ? [""] : path.win32.extname(name) ? ["", ...pathExts] : pathExts;
  const candidates: string[] = [];
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) candidates.push(path.join(dir, name + extension.toLowerCase()));
  }
  return candidates;
}

/**
 * Find `name` on PATH (with PATHEXT on Windows), like `which`. Without `exists`, through the process's cache
 * (`pathLookup`); with one (tests, a fake filesystem), uncached.
 */
export function which(
  name: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  exists?: (file: string) => boolean,
  pathExt = process.env.PATHEXT,
): string | undefined {
  if (!exists) return pathLookup.which(name, envPath, platform, pathExt);
  return pathCandidates(name, envPath, platform, pathExt).find(exists);
}

/** The first of `candidates` that exists, in order, a few stats at a time. */
async function firstExisting(
  candidates: readonly string[],
  exists: (file: string) => Promise<boolean>,
  width = 16,
): Promise<string | undefined> {
  for (let at = 0; at < candidates.length; at += width) {
    const chunk = candidates.slice(at, at + width);
    const hits = await Promise.all(chunk.map(exists));
    const hit = hits.indexOf(true);
    if (hit >= 0) return chunk[hit];
  }
  return undefined;
}

/**
 * PATH lookups, remembered for as long as PATH, PATHEXT and the platform stay the same: on Windows a program that is
 * not installed costs a stat for every PATH folder and PATHEXT extension, and the runtime resolution, the terminal
 * integration and the MCP check each look up the same few names. A program found is checked again (one stat) before
 * it is returned; one not found stays not found until PATH changes or `clear` (a runtime restart, after the user
 * installed it).
 */
export class PathLookup {
  private key: string | undefined;
  private found = new Map<string, string | undefined>();
  private pending = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly exists: (file: string) => boolean = isFile,
    private readonly existsAsync: (file: string) => Promise<boolean> = isFileAsync,
  ) {}

  which(
    name: string,
    envPath: string | undefined,
    platform: NodeJS.Platform,
    pathExt = process.env.PATHEXT,
  ): string | undefined {
    const found = this.entries(envPath, platform, pathExt);
    if (found.has(name)) {
      const known = found.get(name);
      if (known === undefined || this.exists(known)) return known;
    }
    const result = pathCandidates(name, envPath, platform, pathExt).find((file) => this.exists(file));
    found.set(name, result);
    return result;
  }

  /** `which`, with every stat off the calling thread. Concurrent lookups of one name share their stats. */
  async whichAsync(
    name: string,
    envPath: string | undefined,
    platform: NodeJS.Platform,
    pathExt = process.env.PATHEXT,
  ): Promise<string | undefined> {
    const found = this.entries(envPath, platform, pathExt);
    if (found.has(name)) {
      const known = found.get(name);
      if (known === undefined || (await this.existsAsync(known))) return known;
    }
    const pending = this.pending;
    let lookup = pending.get(name);
    if (!lookup) {
      lookup = firstExisting(pathCandidates(name, envPath, platform, pathExt), this.existsAsync).finally(
        () => {
          if (pending.get(name) === lookup) pending.delete(name);
        },
      );
      pending.set(name, lookup);
    }
    const result = await lookup;
    // A PATH change or a clear while this looked: its answer is for the old PATH, so it is not kept.
    if (this.found === found) found.set(name, result);
    return result;
  }

  /** Forget every answer (a runtime restart: the user may have installed or removed a program since). */
  clear(): void {
    this.key = undefined;
    this.found = new Map();
    this.pending = new Map();
  }

  private entries(
    envPath: string | undefined,
    platform: NodeJS.Platform,
    pathExt: string | undefined,
  ): Map<string, string | undefined> {
    const key = `${platform}\0${envPath ?? ""}\0${platform === "win32" ? (pathExt ?? "") : ""}`;
    if (key !== this.key) {
      this.clear();
      this.key = key;
    }
    return this.found;
  }
}

/** The extension host's lookups. */
export const pathLookup = new PathLookup();

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
        {
          env,
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
          ...(options.signal ? { signal: options.signal } : {}),
        },
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
