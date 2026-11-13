#!/usr/bin/env node
// Moves pins.json to an opentide release (docs/PACKAGING.md "Bumping opentide"):
//   node scripts/pins.mjs <version> [--engine-version <v>] [--sums <SHA256SUMS>]
// It reads each @opentide/opentide package's dist.integrity at <version> from the npm registry (the
// package and its six native packages), and, with --engine-version (the version the release's engine
// reports, its crate's), the release's SHA256SUMS (downloaded, or --sums) for the highlights zip, the
// opentide-wasm-web zip and THIRD-PARTY-LICENSES.html. It writes pins.json and drops opentide.source.
// Then: npm run grammars && npm run manifest, npm run build, npm test.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetUrl,
  enginePins,
  integrityFrom,
  npmPackages,
  PinsError,
  registryUrl,
  updatedPins,
} from "./pins-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

async function get(url, as) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new PinsError(`GET ${url}: HTTP ${response.status}`);
  return as === "json" ? response.json() : response.text();
}

async function main() {
  const version = args[0]?.startsWith("--") ? undefined : args[0];
  if (!version)
    throw new PinsError("usage: node scripts/pins.mjs <version> [--engine-version <v>] [--sums <file>]");
  const file = join(root, "pins.json");
  const pins = JSON.parse(readFileSync(file, "utf8"));
  const integrity = {};
  for (const name of npmPackages()) {
    integrity[name] = integrityFrom(await get(registryUrl(name, version), "json"), name, version);
  }
  const engineVersion = option("--engine-version");
  let engine;
  if (engineVersion) {
    const sumsFile = option("--sums");
    const sums = sumsFile
      ? readFileSync(sumsFile, "utf8")
      : await get(assetUrl(version, "SHA256SUMS"), "text");
    engine = enginePins(version, engineVersion, sums);
  }
  writeFileSync(file, `${JSON.stringify(updatedPins(pins, { version, integrity, engine }), null, 2)}\n`);
  console.log(
    `pins: @opentide/opentide ${version}${engine ? `, engine ${engineVersion} from v${version}` : ""}`,
  );
}

main().catch((error) => {
  if (error instanceof PinsError) {
    console.error(`pins: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
