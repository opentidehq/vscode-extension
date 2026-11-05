#!/usr/bin/env node
// Locks the bundled runtime's closure per target (SPEC §3 "Building the runtime"): runtime/requirements.in
// from pins.json, then runtime/locks/<target>.txt with `uv pip compile --python-platform <triple>
// --generate-hashes --only-binary :all:`. The locks are committed; an existing lock's versions are kept
// unless requirements.in no longer allows them.
//   node scripts/runtime-lock.mjs                    the runtime of every target in pins.json runtimeTargets,
//                                                    once each: an emulatedTargets target has no lock of
//                                                    its own (win32-arm64 bundles win32-x64's)
//   node scripts/runtime-lock.mjs --target <t>       one target, natively (also one outside runtimeTargets
//                                                    or an emulated one, to see whether its closure has
//                                                    wheels yet)
//   node scripts/runtime-lock.mjs --upgrade          re-resolve to the newest versions
//   node scripts/runtime-lock.mjs --check            fail when requirements.in or a lock is stale
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lf,
  lockArgs,
  lockPath,
  lockTargets,
  noWheelsError,
  parseLock,
  REQUIREMENTS_IN,
  RuntimeError,
  requirementsIn,
  runtimeOf,
  runtimeTargets,
  target,
  universalReason,
  uvEnv,
  uvVersion,
} from "./runtime-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const check = args.includes("--check");
const upgrade = args.includes("--upgrade");
const uv = process.env.UV ?? "uv";

function compile(pins, name, output) {
  const run = spawnSync(uv, [...lockArgs(pins, name, output), ...(upgrade ? ["--upgrade"] : [])], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...uvEnv(pins, name) },
  });
  if (run.error) throw new RuntimeError(`could not run ${uv}: ${run.error.message}`);
  if (run.status !== 0) {
    throw (
      noWheelsError(name, run.stderr) ?? new RuntimeError(`uv pip compile for ${name} failed:\n${run.stderr}`)
    );
  }
}

function main() {
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const only = option("--target");
  const names = only ? [only] : lockTargets(pins);
  for (const name of names) target(name);

  // The lock is uv's output: another uv may write it differently (CI installs pins.json uv.version).
  const want = pins.uv?.version;
  const version = spawnSync(uv, ["--version"], { encoding: "utf8" });
  const have = version.error ? undefined : uvVersion(version.stdout ?? "");
  if (want && have && have !== want) {
    console.warn(`runtime:lock: uv ${have} is not pins.json's uv ${want}; the locks may differ in format`);
  }

  const stale = [];
  const wantIn = requirementsIn(pins);
  const inPath = join(root, REQUIREMENTS_IN);
  const currentIn = existsSync(inPath) ? lf(readFileSync(inPath, "utf8")) : undefined;
  if (currentIn !== wantIn) {
    if (check) stale.push(REQUIREMENTS_IN);
    else {
      mkdirSync(dirname(inPath), { recursive: true });
      writeFileSync(inPath, wantIn);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), "opentide-lock-"));
  try {
    for (const name of names) {
      const file = join(root, lockPath(name));
      if (check) {
        if (!existsSync(file)) {
          stale.push(lockPath(name));
          continue;
        }
        // Compile against a copy of the committed lock: uv keeps its versions where it can, so the lock
        // is stale only when requirements.in or the target's platform no longer give the same closure.
        const out = join(scratch, `${name}.txt`);
        writeFileSync(out, lf(readFileSync(file, "utf8")));
        compile(pins, name, out);
        if (lf(readFileSync(out, "utf8")) !== lf(readFileSync(file, "utf8"))) stale.push(lockPath(name));
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      compile(pins, name, file);
      const count = parseLock(readFileSync(file, "utf8")).length;
      const note = !runtimeTargets(pins).includes(name)
        ? ` (not in runtimeTargets: ${universalReason(pins, name)}; it resolves now, so it can get a runtime)`
        : runtimeOf(pins, name) !== name
          ? ` (pins.json emulatedTargets gives it the ${runtimeOf(pins, name)} runtime; this lock is not used: ` +
            "check its versions match the other targets' before dropping the emulation)"
          : "";
      console.log(`${lockPath(name)}: ${count} packages${note}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`runtime locks are stale: ${stale.join(", ")}`);
      console.error("Run `npm run runtime:lock` and commit the result.");
      process.exit(1);
    }
    console.log(`runtime locks match ${REQUIREMENTS_IN} (opentide ${pins.opentide.version})`);
  }
}

try {
  main();
} catch (error) {
  if (error instanceof RuntimeError) {
    console.error(`runtime:lock: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
