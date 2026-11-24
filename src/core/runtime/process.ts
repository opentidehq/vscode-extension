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

/**
 * The names in `dir`, for a PATH lookup: none when it does not exist (or is no folder), undefined when it cannot be
 * listed (no read permission: its files may still be found by name, so the lookup stats them instead).
 */
export async function listDirAsync(dir: string): Promise<readonly string[] | undefined> {
  try {
    return await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : undefined;
  }
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

  /** The names in each PATH folder, by folder, for the async lookups: one listing serves every name looked up. */
  private listings = new Map<string, Promise<ReadonlySet<string> | undefined>>();

  constructor(
    private readonly exists: (file: string) => boolean = isFile,
    private readonly existsAsync: (file: string) => Promise<boolean> = isFileAsync,
    private readonly listAsync: (dir: string) => Promise<readonly string[] | undefined> = listDirAsync,
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

  /** `which`, with every file system call off the calling thread. Concurrent lookups of one name share one search. */
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
      lookup = this.search(name, envPath, platform, pathExt).finally(() => {
        if (pending.get(name) === lookup) pending.delete(name);
      });
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
    this.listings = new Map();
  }

  /**
   * The first candidate that is a file, in PATH order. Every PATH folder is listed at once (one `readdir` each, all in
   * parallel, kept for the next names), and only a name a listing has is checked with a stat: on Windows that is about
   * a hundred listings instead of a stat for every folder and PATHEXT extension, one after another.
   */
  private async search(
    name: string,
    envPath: string | undefined,
    platform: NodeJS.Platform,
    pathExt: string | undefined,
  ): Promise<string | undefined> {
    const fold = (file: string) => (platform === "win32" ? file.toLowerCase() : file);
    const candidates = pathCandidates(name, envPath, platform, pathExt);
    const listings = this.listings;
    const listing = (dir: string): Promise<ReadonlySet<string> | undefined> => {
      let names = listings.get(dir);
      if (!names) {
        names = this.listAsync(dir).then((entries) => entries && new Set(entries.map(fold)));
        listings.set(dir, names);
      }
      return names;
    };
    const dirs = [...new Set(candidates.map((file) => path.dirname(file)))];
    const listed = new Map(await Promise.all(dirs.map(async (dir) => [dir, await listing(dir)] as const)));
    for (const file of candidates) {
      const names = listed.get(path.dirname(file));
      // A folder that could not be listed: its files are checked one by one, as the synchronous lookup does.
      if (names && !names.has(fold(path.basename(file)))) continue;
      if (await this.existsAsync(file)) return file;
    }
    return undefined;
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
