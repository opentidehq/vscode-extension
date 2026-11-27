// After `vsce publish`, check that the Visual Studio Marketplace lists the release's package, and publish it
// again if it does not. 0.1.0 was the extension's first publish: vsce reported all eight packages published,
// but the Marketplace kept only the first (alpine-arm64), so VS Code on every other platform said the
// extension was not available. A brand-new extension is validated asynchronously, and the later uploads in
// that window were lost without an error. The Marketplace package is the extension `opentide.opentide-vscode`,
// one universal VSIX (docs/RELEASING.md); the Open VSX one is not published here.
//
//   node tools/publish/marketplace.mjs <publisher.name> <version> <file.vsix>
//   node tools/publish/marketplace.mjs --check <publisher.name> <version> <file.vsix>
//       before `vsce publish`: the package is the Marketplace one of this release, at 0.3.3 or later
//
// Only the release's own version goes to the Marketplace: never an older one. 0.3.2 and earlier were built under
// the name `opentide`, which the Marketplace refused, and are never published or backfilled there.
//
// Dependency-free (Node 22 fetch); the publish job runs it from tools/publish's sparse checkout.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const UNIVERSAL = "universal";

/** vsce refused a publish: the job stops on it rather than polling and publishing again. */
export class PublishRefused extends Error {}

/** One line on stdout (the job log). */
const say = (line) => process.stdout.write(`${line}\n`);

/** The Marketplace's id of the extension (scripts/package-lib.mjs STORES, docs/RELEASING.md). */
export const MARKETPLACE_ID = "opentide.opentide-vscode";
/**
 * The first version of `opentide.opentide-vscode` on the Marketplace; nothing older is ever published there.
 * 0.3.1 and 0.3.2 were refused (the name `opentide` is taken) and never reached it.
 */
export const FIRST_MARKETPLACE_VERSION = "0.3.3";

const parts = (version) => version.split(".").map(Number);

/**
 * Why `file` must not be published to the Marketplace as `id` at `version`, or undefined: the id is the
 * Marketplace's, the version is a release version from FIRST_MARKETPLACE_VERSION on, and the file is that
 * version's Marketplace package (`opentide-marketplace-<version>.vsix`), not the Open VSX one or an older one.
 */
export function publishProblem(id, version, file) {
  if (id !== MARKETPLACE_ID) return `${id} is not the Marketplace's id, ${MARKETPLACE_ID}`;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) return `${version} is not a release version (x.y.z)`;
  const [a, b] = [parts(version), parts(FIRST_MARKETPLACE_VERSION)];
  const older = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (older < 0)
    return `${version} is older than ${FIRST_MARKETPLACE_VERSION}: only new versions go to the Marketplace publisher opentide, never a backfill`;
  const expected = `opentide-marketplace-${version}.vsix`;
  if (basename(file ?? "") !== expected)
    return `${file} is not ${expected}, the Marketplace package of ${version}`;
  return undefined;
}

/** The package `vsce publish` was given: one universal VSIX (the extension carries no runtime). */
export function expectedPackages(file) {
  return [{ file: basename(file), target: UNIVERSAL }];
}

/** The targets of `expected` the gallery's `versions` do not list at `version`. */
export function missingTargets(versions, version, expected) {
  const listed = new Set(
    versions.filter((entry) => entry.version === version).map((entry) => entry.targetPlatform ?? UNIVERSAL),
  );
  return expected.filter(({ target }) => !listed.has(target));
}

/** The gallery's versions of `publisher.name` (every target, every version). */
export async function galleryVersions(id, fetchImpl = fetch) {
  const response = await fetchImpl(GALLERY, {
    method: "POST",
    headers: { Accept: "application/json;api-version=3.0-preview.1", "Content-Type": "application/json" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 1 }),
  });
  if (!response.ok) throw new Error(`the Marketplace gallery answered ${response.status}`);
  const body = await response.json();
  return body?.results?.[0]?.extensions?.[0]?.versions ?? [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the gallery lists every expected package, republishing the missing ones between rounds.
 * Returns the targets still missing (empty when the release is complete). A `publish` that throws (vsce
 * refused) ends it at once with that error: a refusal is never retried.
 */
export async function ensurePublished({
  id,
  version,
  expected,
  publish,
  versions = (extensionId) => galleryVersions(extensionId),
  rounds = 3,
  polls = 10,
  intervalMs = 30000,
  log = say,
}) {
  let missing = expected;
  for (let round = 1; round <= rounds; round += 1) {
    for (let poll = 1; poll <= polls; poll += 1) {
      try {
        missing = missingTargets(await versions(id), version, expected);
      } catch (error) {
        log(`marketplace: ${error instanceof Error ? error.message : String(error)}; trying again`);
      }
      if (missing.length === 0) {
        log(`marketplace: ${id} ${version} lists all ${expected.length} packages`);
        return [];
      }
      if (poll < polls) await sleep(intervalMs);
    }
    if (round === rounds) break;
    log(
      `marketplace: round ${round}: not listed yet: ${missing.map((p) => p.target).join(", ")}; publishing them again`,
    );
    for (const pkg of missing) publish(pkg);
  }
  return missing;
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv[0] === "--check";
  const [id, version, file, ...rest] = checkOnly ? argv.slice(1) : argv;
  if (!id || !version || !file?.endsWith(".vsix") || rest.length > 0) {
    console.error("usage: marketplace.mjs [--check] <publisher.name> <version> <file.vsix>");
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`marketplace: ${file} does not exist`);
    process.exit(1);
  }
  const problem = publishProblem(id, version, file);
  if (problem) {
    console.error(`::error::marketplace: ${problem}`);
    process.exit(1);
  }
  if (checkOnly) {
    say(`marketplace: ${file} is ${id} ${version}: it may be published`);
    return;
  }
  const dir = dirname(file);
  const expected = expectedPackages(file);
  const vsce = fileURLToPath(new URL("./node_modules/.bin/vsce", import.meta.url));
  const publish = (pkg) => {
    const { target } = pkg;
    const args = ["publish", "--oidc", "--skip-duplicate", "--packagePath", join(dir, pkg.file)];
    say(`marketplace: vsce ${args.join(" ")} (${target})`);
    // vsce's own output, its refusal included, goes to the job log as it is. A refusal stops the job here: no
    // further rounds, which would bury it (0.3.1: "The extension 'opentide' already exists in the Marketplace").
    const done = spawnSync(vsce, args, { stdio: "inherit" });
    if (done.status !== 0)
      throw new PublishRefused(`vsce publish exited ${done.status} for ${target} (its error is above)`);
  };
  ensurePublished({ id, version, expected, publish })
    .catch((error) => {
      if (!(error instanceof PublishRefused)) throw error;
      console.error(
        `::error::marketplace: ${error.message}. Not retried: fix the cause, then Re-run failed jobs.`,
      );
      process.exit(1);
    })
    .then((missing) => {
      if (missing === undefined) return;
      if (missing.length > 0) {
        console.error(
          `::error::The Marketplace does not list ${id} ${version} for: ${missing.map((p) => p.target).join(", ")}. ` +
            "Check the publisher hub (https://marketplace.visualstudio.com/manage/publishers), then Re-run failed jobs.",
        );
        process.exit(1);
      }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
