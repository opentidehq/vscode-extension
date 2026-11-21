#!/usr/bin/env node
// Downloads the WASI module pinned in pins.json `wasi` (opentide's CLI compiled to wasm32-wasip1, an asset of
// an opentide release), checks it against the pin's SHA-256 and leaves it in .cache/, where `npm run build`
// takes it from. The counterpart of scripts/grammars.mjs for the module.
//   node scripts/wasi.mjs                   download (cached in .cache/), verify
//   node scripts/wasi.mjs --module <file>   check a local module (a build from opentide's source) instead
//   node scripts/wasi.mjs --print-sha256    print the digest of what was fetched: for the pin, once the release
//                                           exists and its SHA256SUMS agrees
// A pin that is still a placeholder (opentide's release is not out) is refused with the steps to set it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./grammars-lib.mjs";
import { prepareWasi, WASI_ASSET, wasiCachePath } from "./wasi-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const modulePath = option("--module");
  if (args.includes("--print-sha256")) {
    const response = await fetch(pins.wasi.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${pins.wasi.url}: HTTP ${response.status}`);
    console.log(sha256(Buffer.from(await response.arrayBuffer())));
  } else {
    const { wasm, manifest } = await prepareWasi(root, pins.wasi, modulePath ? { modulePath } : {});
    const where = modulePath ?? wasiCachePath(root, pins.wasi);
    console.log(
      `${WASI_ASSET} ${manifest.version}: ${wasm.length} bytes, sha256 ${manifest.moduleSha256} (${where})`,
    );
  }
} catch (error) {
  console.error(`wasi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
