// The npm package @opentide/opentide (the opentide SDK and command line, the Rust core as a Node-API
// addon) that a platform VSIX carries in dist/opentide/: its loader (index.js), its bin (cli.js), its
// package.json and LICENSE, and the one native addon for the VSIX's platform (opentide.<platform>.node),
// with opentide.json, which the runtime resolver reads (src/core/runtime/resolve.ts `readPackageManifest`).
//
// Where the package comes from, in order:
//   1. OPENTIDE_NPM=<dir> (`stageOpentide`'s `from`): a folder holding the npm tarballs (`npm pack` of the package
//      and of its native package for the platform, as opentide's publish.yml `npm-packages` artifact has
//      them), or a built bindings/node checkout (`npm run build` leaves opentide.<platform>.node beside
//      index.js);
//   2. the npm registry: `npm pack @opentide/opentide@<version>` and the native package, each checked
//      against pins.json `opentide.npm.integrity` (the registry's `dist.integrity`).
// Pure helpers, plus the staging that scripts/build.mjs and scripts/opentide.mjs call.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export class OpentideError extends Error {}

export const PACKAGE = "@opentide/opentide";

/**
 * The VSIX targets that carry the package, and the napi-rs platform of each: the six native packages
 * opentide publishes (no musl: Alpine gets the universal VSIX).
 */
export const TARGETS = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
};

/** The VSIX target of a machine (`process.platform`, `process.arch`), or undefined for one with no package. */
export function hostTarget(platform, arch, musl = false) {
  if (platform === "linux" && musl) return undefined;
  const target = `${platform}-${arch}`;
  return Object.hasOwn(TARGETS, target) ? target : undefined;
}

/** The napi-rs platform of a VSIX target; throws for a target with no native package. */
export function napiPlatform(target) {
  if (!Object.hasOwn(TARGETS, target))
    throw new OpentideError(
      `no @opentide/opentide native package for ${target}: the targets are ${Object.keys(TARGETS).join(", ")}`,
    );
  return TARGETS[target];
}

/** The native package's name for a napi-rs platform. */
export function nativePackage(platform) {
  return `${PACKAGE}-${platform}`;
}

/** The addon's file name in both packages. */
export function addonName(platform) {
  return `opentide.${platform}.node`;
}

/** npm's integrity string of a tarball: `sha512-<base64>`. */
export function integrityOf(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

/**
 * Read a gzipped tar (an npm tarball): Map of path (without npm's leading `package/`) to bytes. Only
 * regular files; a path that climbs out (`..`, absolute) is refused.
 */
export function readTarball(gz) {
  let tar;
  try {
    tar = gunzipSync(gz);
  } catch (error) {
    throw new OpentideError(`not a gzipped tarball: ${error instanceof Error ? error.message : error}`);
  }
  const files = new Map();
  let offset = 0;
  let longName;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.toString("utf8", 0, end < 0 ? length : end);
    };
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x" || type === "g") {
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (path?.[1] && type === "x") longName = path[1];
      continue;
    }
    if (type !== "0" && type !== "\0") continue;
    name = name.replace(/^package\//, "");
    if (name.split("/").includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name))
      throw new OpentideError(`unsafe path in tarball: ${name}`);
    files.set(name, Buffer.from(body));
  }
  return files;
}

function manifestOf(files, what) {
  const raw = files.get("package.json");
  if (!raw) throw new OpentideError(`${what} has no package.json`);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new OpentideError(`${what}'s package.json is not JSON`);
  }
}

/** What dist/opentide/ carries of the main package. */
export const MAIN_FILES = ["package.json", "index.js", "cli.js", "LICENSE"];

/**
 * The files of dist/opentide/ from the main package's and the native package's files: Map of name to
 * bytes, opentide.json included. The two must be the same version, the native one for `platform`.
 */
