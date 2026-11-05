#!/usr/bin/env node
// Packages a VSIX (SPEC §3 "Packages") and enforces the size gate.
//   node scripts/package.mjs --target <vscode-target>   per-platform: needs `npm run runtime:build -- --target <t>`
//   node scripts/package.mjs --universal                no runtime/
//   --pre-release is passed to vsce; it is on by itself for an odd minor version (SPEC §3).
// vsce runs `vscode:prepublish` (npm run build:production) first. The VSIX goes to
// dist-vsix/opentide-<target|universal>-<version>.vsix, with <name>.size.json next to it. A package over
// pins.json vsix.budgetBytes (or a budgetOverrideBytes for the pinned opentide) fails, printing its size
// and its five largest directories.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  budgetFor,
  buildInfoProblem,
  formatReport,
  isPreReleaseVersion,
  mib,
  OUT_DIR,
  PackageError,
  sizeReport,
  universalIgnore,
  vsixName,
  zipEntries,
} from "./package-lib.mjs";
import { RuntimeError, requireRuntimeTarget, runtimeOf } from "./runtime-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function main() {
  const target = option("--target");
  const universal = args.includes("--universal");
  if (Boolean(target) === universal) {
    throw new PackageError(
      "usage: npm run package -- --target <vscode-target> | --universal [--pre-release]",
    );
  }
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const vsceArgs = ["package", "--no-dependencies"];
  let scratch;
  if (target) {
    requireRuntimeTarget(pins, target);
    const infoPath = join(root, "runtime", "BUILD-INFO.json");
    if (!existsSync(infoPath)) {
      throw new PackageError(`runtime/ has no build: run npm run runtime:build -- --target ${target}`);
    }
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const problem = buildInfoProblem(info, {
      target,
      runtime: runtimeOf(pins, target),
      opentide: pins.opentide.version,
      cpython: pins.python.cpython,
    });
    if (problem) throw new PackageError(`${problem}: run npm run runtime:build -- --target ${target}`);
    vsceArgs.push("--target", target);
  } else {
    scratch = mkdtempSync(join(tmpdir(), "opentide-package-"));
    const ignore = join(scratch, ".vscodeignore");
    writeFileSync(ignore, universalIgnore(readFileSync(join(root, ".vscodeignore"), "utf8")));
    vsceArgs.push("--ignoreFile", ignore);
  }
  if (args.includes("--pre-release") || isPreReleaseVersion(pkg.version)) vsceArgs.push("--pre-release");

  const name = vsixName(target, pkg.version);
  mkdirSync(join(root, OUT_DIR), { recursive: true });
  const out = join(root, OUT_DIR, name);
  rmSync(out, { force: true });
  vsceArgs.push("-o", out);

  const vsce = createRequire(import.meta.url).resolve("@vscode/vsce/vsce");
  const run = spawnSync(process.execPath, [vsce, ...vsceArgs], { cwd: root, stdio: "inherit" });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (run.status !== 0) throw new PackageError(`vsce package failed (exit ${run.status})`);

  const buffer = readFileSync(out);
  const entries = zipEntries(buffer);
  if (target && !entries.some((entry) => entry.name === "extension/runtime/BUILD-INFO.json")) {
    throw new PackageError(`${name} has no runtime/: check .vscodeignore`);
  }
  if (!target && entries.some((entry) => entry.name.startsWith("extension/runtime/"))) {
    throw new PackageError(`${name} is universal but contains runtime/`);
  }
  const budget = budgetFor(pins);
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
  if (error instanceof PackageError || error instanceof RuntimeError) {
    console.error(`package: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
