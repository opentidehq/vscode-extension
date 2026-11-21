// The WASI module: opentide's CLI compiled to wasm32-wasip1, an asset of an opentide release pinned in
// pins.json `wasi` by URL and SHA-256 (the module's line in that release's SHA256SUMS). Pure helpers, plus
// the cached download; scripts/wasi.mjs is the command line and scripts/build.mjs copies the module into
// dist/wasi/ with wasi.json (version and checksum, which the runtime resolver reads) and the launcher.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GrammarError, verifySha256 } from "./grammars-lib.mjs";

/** The release asset's name, and the module's name in dist/wasi/. */
export const WASI_ASSET = "opentide-wasm32-wasip1.wasm";
export const WASI_MODULE = "opentide.wasm";
/** The `node:wasi` launcher next to it (src/core/wasi/launcher.cjs): MCP, terminals and tasks run through it. */
export const WASI_LAUNCHER = "launcher.cjs";

/**
 * The module's licence set, assets of the same opentide release: the Rust crates the CLI module links
 * (cargo-about with wasm32-wasip1), the wasi-libc texts, and the project's own LICENSE and NOTICE. They ship in
 * dist/wasi/ beside the module, pinned with it (pins.json `wasi.licences`): not the engine's copies, which belong
 * to another build.
 */
export const WASI_LICENCES = ["THIRD-PARTY-LICENSES.html", "WASI-LIBC-LICENSES.txt", "LICENSE", "NOTICE"];

/** Set this to a folder holding those four files, for a module made from opentide's source. */
export const LICENCES_ENV = "OPENTIDE_WASI_LICENCES";

/** Set this to build with a module made from opentide's source instead of the pinned release asset. */
export const MODULE_ENV = "OPENTIDE_WASI_MODULE";
/** The version a locally built module is recorded as (default: the pin's, with `+local`). */
export const VERSION_ENV = "OPENTIDE_WASI_VERSION";

/** Whether pins.json still holds the marked stand-in for a digest that does not exist yet. */
export function isPlaceholder(sha256) {
  return typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256);
}

/** A WebAssembly module starts with `\0asm` and a version (1). */
export function checkModule(wasm, what = WASI_ASSET) {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d || wasm.readUInt32LE(4) !== 1)
    throw new GrammarError(`${what} is not a WebAssembly module`);
}

/** The names of the pinned licence files whose digest is still a placeholder, or that are not pinned at all. */
export function unpinnedLicences(pin) {
  return WASI_LICENCES.filter((name) => {
    const entry = pin?.licences?.[name];
    return !entry?.url || isPlaceholder(entry.sha256);
  });
}

/** The pin, refused when it is incomplete or still a placeholder. */
export function checkPin(pin) {
  if (!pin?.url || !pin.version || typeof pin.sha256 !== "string")
    throw new GrammarError("pins.json has no wasi (url, sha256, version)");
  const unpinned = unpinnedLicences(pin);
  if (isPlaceholder(pin.sha256) || unpinned.length > 0)
    throw new GrammarError(
      `pins.json wasi has a placeholder digest (${[...(isPlaceholder(pin.sha256) ? ["sha256"] : []), ...unpinned.map((name) => `licences.${name}`)].join(", ")}): ` +
        `opentide ${pin.version} is not released yet. Once it is, set each to its line of the release's SHA256SUMS ` +
        `(${WASI_ASSET}, ${WASI_LICENCES.join(", ")}; see docs/PACKAGING.md), or build with ${MODULE_ENV}=<module> ` +
        `and ${LICENCES_ENV}=<folder> for a module made from opentide's source (the test build, .github/workflows/test-vsix.yml)`,
    );
}

/** `dist/wasi/wasi.json`: what the runtime resolver reads to offer the tier. */
export function wasiManifest(pin, wasm, { local = false, version, licences = WASI_LICENCES } = {}) {
  return {
    $comment: "Written by scripts/build.mjs from pins.json wasi. Do not edit.",
    version: version ?? (local ? `${pin.version}+local` : pin.version),
    module: WASI_MODULE,
    launcher: WASI_LAUNCHER,
    source: local ? "local" : "release",
    ...(local ? {} : { url: pin.url, sha256: pin.sha256 }),
    licences: [...licences],
    moduleSha256: createHash("sha256").update(wasm).digest("hex"),
    moduleBytes: wasm.length,
  };
}

