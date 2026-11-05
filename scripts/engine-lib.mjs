// The opentide engine built for WebAssembly: language-server's `opentide-wasm-web-v<version>.zip`, pinned in
// pins.json `engine` by URL and SHA-256 (the zip's line in that release's SHA256SUMS). scripts/build.mjs
// unpacks it into .cache/, bundles its wasm-bindgen glue into the engine worker and copies the module and
// its licences into dist/engine/. Pure helpers, plus the cached download.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { GrammarError, readZip, verifySha256 } from "./grammars-lib.mjs";

/** The glue (bundled into the worker) and the module (copied next to it). */
export const GLUE = "opentide_wasm.js";
export const WASM = "opentide_wasm_bg.wasm";

/** What dist/engine/ carries besides the worker: the module and every licence file of the zip. */
export function isShipped(name) {
  return (
    name === WASM ||
    name === "LICENSE" ||
    name === "NOTICE" ||
    name === THIRD_PARTY ||
    name.startsWith("licenses/")
  );
}

/** The release's licences of the Rust crates compiled into the module (a release asset of its own). */
export const THIRD_PARTY = "THIRD-PARTY-LICENSES.html";

/** The files the zip must have, and the ones it may: anything else is refused. */
export function checkEntries(names) {
  for (const required of [GLUE, WASM, "LICENSE", "NOTICE"]) {
    if (!names.includes(required)) throw new GrammarError(`the engine zip has no ${required}`);
  }
  const known = (name) =>
    (isShipped(name) && name !== THIRD_PARTY) ||
    name === GLUE ||
    /^opentide_wasm(_bg\.wasm)?\.d\.ts$/.test(name);
  const unknown = names.filter((name) => !known(name));
  if (unknown.length > 0)
    throw new GrammarError(`the engine zip has unexpected files: ${unknown.join(", ")}`);
}

/** `engine.json` in dist/engine/: what the runtime resolver reads to offer the tier. */
export function engineManifest(pin, wasm) {
  return {
    $comment: "Written by scripts/build.mjs from pins.json engine. Do not edit.",
    version: pin.version,
    module: WASM,
    zip: pin.url,
    zipSha256: pin.sha256,
    moduleSha256: createHash("sha256").update(wasm).digest("hex"),
    moduleBytes: wasm.length,
  };
}

/** `.cache/engine-v<version>/`: the unpacked zip, written once per pinned SHA-256. */
export function engineCacheDir(root, pin) {
  return join(root, ".cache", `engine-v${pin.version}-${pin.sha256.slice(0, 12)}`);
}

/**
 * Unpack the pinned zip into the cache (downloading it into .cache/ the first time) and return the
 * folder. `zipPath` uses a local zip instead; it is checked against the pin all the same.
 */
export async function prepareEngine(root, pin, { zipPath, licensesPath, fetchImpl = fetch } = {}) {
  if (!pin?.url || !pin.sha256 || !pin.version || !pin.thirdPartyLicenses?.sha256)
    throw new GrammarError("pins.json has no engine (url, sha256, version, thirdPartyLicenses)");
  const dir = engineCacheDir(root, pin);
  const marker = join(dir, ".complete");
  if (!zipPath && !licensesPath && existsSync(marker) && readFileSync(marker, "utf8") === pin.sha256)
    return dir;
  const download = async (url, name, local) => {
    if (local) return readFileSync(local);
    const cached = join(root, ".cache", name);
    if (existsSync(cached)) return readFileSync(cached);
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok) throw new GrammarError(`GET ${url}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, data);
    return data;
  };
  const zipName = `opentide-wasm-web-v${pin.version}.zip`;
  const zip = await download(pin.url, zipName, zipPath);
  verifySha256(zip, pin.sha256, zipName);
  const licensesName = `THIRD-PARTY-LICENSES-v${pin.version}.html`;
  const licenses = await download(pin.thirdPartyLicenses.url, licensesName, licensesPath);
  verifySha256(licenses, pin.thirdPartyLicenses.sha256, licensesName);
  const files = readZip(zip);
  checkEntries([...files.keys()]);
  for (const [name, data] of files) {
    const to = join(dir, name);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
  writeFileSync(join(dir, THIRD_PARTY), licenses);
  writeFileSync(marker, pin.sha256);
  return dir;
}

/** The files to copy into `out` (dist/engine): [source, destination], the module and its licences. */
export function shippedFiles(dir, out) {
  const pairs = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name);
      const rel = relative(dir, file).split("\\").join("/");
      if (statSync(file).isDirectory()) walk(file);
      else if (isShipped(rel)) pairs.push([file, join(out, ...rel.split("/"))]);
    }
  };
  walk(dir);
  return pairs;
}
