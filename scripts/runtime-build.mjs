#!/usr/bin/env node
// Builds the bundled opentide runtime for one target into runtime/ (SPEC §3 "Building the runtime"):
//   1. python-build-standalone `install_only_stripped` (pins.json python), SHA-256 checked against the
//      release's SHA256SUMS and then recorded in pins.json runtimeArchives, which later builds check;
//   2. unpacked into runtime/ and trimmed of what opentide never loads (scripts/runtime-lib.mjs);
//   3. the target's lock installed with uv for that platform: --require-hashes --only-binary :all:;
//   4. runtime/BUILD-INFO.json, runtime/sbom.cdx.json (CycloneDX) and runtime/THIRD-PARTY-NOTICES.txt.
//   node scripts/runtime-build.mjs --target <vscode-target> [--archive <file>]
// Downloads are cached in .cache/pbs/. runtime/requirements.in and runtime/locks/ are kept.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveName,
  archiveUrl,
  buildInfo,
  cyclonedx,
  expectedArchiveSha,
  hostTarget,
  installArgs,
  installedTags,
  isStaticInterpreter,
  layout,
  licenseFiles,
  licenseOf,
  licenseText,
  lockPath,
  normalizeName,
  noWheelsError,
  parseLock,
  parseMetadata,
  parseSha256Sums,
  pickWheel,
  RuntimeError,
  recordArchiveSha,
  requireRuntimeTarget,
  runtimeNotices,
  sha256,
  sha256SumsUrl,
  shouldRemove,
  uvEnv,
} from "./runtime-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "runtime");
const KEEP = new Set(["requirements.in", "locks"]);
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const uv = process.env.UV ?? "uv";
const log = (message) => console.log(`runtime:build: ${message}`);

