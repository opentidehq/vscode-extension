// After `vsce publish`, check that the Visual Studio Marketplace lists every package of the release, and
// publish again the ones it does not. 0.1.0 was the extension's first publish: vsce reported all eight
// packages published, but the Marketplace kept only the first (alpine-arm64), so VS Code on every other
// platform said the extension was not available. A brand-new extension is validated asynchronously, and
// the later uploads in that window were lost without an error.
//
//   node tools/publish/marketplace.mjs <publisher.name> <version> <dir-of-vsix> [--pre-release]
//
// Dependency-free (Node 22 fetch); the publish job runs it from tools/publish's sparse checkout.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const UNIVERSAL = "universal";

/** One line on stdout (the job log). */
const say = (line) => process.stdout.write(`${line}\n`);

/**
 * The packages a release directory holds, from their file names (`opentide-<target>-<version>.vsix`,
 * `opentide-universal-<version>.vsix`): `target` is the Marketplace's targetPlatform, or "universal".
 */
export function expectedPackages(files, name, version) {
  const prefix = `${name}-`;
  const suffix = `-${version}.vsix`;
  return files
    .filter((file) => file.startsWith(prefix) && file.endsWith(suffix))
    .map((file) => ({ file, target: file.slice(prefix.length, -suffix.length) }))
    .filter(({ target }) => target.length > 0)
    .sort((a, b) => a.target.localeCompare(b.target));
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
  const [id, version, dir, ...rest] = process.argv.slice(2);
  if (!id || !version || !dir) {
    console.error("usage: marketplace.mjs <publisher.name> <version> <dir> [--pre-release]");
    process.exit(2);
  }
  const name = id.split(".")[1] ?? id;
  const expected = expectedPackages(readdirSync(dir), name, version);
  if (expected.length === 0) {
    console.error(`marketplace: ${dir} has no ${name}-*-${version}.vsix`);
    process.exit(1);
  }
  const vsce = fileURLToPath(new URL("./node_modules/.bin/vsce", import.meta.url));
  const publish = ({ file, target }) => {
    const args = ["publish", "--oidc", "--skip-duplicate", ...rest, "--packagePath", join(dir, file)];
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
