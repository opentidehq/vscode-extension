#!/usr/bin/env node
// Packages a VSIX (SPEC §3 "Packages") and enforces the size gate.
//   node scripts/package.mjs [--universal] [--pre-release]   the universal VSIX: no native code, for every
//                                                             platform without a package of its own and the web
//   node scripts/package.mjs --target <target> [--pre-release]
//                                                             a platform VSIX carrying @opentide/opentide for
//                                                             <target> (linux-x64, linux-arm64, darwin-x64,
//                                                             darwin-arm64, win32-x64, win32-arm64) in dist/opentide
// The package comes from OPENTIDE_NPM (a folder of npm tarballs or a built bindings/node), else from the npm
// registry at pins.json opentide.version, checked against opentide.npm.integrity (scripts/opentide-lib.mjs).
// --pre-release is passed to vsce; it is on by itself for an odd minor version (SPEC §3).
// vsce runs `vscode:prepublish` (npm run build:production) first, with OPENTIDE_TARGET set. The VSIX goes to
// dist-vsix/opentide-<target|universal>-<version>.vsix, with <name>.size.json next to it. A package over
// pins.json vsix.budgetBytes (or a budgetOverrideBytes for the pinned opentide) fails, printing its size
// and its five largest directories.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addonName, napiPlatform, OpentideError } from "./opentide-lib.mjs";
import {
  budgetFor,
  formatReport,
  isPreReleaseVersion,
  mib,
  OUT_DIR,
  PackageError,
  sizeReport,
  targetBytesFor,
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
  const target = option("--target");
  if (target && args.includes("--universal"))
    throw new PackageError("--target and --universal exclude each other");
  let platform;
  try {
    platform = target ? napiPlatform(target) : undefined;
  } catch (error) {
    if (error instanceof OpentideError) throw new PackageError(error.message);
    throw error;
  }
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const vsceArgs = ["package", "--no-dependencies"];
  if (target) vsceArgs.push("--target", target);
  if (args.includes("--pre-release") || isPreReleaseVersion(pkg.version)) vsceArgs.push("--pre-release");

  const name = vsixName(target, pkg.version);
  mkdirSync(join(root, OUT_DIR), { recursive: true });
  const out = join(root, OUT_DIR, name);
  rmSync(out, { force: true });
  vsceArgs.push("-o", out);

  const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
  // build.mjs stages dist/opentide for the target, and none for the universal VSIX.
  const env = { ...process.env, OPENTIDE_TARGET: target ?? "universal" };
  const run = spawnSync(process.execPath, [vsce, ...vsceArgs], { cwd: root, stdio: "inherit", env });
  if (run.status !== 0) throw new PackageError(`vsce package failed (exit ${run.status})`);

  const buffer = readFileSync(out);
  const entries = zipEntries(buffer);
  if (entries.some((entry) => entry.name.startsWith("extension/runtime/"))) {
    throw new PackageError(`${name} contains runtime/: check .vscodeignore`);
  }
  const staged = entries.filter((entry) => entry.name.startsWith("extension/dist/opentide/"));
  if (!platform && staged.length > 0)
    throw new PackageError(`${name} contains dist/opentide/: the universal VSIX carries no native code`);
  if (platform) {
    for (const file of ["opentide.json", "cli.js", "index.js", "LICENSE", addonName(platform)]) {
      if (!staged.some((entry) => entry.name === `extension/dist/opentide/${file}`))
        throw new PackageError(`${name} has no dist/opentide/${file}`);
    }
    const others = staged.filter(
      (entry) => entry.name.endsWith(".node") && !entry.name.endsWith(addonName(platform)),
    );
    if (others.length > 0)
      throw new PackageError(`${name} carries another platform's addon: ${others[0].name}`);
  }
  const budget = budgetFor(pins, target);
  if (budget.staleOverride) {
    console.warn(
      `package: vsix.budgetOverrideBytes is for opentide ${budget.staleOverride.opentide}, the pin is ${pins.opentide.version}: remove it`,
    );
  }
  const report = sizeReport({
    file: name,
    target,
    bytes: statSync(out).size,
    entries,
    budget,
    targetBytes: targetBytesFor(pins, target),
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
