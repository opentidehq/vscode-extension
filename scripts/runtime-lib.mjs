// Pure helpers for scripts/runtime-lock.mjs and scripts/runtime-build.mjs: the targets, the
// python-build-standalone archive and its checksum, the hashed locks, what the build removes from the
// interpreter, and the BUILD-INFO, SBOM and THIRD-PARTY-NOTICES of a bundled runtime (SPEC §3).
import { createHash } from "node:crypto";

export class RuntimeError extends Error {}

/**
 * The eight per-platform VS Code targets. `pbs` is the python-build-standalone triple, `uv` the
 * `--python-platform` that resolves and installs the closure for it (glibc 2.28 is VS Code's own floor;
 * musl is musllinux_1_2), `os` picks the interpreter layout.
 */
export const TARGETS = {
  "win32-x64": { pbs: "x86_64-pc-windows-msvc", uv: "x86_64-pc-windows-msvc", os: "windows" },
  "win32-arm64": { pbs: "aarch64-pc-windows-msvc", uv: "aarch64-pc-windows-msvc", os: "windows" },
  "linux-x64": { pbs: "x86_64-unknown-linux-gnu", uv: "x86_64-manylinux_2_28", os: "linux" },
  "linux-arm64": { pbs: "aarch64-unknown-linux-gnu", uv: "aarch64-manylinux_2_28", os: "linux" },
  "alpine-x64": { pbs: "x86_64-unknown-linux-musl", uv: "x86_64-unknown-linux-musl", os: "linux" },
  "alpine-arm64": { pbs: "aarch64-unknown-linux-musl", uv: "aarch64-unknown-linux-musl", os: "linux" },
  "darwin-x64": { pbs: "x86_64-apple-darwin", uv: "x86_64-apple-darwin", os: "macos" },
  "darwin-arm64": { pbs: "aarch64-apple-darwin", uv: "aarch64-apple-darwin", os: "macos" },
};

/** The VS Code target of this machine, or undefined. `musl` is true on Alpine. */
export function hostTarget(platform, arch, musl = false) {
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (!cpu) return undefined;
  if (platform === "win32") return `win32-${cpu}`;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux") return musl ? `alpine-${cpu}` : `linux-${cpu}`;
  return undefined;
}

export function target(name) {
  const info = TARGETS[name];
  if (!info) throw new RuntimeError(`unknown target ${name}; one of ${Object.keys(TARGETS).join(", ")}`);
  return info;
}

/** The targets that get a bundled runtime (pins.json `runtimeTargets`); the others get the universal package. */
export function runtimeTargets(pins) {
  const list = pins.runtimeTargets;
  if (!Array.isArray(list)) throw new RuntimeError("pins.json has no runtimeTargets list");
  for (const name of list) target(name);
  return list;
}

/** Why a target gets the universal package instead of a runtime (pins.json `universalTargets`). */
export function universalReason(pins, name) {
  return pins.universalTargets?.[name] ?? "it is not listed in pins.json runtimeTargets";
}

/** Fail unless `name` gets a runtime. */
export function requireRuntimeTarget(pins, name) {
  target(name);
  if (!runtimeTargets(pins).includes(name)) {
    throw new RuntimeError(
      `${name} gets the universal package, not a bundled runtime: ${universalReason(pins, name)}`,
    );
  }
}

export function pythonMinor(cpython) {
  const match = /^(\d+)\.(\d+)/.exec(cpython);
  if (!match) throw new RuntimeError(`pins.json python.cpython is not a version: ${cpython}`);
  return `${match[1]}.${match[2]}`;
}

// --- python-build-standalone ----------------------------------------------------------------------

const PBS_RELEASES = "https://github.com/astral-sh/python-build-standalone/releases/download";

export function archiveName(pins, name) {
  const { cpython, pythonBuildStandalone, flavor } = pins.python;
  return `cpython-${cpython}+${pythonBuildStandalone}-${target(name).pbs}-${flavor}.tar.gz`;
}

export function archiveUrl(pins, name) {
  return `${PBS_RELEASES}/${pins.python.pythonBuildStandalone}/${encodeURIComponent(archiveName(pins, name))}`;
}

