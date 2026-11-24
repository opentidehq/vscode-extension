#!/usr/bin/env node
// Packages the VSIXs (SPEC §3 "Packages") and enforces the size gate. There is one universal package per
// store, for every platform and the web: the extension runs the user's own opentide and carries no runtime.
// The stores' packages differ only in package.json's `name`, `publisher` and `displayName` (package-lib
// STORES: the Marketplace's `opentide.opentide-vscode` / "opentide for VS Code", Open VSX's
// `opentidehq.opentide` / "opentide"); this checks that they do, entry by entry.
//   node scripts/package.mjs [--universal] [--pre-release]
//   --pre-release is passed to vsce; it is on by itself for an odd minor version (SPEC §3).
// vsce runs `vscode:prepublish` (npm run build:production) first, for each package. The VSIXs go to
// dist-vsix/opentide-<store>-<version>.vsix, each with <name>.size.json next to it. For the Marketplace
// package, package.json's name, publisher and display name are replaced while vsce runs, and put back afterwards. A package over
// pins.json vsix.budgetBytes (or a budgetOverrideBytes for the pinned opentide) fails, printing its size
// and its five largest directories.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetFor,
  committedManifestProblem,
  formatReport,
  isPreReleaseVersion,
  mib,
  OUT_DIR,
  PackageError,
  STORES,
  sizeReport,
  storeManifest,
  vsixName,
  zipEntries,
} from "./package-lib.mjs";
import { assetProblems } from "./release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

/** One store's package: package.json with the store's name, publisher and display name while vsce runs, then the size gate. */
function packageFor(store, { manifestPath, original, pkg, pins, vsceArgs }) {
  const name = vsixName(store.store, pkg.version);
  const out = join(root, OUT_DIR, name);
  rmSync(out, { force: true });
  const manifest = storeManifest(original, store);
  const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
  let run;
  try {
    if (manifest !== original) writeFileSync(manifestPath, manifest);
    run = spawnSync(process.execPath, [vsce, ...vsceArgs, "-o", out], { cwd: root, stdio: "inherit" });
  } finally {
    if (manifest !== original) writeFileSync(manifestPath, original);
  }
  if (run.status !== 0) throw new PackageError(`vsce package failed for ${name} (exit ${run.status})`);

  const buffer = readFileSync(out);
  const entries = zipEntries(buffer);
  if (entries.some((entry) => entry.name.startsWith("extension/runtime/"))) {
    throw new PackageError(`${name} contains runtime/: check .vscodeignore`);
  }
  const budget = budgetFor(pins);
  if (budget.staleOverride) {
    console.warn(
      `package: vsix.budgetOverrideBytes is for opentide ${budget.staleOverride.opentide}, the pin is ${pins.opentide.version}: remove it`,
    );
  }
  const report = sizeReport({
    file: name,
    target: undefined,
    bytes: statSync(out).size,
    entries,
    budget,
    targetBytes: pins.vsix.targetBytes,
    opentide: pins.opentide.version,
  });
  writeFileSync(join(root, OUT_DIR, `${name}.size.json`), `${JSON.stringify(report, null, 2)}\n`);
  for (const line of formatReport(report)) console.log(line);
  if (!report.withinBudget) {
    throw new PackageError(`${name} is ${mib(report.bytes)}, over the ${mib(report.budgetBytes)} budget`);
  }
  return { name, buffer };
}

function main() {
  if (option("--target")) {
    throw new PackageError(
      "there are no per-platform packages: the extension runs the user's own opentide. Use npm run package",
    );
  }
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const manifestPath = join(root, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const pkg = JSON.parse(original);
  const leftover = committedManifestProblem(pkg);
  if (leftover) throw new PackageError(leftover);

  const vsceArgs = ["package", "--no-dependencies"];
  if (args.includes("--pre-release") || isPreReleaseVersion(pkg.version)) vsceArgs.push("--pre-release");
  mkdirSync(join(root, OUT_DIR), { recursive: true });

  const built = STORES.map((store) => packageFor(store, { manifestPath, original, pkg, pins, vsceArgs }));
  const found = assetProblems(built, { version: pkg.version });
  if (found.length > 0) throw new PackageError(found.join("\n  "));
  console.log(
    `package: ${built.map((file) => file.name).join(", ")}: identical but for each store's name, publisher and display name`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof PackageError) {
    console.error(`package: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
