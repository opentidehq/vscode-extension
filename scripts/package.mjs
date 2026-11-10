#!/usr/bin/env node
// Packages the VSIX (SPEC §3 "Packages") and enforces the size gate. There is one package, for every
// platform and the web: the extension runs the user's own opentide and carries no runtime.
//   node scripts/package.mjs [--universal] [--pre-release]
//   --pre-release is passed to vsce; it is on by itself for an odd minor version (SPEC §3).
// vsce runs `vscode:prepublish` (npm run build:production) first. The VSIX goes to
// dist-vsix/opentide-<target|universal>-<version>.vsix, with <name>.size.json next to it. A package over
// pins.json vsix.budgetBytes (or a budgetOverrideBytes for the pinned opentide) fails, printing its size
// and its five largest directories.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  budgetFor,
  formatReport,
  isPreReleaseVersion,
  mib,
  OUT_DIR,
  PackageError,
  sizeReport,
  vsixName,
  zipEntries,
} from "./package-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function main() {
  if (option("--target")) {
    throw new PackageError(
      "there are no per-platform packages: the extension runs the user's own opentide. Use npm run package",
    );
  }
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const vsceArgs = ["package", "--no-dependencies"];
  if (args.includes("--pre-release") || isPreReleaseVersion(pkg.version)) vsceArgs.push("--pre-release");

  const name = vsixName(undefined, pkg.version);
  mkdirSync(join(root, OUT_DIR), { recursive: true });
  const out = join(root, OUT_DIR, name);
  rmSync(out, { force: true });
  vsceArgs.push("-o", out);

  const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
  const run = spawnSync(process.execPath, [vsce, ...vsceArgs], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) throw new PackageError(`vsce package failed (exit ${run.status})`);

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