export function stagedFiles(main, native, platform, source) {
  const pkg = manifestOf(main, PACKAGE);
  if (pkg.name !== PACKAGE) throw new OpentideError(`expected ${PACKAGE}, found ${pkg.name}`);
  if (typeof pkg.version !== "string") throw new OpentideError(`${PACKAGE} has no version`);
  if (pkg.bin?.opentide !== "cli.js") throw new OpentideError(`${PACKAGE}'s bin opentide is not cli.js`);
  for (const name of ["index.js", "cli.js"])
    if (!main.has(name)) throw new OpentideError(`${PACKAGE} ${pkg.version} has no ${name}`);
  const addon = addonName(platform);
  const nativeBytes = native.get(addon);
  if (!nativeBytes) throw new OpentideError(`${nativePackage(platform)} has no ${addon}`);
  if (native.has("package.json")) {
    const nativePkg = manifestOf(native, nativePackage(platform));
    if (nativePkg.name !== nativePackage(platform))
      throw new OpentideError(`expected ${nativePackage(platform)}, found ${nativePkg.name}`);
    if (nativePkg.version !== pkg.version)
      throw new OpentideError(
        `${nativePackage(platform)} is ${nativePkg.version}, ${PACKAGE} is ${pkg.version}: they must match`,
      );
  }
  const out = new Map();
  for (const name of MAIN_FILES) {
    const data = main.get(name) ?? (name === "LICENSE" ? native.get("LICENSE") : undefined);
    if (data) out.set(name, data);
  }
  if (!out.has("LICENSE")) throw new OpentideError(`${PACKAGE} ${pkg.version} has no LICENSE`);
  out.set(addon, nativeBytes);
  out.set(
    "opentide.json",
    Buffer.from(`${JSON.stringify(packageManifest(pkg.version, platform, nativeBytes, source), null, 2)}\n`),
  );
  return out;
}

/** `opentide.json` in dist/opentide/: what the runtime resolver reads to offer the tier. */
export function packageManifest(version, platform, addon, source) {
  return {
    $comment: "Written by scripts/opentide-lib.mjs from @opentide/opentide. Do not edit.",
    name: PACKAGE,
    version,
    platform,
    cli: "cli.js",
    native: addonName(platform),
    nativeSha256: createHash("sha256").update(addon).digest("hex"),
    nativeBytes: addon.length,
    source,
  };
}

/** Every file under `dir` (relative paths, `/`-separated), `node_modules` and `.git` skipped. */
function walk(dir, depth = 4, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const file = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(file).isDirectory()) {
      if (depth > 0) out.push(...walk(file, depth - 1, rel));
    } else out.push(rel);
  }
  return out;
}

function readDirFiles(dir, names) {
  const files = new Map();
  for (const name of names) {
    const file = join(dir, name);
    if (existsSync(file)) files.set(name, readFileSync(file));
  }
  return files;
}

/**
 * The main and native packages' files from a local folder: npm tarballs anywhere under it, else a built
 * bindings/node checkout (the addon beside index.js, or in npm/<platform>/).
 */
export function fromDirectory(dir, platform) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new OpentideError(`${dir} is not a folder`);
  let main;
  let native;
  for (const rel of walk(dir).filter((name) => name.endsWith(".tgz"))) {
    const files = readTarball(readFileSync(join(dir, rel)));
    const name = files.has("package.json") ? manifestOf(files, rel).name : undefined;
    if (name === PACKAGE) main = files;
    else if (name === nativePackage(platform)) native = files;
  }
  if (!main && existsSync(join(dir, "package.json"))) {
    const candidate = readDirFiles(dir, MAIN_FILES);
    if (manifestOf(candidate, dir).name === PACKAGE) main = candidate;
  }
  if (!native) {
    const addon = addonName(platform);
    // Beside index.js (napi build's output; the folder's package.json is the main package's), or in
    // npm/<platform>/ with its own package.json.
    if (existsSync(join(dir, addon))) native = readDirFiles(dir, [addon]);
    else if (existsSync(join(dir, "npm", platform, addon)))
      native = readDirFiles(join(dir, "npm", platform), [addon, "package.json", "LICENSE"]);
  }
  if (!main) throw new OpentideError(`${dir} has no ${PACKAGE} (a tarball, or a built bindings/node)`);
  if (!native)
    throw new OpentideError(
      `${dir} has no ${nativePackage(platform)} (a tarball, or ${addonName(platform)})`,
    );
  return { main, native };
}