export function sha256SumsUrl(pins) {
  return `${PBS_RELEASES}/${pins.python.pythonBuildStandalone}/SHA256SUMS`;
}

/** `SHA256SUMS` -> Map of file name -> lower-case hash. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/**
 * The SHA-256 the archive must have. Once pins.json records it, that wins and SHA256SUMS is not needed;
 * before, it comes from the release's SHA256SUMS and `record` is true. A recorded hash of a different
 * archive (python-build-standalone or CPython bumped) fails: reset it to null in the same change.
 */
export function expectedArchiveSha(pins, name, sums) {
  const archive = archiveName(pins, name);
  const recorded = pins.runtimeArchives?.[name];
  if (recorded?.sha256) {
    if (recorded.archive && recorded.archive !== archive) {
      throw new RuntimeError(
        `pins.json runtimeArchives.${name} records ${recorded.archive}, but this build needs ${archive}; ` +
          `set its archive and sha256 to null when bumping python-build-standalone or CPython`,
      );
    }
    return { sha256: recorded.sha256.toLowerCase(), record: false, archive };
  }
  if (!sums) return undefined;
  const sha256 = sums.get(archive);
  if (!sha256) throw new RuntimeError(`SHA256SUMS of ${pins.python.pythonBuildStandalone} has no ${archive}`);
  return { sha256, record: true, archive };
}

// --- the native libraries inside the interpreter --------------------------------------------------

/**
 * The `full` archive of the same python-build-standalone release and target: the one that carries
 * `python/PYTHON.json` and `python/licenses/`, which `install_only_stripped` leaves out. The optimised
 * non-debug, non-free-threaded build, as `install_only` is made from.
 */
export function fullArchive(pins, name, sums) {
  const { cpython, pythonBuildStandalone } = pins.python;
  const prefix = `cpython-${cpython}+${pythonBuildStandalone}-${target(name).pbs}-`;
  for (const build of ["pgo+lto", "pgo", "lto", "noopt"]) {
    const archive = `${prefix}${build}-full.tar.zst`;
    const hash = sums.get(archive);
    if (hash)
      return {
        archive,
        sha256: hash,
        url: `${PBS_RELEASES}/${pythonBuildStandalone}/${encodeURIComponent(archive)}`,
      };
  }
  throw new RuntimeError(
    `SHA256SUMS of ${pythonBuildStandalone} has no full archive for ${name} (${prefix}*-full.tar.zst)`,
  );
}

/** Extension modules the build removes from the interpreter (`shouldRemove`): their libraries do not ship. */
export function moduleShips(module) {
  return !TEST_MODULE.test(module) && !TK_MODULE.test(module);
}

/**
 * The native libraries linked into the interpreter, from the full archive's PYTHON.json: one component
 * per licence file under `python/licenses/` (`LICENSE.openssl-3.txt` -> `openssl-3`), with the extension
 * modules that link it and the SPDX licences those modules share. CPython's own licence is not one of them. Components
 * whose every module the build removes (Tk) are left out.
 */