async function download(url, file) {
  log(`GET ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new RuntimeError(`GET ${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.part`, buffer);
  renameSync(`${file}.part`, file);
}

/** Every path under `dir`, relative and `/`-separated; `visit` returns false to skip a directory. */
function walk(dir, visit, base = dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    const rel = relative(base, full).split(sep).join("/");
    if (visit(rel, full, stat) === false) continue;
    if (stat.isDirectory()) walk(full, visit, base);
  }
}

function removeMatching(context) {
  let removed = 0;
  walk(runtimeDir, (rel, full) => {
    if (rel === "requirements.in" || rel === "locks" || rel.startsWith("locks/")) return false;
    if (shouldRemove(rel, context)) {
      rmSync(full, { recursive: true, force: true });
      removed++;
      return false;
    }
    return true;
  });
  return removed;
}

/** Replace symlinks: bin/python3 becomes the binary itself, a link to a kept file becomes a copy. */
function dereferenceLinks(pythonRel) {
  const python = join(runtimeDir, pythonRel);
  if (lstatSync(python, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const real = realpathSync(python);
    rmSync(python);
    renameSync(real, python);
  }
  const links = [];
  walk(runtimeDir, (_rel, full, stat) => {
    if (stat.isSymbolicLink()) links.push(full);
    return !stat.isSymbolicLink();
  });
  for (const link of links) {
    let real;
    try {
      real = realpathSync(link);
    } catch {
      real = undefined;
    }
    const inside = real?.startsWith(realpathSync(runtimeDir) + sep) === true;
    const pointsTo = readlinkSafe(link);
    rmSync(link, { force: true });
    // Aliases of the interpreter (python, python3.13) are dropped: the extension runs bin/python3.
    if (inside && real !== python && statSync(real).isFile() && !link.endsWith(`${sep}python`)) {
      copyFileSync(real, link);
    } else if (real !== undefined && !inside) {
      log(`dropped symlink ${relative(runtimeDir, link)} -> ${pointsTo}`);
    }
  }
}

function readlinkSafe(link) {
  try {
    return readlinkSync(link);
  } catch {
    return "?";
  }
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  walk(dir, (_rel, _full, stat) => {
    if (stat.isFile()) {
      bytes += stat.size;
      files++;
    }
    return true;
  });
  return { bytes, files };
}

/** The installed distributions: [{ name, version, meta, dir, files, tags }]. */
function installedDists(sitePackages) {
  const dists = [];
  for (const entry of readdirSync(sitePackages).sort()) {
    if (!entry.endsWith(".dist-info")) continue;
    const dir = join(sitePackages, entry);
    const meta = parseMetadata(readFileSync(join(dir, "METADATA"), "utf8"));
    const files = [];
    walk(dir, (rel, _full, stat) => {
      if (stat.isFile()) files.push(rel);
      return true;
    });
    const wheel = existsSync(join(dir, "WHEEL")) ? readFileSync(join(dir, "WHEEL"), "utf8") : "";
    dists.push({
      name: normalizeName(meta.get("name")?.[0] ?? entry.replace(/-[^-]+\.dist-info$/, "")),
      version: meta.get("version")?.[0] ?? "",
      meta,
      dir,
      files,
      tags: installedTags(wheel),
    });
  }
  return dists;
}

async function pypiFiles(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const response = await fetch(url);
  if (!response.ok) throw new RuntimeError(`GET ${url}: HTTP ${response.status}`);
  return (await response.json()).urls ?? [];
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

async function main() {
  const name = option("--target");
  if (!name)
    throw new RuntimeError("usage: npm run runtime:build -- --target <vscode-target> [--archive <file>]");
  const pinsPath = join(root, "pins.json");
  let pinsText = readFileSync(pinsPath, "utf8");
  const pins = JSON.parse(pinsText);
  requireRuntimeTarget(pins, name);
  const { cpython } = pins.python;
  const dirs = layout(name, cpython);

  const lockFile = join(root, lockPath(name));
  if (!existsSync(lockFile)) throw new RuntimeError(`${lockPath(name)} is missing: run npm run runtime:lock`);
  const lockText = readFileSync(lockFile, "utf8");
  const lock = parseLock(lockText);

  // 1. The interpreter archive, checked.
  const archive = archiveName(pins, name);
  const archivePath = option("--archive")
    ? resolve(option("--archive"))
    : join(root, ".cache", "pbs", archive);
  if (!existsSync(archivePath)) await download(archiveUrl(pins, name), archivePath);
  let expected = expectedArchiveSha(pins, name);
  if (!expected) {
    const response = await fetch(sha256SumsUrl(pins), { redirect: "follow" });
    if (!response.ok) throw new RuntimeError(`GET ${sha256SumsUrl(pins)}: HTTP ${response.status}`);
    expected = expectedArchiveSha(pins, name, parseSha256Sums(await response.text()));
  }
  const archiveSha256 = sha256(readFileSync(archivePath));
  if (archiveSha256 !== expected.sha256) {
    throw new RuntimeError(`${archive}: SHA-256 is ${archiveSha256}, expected ${expected.sha256}`);
  }
  if (expected.record) {
    pinsText = recordArchiveSha(pinsText, name, archive, archiveSha256);
    writeFileSync(pinsPath, pinsText);
    log(`recorded ${archive} (${archiveSha256}) in pins.json runtimeArchives.${name}`);
  }

  // 2. Unpack into runtime/, keeping requirements.in and locks/.
  mkdirSync(runtimeDir, { recursive: true });
  for (const entry of readdirSync(runtimeDir)) {
    if (!KEEP.has(entry)) rmSync(join(runtimeDir, entry), { recursive: true, force: true });
  }
  const unpack = join(runtimeDir, ".unpack");
  mkdirSync(unpack);
  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", unpack], { stdio: "inherit" });
  if (tar.status !== 0) throw new RuntimeError(`tar could not unpack ${archivePath}`);
  for (const entry of readdirSync(join(unpack, "python"))) {
    renameSync(join(unpack, "python", entry), join(runtimeDir, entry));
  }
  rmSync(unpack, { recursive: true, force: true });

  dereferenceLinks(dirs.python);
  const pythonPath = join(runtimeDir, dirs.python);
  if (!existsSync(pythonPath)) throw new RuntimeError(`${archive} has no ${dirs.python}`);
  const staticInterpreter = isStaticInterpreter(name, cpython, readFileSync(pythonPath));
  const context = { name, cpython, staticInterpreter };
  const before = dirSize(runtimeDir);
  removeMatching(context);
  log(
    `interpreter: ${(before.bytes / 1048576).toFixed(1)} MiB unpacked, ${(dirSize(runtimeDir).bytes / 1048576).toFixed(1)} MiB trimmed${staticInterpreter ? " (static binary: shared libpython removed)" : ""}`,
  );

  // 3. The closure, for the target's platform.
  const sitePackages = join(runtimeDir, dirs.sitePackages);
  mkdirSync(sitePackages, { recursive: true });
  const native = hostTarget(process.platform, process.arch, existsSync("/etc/alpine-release")) === name;
  const install = spawnSync(
    uv,
    installArgs(pins, name, lockFile, sitePackages, native ? pythonPath : undefined),
    { cwd: root, encoding: "utf8", env: { ...process.env, ...uvEnv(pins, name) } },
  );
  if (install.error) throw new RuntimeError(`could not run ${uv}: ${install.error.message}`);
  if (install.status !== 0) {
    throw (
      noWheelsError(name, install.stderr) ??
      new RuntimeError(`uv pip install for ${name} failed:\n${install.stderr}`)
    );
  }
  // uv writes console scripts for the build machine's interpreter: the extension runs `python -m opentide`.
  for (const scripts of ["bin", "Scripts"])
    rmSync(join(sitePackages, scripts), { recursive: true, force: true });
  removeMatching(context);

  const dists = installedDists(sitePackages);
  const want = new Map(lock.map((pkg) => [pkg.name, pkg]));
  const got = new Map(dists.map((dist) => [dist.name, dist]));
  const missing = [...want.keys()].filter((pkg) => got.get(pkg)?.version !== want.get(pkg)?.version);
  const extra = [...got.keys()].filter((pkg) => !want.has(pkg));
  if (missing.length > 0 || extra.length > 0) {
    throw new RuntimeError(
      `installed closure differs from ${lockPath(name)}: missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}`,
    );
  }
  if (!got.has("opentide")) throw new RuntimeError("opentide is not in the closure");

  // 4. BUILD-INFO, SBOM and notices.
  const info = buildInfo({
    pins,
    name,
    archiveSha256,
    lockSha256: sha256(Buffer.from(lockText)),
    staticInterpreter,
  });
  const extensionVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const wheels = await mapLimit(dists, 8, async (dist) => {
    const files = await pypiFiles(dist.name, dist.version);
    const wheel = pickWheel(files, dist.tags, want.get(dist.name)?.hashes ?? []);
    if (!wheel) throw new RuntimeError(`cannot tell which ${dist.name} ${dist.version} wheel was installed`);
    return { filename: wheel.filename, sha256: wheel.digests.sha256, url: wheel.url };
  });
  const sbomDists = dists.map((dist, index) => ({
    name: dist.name,
    version: dist.version,
    license: licenseOf(dist.meta),
    wheel: wheels[index],
  }));
  const cpythonLicense = [join(runtimeDir, dirs.stdlib, "LICENSE.txt"), join(runtimeDir, "LICENSE.txt")].find(
    existsSync,
  );
  const sections = [
    {
      title: `CPython ${cpython} (python-build-standalone ${pins.python.pythonBuildStandalone})`,
      license: "PSF-2.0",
      texts: cpythonLicense ? [{ file: "LICENSE.txt", text: readFileSync(cpythonLicense, "utf8") }] : [],
    },
    ...dists.map((dist, index) => ({
      title: `${dist.meta.get("name")?.[0] ?? dist.name} ${dist.version}`,
      license: licenseText(sbomDists[index]?.license ?? { name: "unknown" }),
      texts: licenseFiles(dist.meta, dist.files).map((file) => ({
        file,
        text: readFileSync(join(dist.dir, file), "utf8"),
      })),
    })),
  ];
  writeFileSync(join(runtimeDir, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(
    join(runtimeDir, "sbom.cdx.json"),
    `${JSON.stringify(cyclonedx({ info, dists: sbomDists, extensionVersion }), null, 2)}\n`,
  );
  writeFileSync(join(runtimeDir, "THIRD-PARTY-NOTICES.txt"), runtimeNotices(info, sections));
  const unlicensed = sections.filter((section) => section.texts.length === 0).map((section) => section.title);
  if (unlicensed.length > 0) log(`no licence file shipped by: ${unlicensed.join(", ")}`);

  const total = dirSize(runtimeDir);
  log(
    `${name}: opentide ${pins.opentide.version}, CPython ${cpython}, ${dists.length} distributions, ` +
      `${total.files} files, ${(total.bytes / 1048576).toFixed(1)} MiB in runtime/ (build ${info.buildId})`,
  );
}

main().catch((error) => {
  if (error instanceof RuntimeError) {
    console.error(`runtime:build: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
