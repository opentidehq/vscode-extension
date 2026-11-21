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

/** The pin, refused when it is incomplete or still a placeholder. */
export function checkPin(pin) {
  if (!pin?.url || !pin.version || typeof pin.sha256 !== "string")
    throw new GrammarError("pins.json has no wasi (url, sha256, version)");
  if (isPlaceholder(pin.sha256))
    throw new GrammarError(
      `pins.json wasi.sha256 is a placeholder: opentide ${pin.version} is not released yet. Once it is, set it to ` +
        `the ${WASI_ASSET} line of its SHA256SUMS (see docs/PACKAGING.md), or build with ${MODULE_ENV}=<module> ` +
        "for a module made from opentide's source (the test build, .github/workflows/test-vsix.yml)",
    );
}

/** `dist/wasi/wasi.json`: what the runtime resolver reads to offer the tier. */
export function wasiManifest(pin, wasm, { local = false, version } = {}) {
  return {
    $comment: "Written by scripts/build.mjs from pins.json wasi. Do not edit.",
    version: version ?? (local ? `${pin.version}+local` : pin.version),
    module: WASI_MODULE,
    launcher: WASI_LAUNCHER,
    source: local ? "local" : "release",
    ...(local ? {} : { url: pin.url, sha256: pin.sha256 }),
    moduleSha256: createHash("sha256").update(wasm).digest("hex"),
    moduleBytes: wasm.length,
  };
}

/** `.cache/<asset>-v<version>-<sha12>.wasm`: the verified download, one per pinned digest. */
export function wasiCachePath(root, pin) {
  return join(root, ".cache", `opentide-wasm32-wasip1-v${pin.version}-${pin.sha256.slice(0, 12)}.wasm`);
}

/**
 * The module to ship. `modulePath` (or `OPENTIDE_WASI_MODULE`) names a local file: it must be a module,
 * and the manifest records it as local. Otherwise the pinned asset, downloaded once into `.cache/` and
 * checked against the pin's SHA-256 (a cached file is checked again).
 */
export async function prepareWasi(
  root,
  pin,
  { modulePath = process.env[MODULE_ENV], version = process.env[VERSION_ENV], fetchImpl = fetch } = {},
) {
  if (modulePath) {
    const wasm = readFileSync(modulePath);
    checkModule(wasm, modulePath);
    return { wasm, manifest: wasiManifest(pin ?? {}, wasm, { local: true, version }) };
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
  return { wasm, manifest: wasiManifest(pin, wasm) };
}