export function nativeComponents(pythonJson) {
  const byFile = new Map();
  const extensions = pythonJson?.build_info?.extensions ?? {};
  for (const [module, variants] of Object.entries(extensions)) {
    if (!moduleShips(module)) continue;
    const variant =
      (Array.isArray(variants) ? variants : []).find((v) => v.variant === "default") ?? variants?.[0];
    for (const licensePath of variant?.license_paths ?? []) {
      const file = licensePath.split("/").pop() ?? licensePath;
      if (file === "LICENSE.cpython.txt") continue;
      const name = /^LICENSE\.(.+)\.txt$/.exec(file)?.[1] ?? file;
      const licenses = variant.licenses?.length
        ? variant.licenses
        : variant.license_public_domain
          ? ["LicenseRef-Public-Domain"]
          : [];
      const component = byFile.get(file);
      // PYTHON.json gives a module's licences, not each file's: a library's are those every module
      // linking it shares (ncurses: _curses says X11, readline X11 and libedit's BSD-3-Clause).
      if (component) {
        component.modules.push(module);
        const shared = component.licenses.filter((license) => licenses.includes(license));
        if (shared.length > 0) component.licenses = shared;
      } else byFile.set(file, { name, file, modules: [module], licenses: [...licenses] });
    }
  }
  return [...byFile.values()]
    .map((c) => ({ ...c, modules: [...c.modules].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Licences whose binary redistribution must say how to obtain the library's complete source: Sleepycat
 * (Berkeley DB, clause 3). Such a component records its `source` from python-build-standalone.
 */
const SOURCE_OFFER_LICENSES = new Set(["Sleepycat"]);

export function needsSourceOffer(component) {
  return component.licenses.some((license) => SOURCE_OFFER_LICENSES.has(license));
}

/** python-build-standalone's `downloads.py` at a release: the version, URL and SHA-256 of each source. */
export function pbsDownloadsUrl(pythonBuildStandalone) {
  return `https://raw.githubusercontent.com/astral-sh/python-build-standalone/${pythonBuildStandalone}/pythonbuild/downloads.py`;
}

/** The `{ version, url, sha256 }` of `downloads.py`'s entry for `key` (a component name, `bdb`). */
export function downloadEntry(text, key) {
  const start = text.indexOf(`\n    "${key}": {`);
  if (start < 0) return undefined;
  const end = text.indexOf("\n    },", start);
  const block = text.slice(start, end < 0 ? undefined : end);
  const field = (name) => new RegExp(`\n\\s*"${name}":\\s*"([^"]+)"`).exec(block)?.[1];
  const [version, url, sha256] = [field("version"), field("url"), field("sha256")];
  return version && url && sha256 ? { version, url, sha256 } : undefined;
}

/** Where `npm run runtime:licenses` writes a target's native components and licence texts. */
export function nativeLicensesPath(name) {
  return `runtime-licenses/${name}.json`;
}

/**
 * The committed native licences of a target, checked against the pins: a python-build-standalone or
 * CPython bump needs `npm run runtime:licenses` again.
 */
export function checkNativeLicenses(pins, name, record) {
  const want = { pythonBuildStandalone: pins.python.pythonBuildStandalone, cpython: pins.python.cpython };
  if (!record)
    throw new RuntimeError(
      `${nativeLicensesPath(name)} is missing: run npm run runtime:licenses -- --target ${name}`,
    );
  if (record.pythonBuildStandalone !== want.pythonBuildStandalone || record.cpython !== want.cpython)
    throw new RuntimeError(
      `${nativeLicensesPath(name)} is for CPython ${record.cpython} (python-build-standalone ${record.pythonBuildStandalone}), ` +
        `pins.json has ${want.cpython} (${want.pythonBuildStandalone}): run npm run runtime:licenses -- --target ${name}`,
    );
  for (const component of record.components ?? []) {
    const text = record.texts?.[component.file];
    if (typeof text !== "string" && text !== null)
      throw new RuntimeError(`${nativeLicensesPath(name)} has no entry for ${component.file}`);
    if (needsSourceOffer(component) && !(component.source?.url && component.source?.version))
      throw new RuntimeError(
        `${nativeLicensesPath(name)} has no source for ${component.name}, whose ${component.licenses.join(" AND ")} ` +
          `licence asks the notices to say where it is: run npm run runtime:licenses -- --target ${name}`,
      );
  }
  return record;
}

/** Where the complete source of a component under a source-offer licence, and of CPython, is. */
function sourceOffer(record, component) {
  const { source } = component;
  if (!source) return [];
  const pbs = record.pythonBuildStandalone;
  return [
    `Source: the complete source of ${component.name} ${source.version}, as linked here, is available at ` +
      `no charge from ${source.url} (SHA-256 ${source.sha256}). python-build-standalone ${pbs} builds it ` +
      `and links it into CPython with the scripts at https://github.com/astral-sh/python-build-standalone/tree/${pbs}; ` +
      `the source of CPython ${record.cpython}, including the modules that use it (${component.modules.join(", ")}), ` +
      `is at https://www.python.org/ftp/python/${record.cpython}/Python-${record.cpython}.tar.xz.`,
  ];
}

/** The THIRD-PARTY-NOTICES sections of the native components (see `runtimeNotices`). */
export function nativeSections(record) {
  return (record.components ?? []).map((component) => ({
    title: `${component.name}, linked into CPython (${component.modules.join(", ")})`,
    license: component.licenses.join(" AND ") || "see the licence text",
    notes: sourceOffer(record, component),
    texts:
      typeof record.texts[component.file] === "string"
        ? [{ file: component.file, text: record.texts[component.file] }]
        : [],
  }));
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * pins.json text with `runtimeArchives.<name>` set to the archive and its SHA-256, formatted as Biome
 * formats it; the rest of the file is untouched.
 */
export function recordArchiveSha(text, name, archive, hash) {
  const pattern = new RegExp(`([ \\t]*)"${name}"\\s*:\\s*\\{[^{}]*\\}`);
  const match = pattern.exec(text);
  if (match) {
    const indent = match[1] ?? "";
    const entry = `${indent}"${name}": {\n${indent}  "archive": "${archive}",\n${indent}  "sha256": "${hash}"\n${indent}}`;
    return text.slice(0, match.index) + entry + text.slice(match.index + match[0].length);
  }
  const pins = JSON.parse(text);
  pins.runtimeArchives = { ...(pins.runtimeArchives ?? {}), [name]: { archive, sha256: hash } };
  return `${JSON.stringify(pins, null, 2)}\n`;
}

// --- the closure lock -----------------------------------------------------------------------------

export const REQUIREMENTS_IN = "runtime/requirements.in";

/** Text with CRLF line endings read as LF: a Windows checkout may convert the committed files. */
export function lf(text) {
  return text.replaceAll("\r\n", "\n");
}

/** The version `uv --version` prints ("uv 0.11.32 (…)"), or undefined. */
export function uvVersion(output) {
  return /^uv (\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}

/**
 * The tar that unpacks python-build-standalone. On Windows it is System32's bsdtar: a Git for Windows
 * shell puts GNU tar first on PATH, and GNU tar reads `D:\…` as a remote `host:file`.
 */
export function tarCommand(platform, env = {}) {
  if (platform !== "win32") return "tar";
  return `${(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").replace(/[\\/]+$/, "")}\\System32\\tar.exe`;
}

export function lockPath(name) {
  return `runtime/locks/${name}.txt`;
}

export function requirementsIn(pins) {
  return [
    "# The bundled runtime's closure. Generated from pins.json by `npm run runtime:lock`; do not edit.",
    `opentide==${pins.opentide.version}`,
    "",
  ].join("\n");
}

/** Environment for uv: macOS wheels must load on VS Code's oldest macOS. */
export function uvEnv(pins, name) {
  return target(name).os === "macos" && pins.python.macosDeploymentTarget
    ? { MACOSX_DEPLOYMENT_TARGET: pins.python.macosDeploymentTarget }
    : {};
}

/** `uv pip compile` arguments that lock the closure of one target; wheels only, every file hashed. */
export function lockArgs(pins, name, output) {
  return [
    "pip",
    "compile",
    REQUIREMENTS_IN,
    "--python-platform",
    target(name).uv,
    "--python-version",
    pins.python.cpython,
    "--generate-hashes",
    "--only-binary",
    ":all:",
    "--no-strip-markers",
    "--custom-compile-command",
    "npm run runtime:lock",
    "--quiet",
    "-o",
    output,
  ];
}

/** `uv pip install` arguments that install a lock for another platform into `site-packages`. */
export function installArgs(pins, name, lock, sitePackages, python) {
  return [
    "pip",
    "install",
    "--target",
    sitePackages,
    "--python-platform",
    target(name).uv,
    "--python-version",
    pins.python.cpython,
    "--require-hashes",
    "--only-binary",
    ":all:",
    "--no-compile",
    "--link-mode",
    "copy",
    ...(python ? ["--python", python] : []),
    "-r",
    lock,
  ];
}

/** The packages uv says have no wheel for the target, from its error output. */
export function packagesWithoutWheels(stderr) {
  const names = new Set();
  const patterns = [
    /(?:Because|and|,)\s+(?:all versions of\s+)?([A-Za-z0-9._-]+)(?:[=<>!~]=?[^\s,]+)?\s+(?:has|have) no (?:usable|compatible)? ?wheels?/g,
    /`([A-Za-z0-9._-]+)`[^\n]*?(?:has no|doesn't have a|does not have a) (?:usable |compatible )?(?:wheel|source distribution)/g,
    /Wheels are required for `([A-Za-z0-9._-]+)`/g,
  ];
  for (const pattern of patterns)
    for (const match of stderr.matchAll(pattern)) if (match[1]) names.add(match[1]);
  return [...names].sort();
}

/** A clear failure for a closure that has no wheels for a target. */
export function noWheelsError(name, stderr) {
  const missing = packagesWithoutWheels(stderr);
  if (
    missing.length === 0 &&
    !/no (?:usable |compatible )?wheels?|building from source is disabled/i.test(stderr)
  )
    return undefined;
  const what = missing.length > 0 ? missing.join(", ") : "a closure package";
  return new RuntimeError(
    `${name}: ${what} has no wheel for ${target(name).uv}, so there is no bundled runtime for this target. ` +
      `It gets the universal package: keep it out of pins.json runtimeTargets and say why in universalTargets.`,
  );
}

export function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A hashed requirements file -> [{ name, version, hashes }] (normalised names). */
export function parseLock(text) {
  const packages = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+\\$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const requirement = /^([A-Za-z0-9._-]+)==([^\s;]+)/.exec(line);
    if (requirement?.[1] && requirement[2]) {
      current = { name: normalizeName(requirement[1]), version: requirement[2], hashes: [] };
      packages.push(current);
    }
    for (const match of line.matchAll(/--hash=sha256:([0-9a-f]{64})/g))
      if (current && match[1]) current.hashes.push(match[1]);
  }
  for (const pkg of packages) {
    if (pkg.hashes.length === 0) throw new RuntimeError(`lock entry ${pkg.name}==${pkg.version} has no hash`);
  }
  return packages;
}

// --- trimming the interpreter ---------------------------------------------------------------------

/** The interpreter's own folders, relative to the runtime root. */
export function layout(name, cpython) {
  const minor = pythonMinor(cpython);
  return target(name).os === "windows"
    ? { python: "python.exe", stdlib: "Lib", sitePackages: "Lib/site-packages", dynload: "DLLs" }
    : {
        python: "bin/python3",
        stdlib: `lib/python${minor}`,
        sitePackages: `lib/python${minor}/site-packages`,
        dynload: `lib/python${minor}/lib-dynload`,
      };
}

const STDLIB_DROPPED = new Set(["tkinter", "idlelib", "ensurepip", "turtledemo", "test", "turtle.py"]);
const TEST_MODULE = /^(?:_test\w*|_ctypes_test|_testcapi|xxlimited\w*|xxsubtype)(?:\.|$)/;
const TK_MODULE = /^_tkinter(?:\.|$)/;

/**
 * Should the build remove this path (relative to the runtime root, `/`-separated)? What opentide never
 * loads (SPEC §3): the duplicate shared libpython when the binary is static, Tk and Tcl, headers and
 * import libraries, pip, idlelib, ensurepip, turtledemo, tests and `__pycache__`; also the man pages and
 * terminfo (`share/`), whose names differ only in case, which a VSIX cannot hold.
 */
export function shouldRemove(rel, { name, cpython, staticInterpreter }) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  const dirs = layout(name, cpython);
  if (base === "__pycache__") return true;
  const under = (dir) => (rel.startsWith(`${dir}/`) ? rel.slice(dir.length + 1) : undefined);

  const site = under(dirs.sitePackages);
  if (site !== undefined) {
    const [top = "", ...rest] = site.split("/");
    if (/^pip(?:-[^/]*\.dist-info)?$/.test(top)) return true;
    // A package's own test suite; a top-level `tests` package is left alone.
    return rest.length >= 1 && (base === "tests" || base === "test");
  }
  const stdlib = under(dirs.stdlib);
  if (stdlib !== undefined) {
    const [top = "", ...rest] = stdlib.split("/");
    if (STDLIB_DROPPED.has(top)) return true;
    if (/^config-\d/.test(top)) return true;
    if (rest.length >= 1 && (base === "test" || base === "tests" || base === "idle_test")) return true;
  }
  const dynload = under(dirs.dynload);
  if (dynload !== undefined && !dynload.includes("/")) {
    if (TEST_MODULE.test(dynload) || TK_MODULE.test(dynload)) return true;
    if (/^(?:tcl|tk)\d+t?\.dll$/i.test(dynload)) return true;
  }

  if (target(name).os === "windows") {
    if (parts.length === 1 && ["include", "libs", "tcl", "Scripts"].includes(base)) return true;
    return false;
  }
  if (parts.length === 1 && (base === "include" || base === "share")) return true;
  if (parts[0] === "bin" && parts.length === 2) {
    return /^(?:pip\d*(?:\.\d+)?|idle\d*(?:\.\d+)?|pydoc\d*(?:\.\d+)?|2to3(?:-\d+\.\d+)?|python\d*(?:\.\d+)?-config)$/.test(
      base,
    );
  }
  if (parts[0] === "lib" && parts.length === 2) {
    if (base === "pkgconfig") return true;
    if (/^(?:tcl|tk|itcl|thread)\d/.test(base) || /^lib(?:tcl|tk)\d/.test(base)) return true;
    if (staticInterpreter && /^libpython3(?:\.\d+)?\.(?:so(?:\.[\d.]+)?|dylib)$/.test(base)) return true;
  }
  return false;
}

/**
 * Is the interpreter binary static, so the shared libpython next to it is a duplicate? A dynamic one
 * names the library in its load commands (ELF DT_NEEDED, Mach-O LC_LOAD_DYLIB); a Windows python.exe
 * always loads python3XY.dll.
 */
export function isStaticInterpreter(name, cpython, binary) {
  if (target(name).os === "windows") return false;
  const minor = pythonMinor(cpython);
  return binary.indexOf(Buffer.from(`libpython${minor}.`)) < 0;
}

// --- metadata, licences, SBOM ---------------------------------------------------------------------

/** A core-metadata (METADATA, RFC 822) header block -> Map of lower-case field -> values. */
export function parseMetadata(text) {
  const fields = new Map();
  let last;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break;
    if (/^[ \t]/.test(line) && last) {
      const values = fields.get(last) ?? [];
      values[values.length - 1] = `${values[values.length - 1]}\n${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (!match?.[1]) continue;
    last = match[1].toLowerCase();
    fields.set(last, [...(fields.get(last) ?? []), match[2] ?? ""]);
  }
  return fields;
}

const CLASSIFIER_SPDX = {
  "MIT License": "MIT",
  "MIT No Attribution License (MIT-0)": "MIT-0",
  "Apache Software License": "Apache-2.0",
  "BSD License": undefined,
  "ISC License (ISCL)": "ISC",
  "Python Software Foundation License": "PSF-2.0",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "European Union Public Licence 1.2 (EUPL 1.2)": "EUPL-1.2",
  "The Unlicense (Unlicense)": "Unlicense",
  "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
  "GNU Library or Lesser General Public License (LGPL)": undefined,
  "Zope Public License": "ZPL-2.1",
};

const KNOWN_TEXT = {
  mit: "MIT",
  "mit license": "MIT",
  bsd: undefined,
  "bsd-3-clause": "BSD-3-Clause",
  "bsd 3-clause": "BSD-3-Clause",
  "3-clause bsd": "BSD-3-Clause",
  "bsd-2-clause": "BSD-2-Clause",
  "apache 2.0": "Apache-2.0",
  "apache-2.0": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "apache software license": "Apache-2.0",
  isc: "ISC",
  "mpl-2.0": "MPL-2.0",
  "psf-2.0": "PSF-2.0",
  "eupl-1.2": "EUPL-1.2",
};

/**
 * A distribution's licence as CycloneDX wants it: `{ expression }` from License-Expression (PEP 639),
 * else `{ id }` from a short License field or an unambiguous classifier, else `{ name }`.
 */
export function licenseOf(meta) {
  const expression = meta.get("license-expression")?.[0]?.trim();
  if (expression) return { expression };
  const field = meta.get("license")?.[0]?.trim();
  if (field && !field.includes("\n") && field.length <= 60) {
    const known = KNOWN_TEXT[field.toLowerCase()];
    if (known) return { id: known };
  }
  const ids = new Set();
  const names = [];
  for (const classifier of meta.get("classifier") ?? []) {
    const match = /^License :: (?:OSI Approved :: )?(.+)$/.exec(classifier.trim());
    if (!match?.[1] || match[1] === "OSI Approved") continue;
    const id = CLASSIFIER_SPDX[match[1]];
    if (id) ids.add(id);
    else names.push(match[1]);
  }
  if (ids.size === 1 && names.length === 0) return { id: [...ids][0] };
  if (ids.size > 1 && names.length === 0) return { expression: [...ids].sort().join(" OR ") };
  if (field && !field.includes("\n") && field.length <= 60 && !/^unknown$/i.test(field)) {
    return { name: field };
  }
  if (names.length > 0 || ids.size > 0) return { name: [...ids, ...names].join(" / ") };
  return { name: "see the licence files" };
}

export function licenseText(license) {
  return license.expression ?? license.id ?? license.name;
}

/** The licence files a dist-info names (License-File, PEP 639) or holds, relative to the dist-info. */
export function licenseFiles(meta, distInfoFiles) {
  const named = (meta.get("license-file") ?? []).map((file) => file.trim()).filter(Boolean);
  const found = new Set();
  for (const file of named) {
    for (const candidate of [`licenses/${file}`, file, `licenses/${file.split("/").pop()}`]) {
      if (distInfoFiles.includes(candidate)) {
        found.add(candidate);
        break;
      }
    }
  }
  if (found.size === 0) {
    for (const file of distInfoFiles) {
      if (/(?:^|\/)(?:licen[cs]e|copying|notice|authors)[^/]*$/i.test(file)) found.add(file);
    }
  }
  return [...found].sort();
}

/** The compatibility tags a wheel file name stands for (`py3-none-any`, expanded on `.`). */
export function wheelTags(filename) {
  const parts = filename.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) return new Set();
  const [pythons, abis, platforms] = parts.slice(-3).map((part) => part.split("."));
  const tags = new Set();
  for (const py of pythons ?? [])
    for (const abi of abis ?? []) for (const plat of platforms ?? []) tags.add(`${py}-${abi}-${plat}`);
  return tags;
}

/** The `Tag:` lines of an installed dist-info's WHEEL file. */
export function installedTags(wheelText) {
  return new Set(
    [...wheelText.matchAll(/^Tag:\s*(\S+)\s*$/gm)]
      .map((match) => match[1])
      .filter((tag) => tag !== undefined),
  );
}

/** Of a release's files (PyPI JSON `urls`), the wheel that was installed: same tags, hash in the lock. */
export function pickWheel(files, tags, lockHashes) {
  const want = [...tags].sort().join(" ");
  const candidates = files.filter(
    (file) =>
      file.filename.endsWith(".whl") &&
      lockHashes.includes(file.digests?.sha256) &&
      [...wheelTags(file.filename)].sort().join(" ") === want,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The id of a runtime build: what the extension compiles bytecode once for. */
export function buildId({ target: name, archiveSha256, lockSha256, opentide }) {
  return sha256(Buffer.from([name, archiveSha256, lockSha256, opentide].join("\n"))).slice(0, 16);
}

export function buildInfo({ pins, name, archiveSha256, lockSha256, staticInterpreter }) {
  return {
    schema: 1,
    buildId: buildId({ target: name, archiveSha256, lockSha256, opentide: pins.opentide.version }),
    target: name,
    platform: target(name).uv,
    opentide: pins.opentide.version,
    engine: pins.highlights?.version,
    cpython: pins.python.cpython,
    pythonBuildStandalone: pins.python.pythonBuildStandalone,
    flavor: pins.python.flavor,
    archive: archiveName(pins, name),
    archiveSha256,
    lock: lockPath(name),
    lockSha256,
    staticInterpreter,
    python: layout(name, pins.python.cpython).python,
  };
}

/** A deterministic RFC 4122 (version 5 layout) URN from a hex digest. */
export function serialNumber(hex) {
  const h = hex.padEnd(32, "0").slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `urn:uuid:${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function cdxLicense(license) {
  if (license.expression) return [{ expression: license.expression }];
  if (license.id) return [{ license: { id: license.id } }];
  return [{ license: { name: license.name } }];
}

/**
 * The CycloneDX 1.5 SBOM of a runtime: the interpreter and every distribution of the closure, each with
 * its licence, purl and the SHA-256 of the file that was installed.
 * `dists`: [{ name, version, license, wheel?: { filename, sha256, url } }].
 */
export function cyclonedx({ info, dists, extensionVersion, native = [] }) {
  const interpreter = {
    type: "application",
    "bom-ref": `cpython@${info.cpython}`,
    name: "cpython",
    version: info.cpython,
    description: `python-build-standalone ${info.pythonBuildStandalone} ${info.flavor} for ${info.target}`,
    licenses: [{ license: { id: "PSF-2.0" } }],
    purl: `pkg:github/astral-sh/python-build-standalone@${info.pythonBuildStandalone}#${info.archive}`,
    hashes: [{ alg: "SHA-256", content: info.archiveSha256 }],
    externalReferences: [
      {
        type: "distribution",
        url: `https://github.com/astral-sh/python-build-standalone/releases/download/${info.pythonBuildStandalone}/${encodeURIComponent(info.archive)}`,
      },
    ],
    // The native libraries linked into the interpreter (OpenSSL, zlib, …), from the full archive's PYTHON.json.
    ...(native.length > 0
      ? {
          components: native.map((component) => ({
            type: "library",
            "bom-ref": `cpython@${info.cpython}/${component.name}`,
            name: component.name,
            licenses: component.licenses.length
              ? component.licenses.map((id) =>
                  id.startsWith("LicenseRef-") ? { license: { name: id } } : { license: { id } },
                )
              : [{ license: { name: `see ${component.file}` } }],
            ...(component.source
              ? {
                  version: component.source.version,
                  hashes: [{ alg: "SHA-256", content: component.source.sha256 }],
                  externalReferences: [{ type: "source-distribution", url: component.source.url }],
                }
              : {}),
            properties: [{ name: "opentide:cpythonModules", value: component.modules.join(",") }],
          })),
        }
      : {}),
  };
  const components = [
    interpreter,
    ...[...dists]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((dist) => ({
        type: "library",
        "bom-ref": `pkg:pypi/${dist.name}@${dist.version}`,
        name: dist.name,
        version: dist.version,
        purl: `pkg:pypi/${dist.name}@${dist.version}`,
        licenses: cdxLicense(dist.license),
        ...(dist.wheel
          ? {
              hashes: [{ alg: "SHA-256", content: dist.wheel.sha256 }],
              externalReferences: [{ type: "distribution", url: dist.wheel.url }],
            }
          : {}),
      })),
  ];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serialNumber(sha256(Buffer.from(`${info.buildId}\n${extensionVersion}`))),
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `opentide-vscode-runtime@${extensionVersion}`,
        name: `opentide-vscode-runtime-${info.target}`,
        version: extensionVersion,
        description: `The opentide ${info.opentide} runtime bundled in the ${info.target} package of opentidehq.opentide`,
      },
      properties: [
        { name: "opentide:buildId", value: info.buildId },
        { name: "opentide:lockSha256", value: info.lockSha256 },
      ],
    },
    components,
    dependencies: [
      {
        ref: `opentide-vscode-runtime@${extensionVersion}`,
        dependsOn: components.map((component) => component["bom-ref"]),
      },
    ],
  };
}

/**
 * THIRD-PARTY-NOTICES text for the runtime: CPython's licence, then each distribution with its licence
 * and the text of every licence file it ships. `sections`: [{ title, license, texts: [{ file, text }] }].
 */
export function runtimeNotices(info, sections) {
  const out = [
    `Third-party software in the bundled opentide runtime (${info.target})`,
    "",
    "The extension (MIT) runs this runtime as a separate program. Each component keeps its own licence:",
    "opentide and its analysis engine are EUPL-1.2, CPython is PSF-2.0, and the rest are listed below.",
    "",
  ];
  for (const section of sections) {
    out.push("=".repeat(78), `${section.title} (${section.license})`, "=".repeat(78));
    for (const note of section.notes ?? []) out.push("", note);
    if (section.texts.length === 0)
      out.push("", `Licence: ${section.license}. The distribution ships no licence file.`);
    for (const { file, text } of section.texts) out.push("", `--- ${file}`, "", text.trim());
    out.push("");
  }
  return `${out.join("\n")}\n`;
}