/**
 * The two tarballs from the npm registry (`npm pack`, cached in .cache/opentide-npm/), each checked
 * against its pinned integrity. Refused while pins.json has no integrity for them: nothing unpinned ships.
 */
export function fromRegistry(root, pin, platform, run = spawnSync) {
  const cache = join(root, ".cache", "opentide-npm");
  mkdirSync(cache, { recursive: true });
  const fetchOne = (name) => {
    const integrity = pin.npm?.integrity?.[name];
    if (!integrity)
      throw new OpentideError(
        `pins.json opentide.npm.integrity has no ${name}: ${PACKAGE} ${pin.version} is not pinned for the registry. ` +
          "Set OPENTIDE_NPM=<dir> to its tarballs or a built bindings/node",
      );
    const file = join(cache, `${name.replace("@", "").replace("/", "-")}-${pin.version}.tgz`);
    if (!existsSync(file)) {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = run(npm, ["pack", `${name}@${pin.version}`, "--pack-destination", cache, "--silent"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      if (result.status !== 0)
        throw new OpentideError(`npm pack ${name}@${pin.version} failed: ${result.stderr ?? ""}`);
    }
    const data = readFileSync(file);
    if (integrityOf(data) !== integrity) {
      rmSync(file, { force: true });
      throw new OpentideError(
        `${name}@${pin.version}: integrity ${integrityOf(data)} is not the pinned ${integrity}`,
      );
    }
    return readTarball(data);
  };
  return { main: fetchOne(PACKAGE), native: fetchOne(nativePackage(platform)) };
}

/**
 * Write dist/opentide/ for a VSIX target from `from` (a folder), else the registry. Returns the manifest.
 * The version must be pins.json `opentide.version`, unless `anyVersion` (a development build).
 */
export function stageOpentide(root, pin, { target, from, out, anyVersion = false, run } = {}) {
  const platform = napiPlatform(target);
  const { main, native } = from ? fromDirectory(from, platform) : fromRegistry(root, pin, platform, run);
  const files = stagedFiles(main, native, platform, from ? "local" : "npm");
  const manifest = JSON.parse(files.get("opentide.json").toString("utf8"));
  if (!anyVersion && manifest.version !== pin.version)
    throw new OpentideError(
      `${PACKAGE} is ${manifest.version}, pins.json opentide.version is ${pin.version} ` +
        "(set OPENTIDE_ANY_VERSION=1 for a development build)",
    );
  const dir = out ?? join(root, "dist", "opentide");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of files) writeFileSync(join(dir, name), data);
  return manifest;
}

/**
 * What `npm run build` stages, from its environment: undefined for none (the universal VSIX), else the
 * VSIX target and the local folder, if any. `OPENTIDE_TARGET` is a VSIX target, `host`, or `universal`;
 * unset, the build stages the machine's target only when `OPENTIDE_NPM` names a folder, so a plain
 * build (and the engine tests, which need no opentide anywhere) carries none.
 */
export function buildRequest(env, host) {
  const wanted = env.OPENTIDE_TARGET?.trim();
  const from = env.OPENTIDE_NPM?.trim() || undefined;
  if (wanted === "universal") return undefined;
  if (!wanted && !from) return undefined;
  const target = !wanted || wanted === "host" ? host : wanted;
  if (!target)
    throw new OpentideError(
      "this machine has no @opentide/opentide native package: set OPENTIDE_TARGET=universal",
    );
  napiPlatform(target);
  return { target, from, anyVersion: env.OPENTIDE_ANY_VERSION === "1" };
}

/** Whether this Linux runs musl libc (Node's report has no glibc version there). */
export function isMusl(report = process.report?.getReport?.()) {
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime;
}