/** `.cache/<asset>-v<version>-<sha12>.wasm`: the verified download, one per pinned digest. */
export function wasiCachePath(root, pin) {
  return join(root, ".cache", `opentide-wasm32-wasip1-v${pin.version}-${pin.sha256.slice(0, 12)}.wasm`);
}

/** `.cache/opentide-wasi-licences-v<version>-<sha12>/<name>`: a verified licence file, one folder per pinned digest. */
export function wasiLicenceCachePath(root, pin, name) {
  return join(
    root,
    ".cache",
    `opentide-wasi-licences-v${pin.version}-${pin.licences[name].sha256.slice(0, 12)}`,
    name,
  );
}

/** The licence files of a folder (a module made from source): all four must be there and not empty. */
export function localLicences(dir) {
  if (!dir)
    throw new GrammarError(
      `a module made from source ships the licences of its build too: set ${LICENCES_ENV}=<a folder holding ` +
        `${WASI_LICENCES.join(", ")}> (opentide's release workflow makes them; the test build, ` +
        ".github/workflows/test-vsix.yml, does too)",
    );
  const out = new Map();
  for (const name of WASI_LICENCES) {
    const file = join(dir, name);
    if (!existsSync(file)) throw new GrammarError(`${LICENCES_ENV}: ${file} does not exist`);
    const text = readFileSync(file);
    if (text.length === 0) throw new GrammarError(`${LICENCES_ENV}: ${file} is empty`);
    out.set(name, text);
  }
  return out;
}

/** The pinned licence files, downloaded once into `.cache/` and checked against the pin (a cached file again). */
async function releaseLicences(root, pin, fetchImpl) {
  const out = new Map();
  for (const name of WASI_LICENCES) {
    const entry = pin.licences[name];
    const cached = wasiLicenceCachePath(root, pin, name);
    let text;
    if (existsSync(cached)) {
      text = readFileSync(cached);
    } else {
      const response = await fetchImpl(entry.url, { redirect: "follow" });
      if (!response.ok) throw new GrammarError(`GET ${entry.url}: HTTP ${response.status}`);
      text = Buffer.from(await response.arrayBuffer());
      verifySha256(text, entry.sha256, name);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, text);
    }
    verifySha256(text, entry.sha256, name);
    out.set(name, text);
  }
  return out;
}

/**
 * The module to ship, and its licence set. `modulePath` (or `OPENTIDE_WASI_MODULE`) names a local file: it must
 * be a module, and the manifest records it as local; its licences come from `licencesDir` (or
 * `OPENTIDE_WASI_LICENCES`). Otherwise the pinned asset and licence files, downloaded once into `.cache/` and
 * checked against the pin's SHA-256 (a cached file is checked again).
 */
export async function prepareWasi(
  root,
  pin,
  {
    modulePath = process.env[MODULE_ENV],
    version = process.env[VERSION_ENV],
    licencesDir = process.env[LICENCES_ENV],
    fetchImpl = fetch,
  } = {},
) {
  if (modulePath) {
    const wasm = readFileSync(modulePath);
    checkModule(wasm, modulePath);
    const licences = localLicences(licencesDir);
    return { wasm, licences, manifest: wasiManifest(pin ?? {}, wasm, { local: true, version }) };
  }
  checkPin(pin);
  const cached = wasiCachePath(root, pin);
  let wasm;
  if (existsSync(cached)) {
    wasm = readFileSync(cached);
  } else {
    const response = await fetchImpl(pin.url, { redirect: "follow" });
    if (!response.ok) throw new GrammarError(`GET ${pin.url}: HTTP ${response.status}`);
    wasm = Buffer.from(await response.arrayBuffer());
    // Written only once verified: a bad download never sits in the cache.
    verifySha256(wasm, pin.sha256, WASI_ASSET);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, wasm);
  }
  verifySha256(wasm, pin.sha256, WASI_ASSET);
  checkModule(wasm);
  const licences = await releaseLicences(root, pin, fetchImpl);
  return { wasm, licences, manifest: wasiManifest(pin, wasm) };
}
