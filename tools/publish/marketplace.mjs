// After `vsce publish`, check that the Visual Studio Marketplace lists the release's package, and publish it
// again if it does not. 0.1.0 was the extension's first publish: vsce reported all eight packages published,
// but the Marketplace kept only the first (alpine-arm64), so VS Code on every other platform said the
// extension was not available. A brand-new extension is validated asynchronously, and the later uploads in
// that window were lost without an error. The Marketplace package is the extension `opentide.opentide`,
// one universal VSIX (docs/RELEASING.md); the Open VSX one is not published here.
//
//   node tools/publish/marketplace.mjs <publisher.name> <version> <file.vsix> [--pre-release]
//
// Dependency-free (Node 22 fetch); the publish job runs it from tools/publish's sparse checkout.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const UNIVERSAL = "universal";

/** One line on stdout (the job log). */
const say = (line) => process.stdout.write(`${line}\n`);

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
 * Returns the targets still missing (empty when the release is complete).
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
  const [id, version, file, ...rest] = process.argv.slice(2);
  if (!id || !version || !file?.endsWith(".vsix")) {
    console.error("usage: marketplace.mjs <publisher.name> <version> <file.vsix> [--pre-release]");
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`marketplace: ${file} does not exist`);
    process.exit(1);
  }
  const dir = dirname(file);
  const expected = expectedPackages(file);
  const vsce = fileURLToPath(new URL("./node_modules/.bin/vsce", import.meta.url));
  const publish = (pkg) => {
    const { target } = pkg;
    const args = ["publish", "--oidc", "--skip-duplicate", ...rest, "--packagePath", join(dir, pkg.file)];
    say(`marketplace: vsce ${args.join(" ")} (${target})`);
    const done = spawnSync(vsce, args, { stdio: "inherit" });
    if (done.status !== 0) say(`marketplace: vsce exited ${done.status} for ${target}`);
  };
  ensurePublished({ id, version, expected, publish }).then((missing) => {
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
