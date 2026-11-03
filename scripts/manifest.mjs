#!/usr/bin/env node
// Generates package.json `contributes` and `activationEvents` from contrib/*.json.
//   node scripts/manifest.mjs          write package.json
//   node scripts/manifest.mjs --check  fail when package.json is stale
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyToPackage, ManifestError, mergeFragments, serialize } from "./manifest-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

function readFragments(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      try {
        return { name, fragment: JSON.parse(text) };
      } catch (error) {
        throw new ManifestError(`contrib/${name} is not valid JSON: ${error.message}`);
      }
    });
}

try {
  const pkgPath = join(root, "package.json");
  const current = readFileSync(pkgPath, "utf8");
  const merged = mergeFragments(readFragments(join(root, "contrib")));
  const next = serialize(applyToPackage(JSON.parse(current), merged));
  if (check) {
    if (next !== current) {
      console.error("package.json is stale: its contributes or activationEvents differ from contrib/*.json.");
      console.error("Run `npm run manifest` and commit package.json. Never hand-edit those two keys.");
      process.exit(1);
    }
    console.log("package.json is up to date with contrib/*.json");
  } else if (next !== current) {
    writeFileSync(pkgPath, next);
    console.log("package.json updated from contrib/*.json");
  } else {
    console.log("package.json already up to date");
  }
} catch (error) {
  if (error instanceof ManifestError) {
    console.error(`manifest: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
