#!/usr/bin/env node
// Release helpers for the extension, as language-server's scripts/release.py and opentide's
// scripts/build/release.py are for theirs. .github/workflows/publish.yml runs them.
//
//   node scripts/release.mjs version               the version CHANGELOG.md releases (newest dated section)
//   node scripts/release.mjs check [vX.Y.Z]        the notes PR merged: package.json agrees, [Unreleased] is empty
//   node scripts/release.mjs prerelease [X.Y.Z]    "true" for an odd minor, "false" for an even one
//   node scripts/release.mjs notes [X.Y.Z] [--no-attestation]
//                                                  the GitHub Release body, from the version's CHANGELOG.md section
//   node scripts/release.mjs matrix                the build matrix from pins.json runtimeTargets (JSON)
//   node scripts/release.mjs assets DIR [X.Y.Z]    DIR's VSIX files are this version: universal + each runtime target
//   node scripts/release.mjs sums DIR              write DIR/SHA256SUMS for every file in DIR
//   node scripts/release.mjs sizes DIR             a Markdown table of DIR/*.size.json (for $GITHUB_STEP_SUMMARY)
//
// X.Y.Z defaults to the version CHANGELOG.md releases.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetProblems,
  buildMatrix,
  isPreRelease,
  problems,
  ReleaseError,
  releasedVersion,
  releaseNotes,
  runtimeTargets,
  SUMS,
  sha256sums,
  sizeSummary,
} from "./release-lib.mjs";

const root = process.env.OPENTIDE_RELEASE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const changelog = () => read("CHANGELOG.md");
const pins = () => JSON.parse(read("pins.json"));
const versionArg = (arg) => (arg ? arg.replace(/^v/, "") : releasedVersion(changelog()));

/** The files directly in `dir`; a subdirectory is an error, since release assets are one flat folder. */
function flatFiles(dir, accept = () => true) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!statSync(full).isFile())
      throw new ReleaseError(`${full} is not a file; release assets are one flat folder`);
    if (accept(name)) files.push({ name, buffer: readFileSync(full) });
  }
  return files;
}

function fail(lines) {
  for (const line of lines) console.error(`error: ${line}`);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "version":
      console.log(releasedVersion(changelog()));
      break;
    case "check": {
      const tag = args[0];
      const found = problems({
        changelog: changelog(),
        packageVersion: JSON.parse(read("package.json")).version,
        tag,
      });
      if (found.length > 0) fail(found);
      console.log(`${tag ?? `v${releasedVersion(changelog())}`} is ready to release`);
      break;
    }
    case "prerelease":
      console.log(String(isPreRelease(versionArg(args[0]))));
      break;
    case "notes": {
      const attested = !args.includes("--no-attestation");
      const version = args.find((arg) => !arg.startsWith("--"));
      process.stdout.write(releaseNotes(changelog(), versionArg(version), { attested }));
      break;
    }
    case "matrix":
      console.log(JSON.stringify(buildMatrix(pins())));
      break;
    case "assets": {
      if (!args[0]) fail(["usage: release.mjs assets DIR [X.Y.Z]"]);
      const version = versionArg(args[1]);
      const vsix = flatFiles(args[0], (name) => name.endsWith(".vsix"));
      const found = assetProblems(vsix, { version, targets: runtimeTargets(pins()) });
      if (found.length > 0) fail(found);
      console.log(`${vsix.length} packages of ${version}: ${vsix.map((file) => file.name).join(", ")}`);
      break;
    }
    case "sums": {
      if (!args[0]) fail(["usage: release.mjs sums DIR"]);
      const target = join(args[0], SUMS);
      writeFileSync(target, sha256sums(flatFiles(args[0])));
      console.log(`wrote ${target}`);
      break;
    }
    case "sizes": {
      if (!args[0]) fail(["usage: release.mjs sizes DIR"]);
      const reports = readdirSync(args[0])
        .filter((name) => name.endsWith(".size.json"))
        .map((name) => ({
          name: name.replace(/\.size\.json$/, ""),
          report: JSON.parse(readFileSync(join(args[0], name), "utf8")),
        }));
      process.stdout.write(sizeSummary(reports, pins().vsix));
      break;
    }
    default:
      fail([
        `unknown command ${JSON.stringify(command ?? "")}: version, check, prerelease, notes, matrix, assets, sums or sizes`,
      ]);
  }
} catch (error) {
  if (error instanceof ReleaseError || error?.code === "ENOENT") fail([error.message]);
  throw error;
}
