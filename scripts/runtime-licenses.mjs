#!/usr/bin/env node
// Records the native libraries linked into each target's CPython (OpenSSL, zlib, libffi, …) and their
// licence texts, for the runtime's THIRD-PARTY-NOTICES and SBOM. `install_only_stripped` leaves those
// out; the same release's `full` archive has them (python/PYTHON.json, python/licenses/). The archive
// is streamed (SHA-256 checked against SHA256SUMS, zstd, tar) and only those files are kept, in
// runtime-licenses/<target>.json, which runtime:build reads and checks against pins.json.
//   node scripts/runtime-licenses.mjs [--target <t>]   every runtimeTargets target by default
//   node scripts/runtime-licenses.mjs --check           each target's file is there and matches the pins
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createZstdDecompress } from "node:zlib";
import {
  checkNativeLicenses,
  fullArchive,
  nativeComponents,
  nativeLicensesPath,
  parseSha256Sums,
  RuntimeError,
  runtimeTargets,
  sha256SumsUrl,
} from "./runtime-lib.mjs";
import { TarReader } from "./tar-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const log = (message) => console.log(`runtime:licenses: ${message}`);

const read = (file) => {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    return undefined;
  }
};

async function record(pins, name, sums) {
  const full = fullArchive(pins, name, sums);
  log(`${name}: ${full.archive}`);
  const response = await fetch(full.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new RuntimeError(`GET ${full.url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const tar = new TarReader(
    (path) => path === "python/PYTHON.json" || /^python\/licenses\/[^/]+$/.test(path),
  );
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createZstdDecompress(),
    tar,
  );
  const digest = hash.digest("hex");
  if (digest !== full.sha256)
    throw new RuntimeError(`${full.archive}: SHA-256 is ${digest}, expected ${full.sha256}`);
  const pythonJson = tar.files.get("python/PYTHON.json");
  if (!pythonJson) throw new RuntimeError(`${full.archive} has no python/PYTHON.json`);
  const components = nativeComponents(JSON.parse(pythonJson.toString("utf8")));
  const texts = {};
  for (const component of components) {
    const body = tar.files.get(`python/licenses/${component.file}`);
    // PYTHON.json may name a file the archive does not carry (zlib-ng on Linux): recorded as null, and
    // the notices say so.
    if (!body) log(`${name}: ${full.archive} has no python/licenses/${component.file}`);
    texts[component.file] = body ? body.toString("utf8").replace(/\r\n/g, "\n") : null;
  }
  const out = {
    pythonBuildStandalone: pins.python.pythonBuildStandalone,
    cpython: pins.python.cpython,
    archive: full.archive,
    sha256: full.sha256,
    components,
    texts,
  };
  checkNativeLicenses(pins, name, out);
  writeFileSync(join(root, nativeLicensesPath(name)), `${JSON.stringify(out, null, 2)}\n`);
  log(`${name}: ${components.map((c) => c.name).join(", ")}`);
}

async function main() {
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const targets = option("--target") ? [option("--target")] : runtimeTargets(pins);
  if (args.includes("--check")) {
    for (const name of targets) checkNativeLicenses(pins, name, read(nativeLicensesPath(name)));
    log(`${targets.length} targets match pins.json`);
    return;
  }
  const response = await fetch(sha256SumsUrl(pins), { redirect: "follow" });
  if (!response.ok) throw new RuntimeError(`GET ${sha256SumsUrl(pins)}: HTTP ${response.status}`);
  const sums = parseSha256Sums(await response.text());
  mkdirSync(join(root, "runtime-licenses"), { recursive: true });
  for (const name of targets) await record(pins, name, sums);
}

main().catch((error) => {
  console.error(
    `runtime:licenses: ${error instanceof RuntimeError ? error.message : (error?.stack ?? error)}`,
  );
  process.exit(1);
});
