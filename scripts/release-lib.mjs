// Pure helpers for scripts/release.mjs: the version CHANGELOG.md releases, its notes, the build matrix,
// the release assets and their SHA256SUMS. No process exits and no writes; release.mjs does the IO.
import { createHash } from "node:crypto";
import { readZip } from "./grammars-lib.mjs";
import { PACKAGE, TARGETS } from "./opentide-lib.mjs";

/** The tree does not say what to release, or the assets are not what it says. */
export class ReleaseError extends Error {}

export const REPOSITORY = "https://github.com/opentidehq/vscode-extension";
export const EXTENSION_ID = "opentidehq.opentide";
export const SUMS = "SHA256SUMS";

/** `## [0.2.0] - 2026-11-20` (a hyphen, en dash or em dash); `## [Unreleased]` does not match. */
const RELEASE_HEADING = /^##\s+\[(\d+\.\d+\.\d+)\]\s+[-–—]\s+(\d{4}-\d{2}-\d{2})\s*$/;
const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/i;
const SECTION_HEADING = /^##\s/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S/;

/** Every `## ` section of a changelog: `{ heading, version?, date?, body }`, in file order. */
export function sections(changelog) {
  const out = [];
  let current;
  for (const line of changelog.replace(/\r\n/g, "\n").split("\n")) {
    if (SECTION_HEADING.test(line)) {
      const release = RELEASE_HEADING.exec(line);
      current = { heading: line, version: release?.[1], date: release?.[2], lines: [] };
      out.push(current);
    } else if (current && !LINK_DEFINITION.test(line)) {
      current.lines.push(line);
    }
  }
  return out.map(({ lines, ...rest }) => ({ ...rest, body: lines.join("\n").trim() }));
}

/** The newest released version: the first dated `## [x.y.z] - YYYY-MM-DD` heading. */
export function releasedVersion(changelog) {
  const release = sections(changelog).find((section) => section.version);
  if (!release) {
    throw new ReleaseError(
      "CHANGELOG.md has no released section (## [x.y.z] - YYYY-MM-DD): move [Unreleased] into one first",
    );
  }
  return release.version;
}

/**
 * The entries `## [Unreleased]` still holds: every line that is not blank, a `###` heading or an HTML
 * comment. An empty `### Added` left behind is not an entry.
 */
export function unreleasedEntries(changelog) {
  const unreleased = sections(changelog).find((section) => UNRELEASED_HEADING.test(section.heading));
  if (!unreleased) return [];
  return unreleased.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** Stable releases use even minor versions and pre-releases odd ones (SPEC §3). */
export function isPreRelease(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new ReleaseError(`${version} is not a release version (x.y.z)`);
  return Number(match[2]) % 2 === 1;
}

/**
 * What keeps `tag` from being released from this tree; empty when nothing does. Reads CHANGELOG.md and
 * package.json's version; whether the tag already exists is the workflow's check (it needs git).
 */
export function problems({ changelog, packageVersion, tag }) {
  const found = [];
  let version;
  try {
    version = releasedVersion(changelog);
  } catch (error) {
    return [error.message];
  }
  if (tag !== undefined && tag !== `v${version}`) {
    found.push(`the tag ${tag} is not CHANGELOG.md's newest version, v${version}`);
  }
  if (packageVersion !== version) {
    found.push(
      `package.json's version is ${packageVersion}, CHANGELOG.md's newest is ${version}: the notes PR bumps both`,
    );
  }
  const pending = unreleasedEntries(changelog);
  if (pending.length > 0) {
    found.push(
      `## [Unreleased] still holds ${pending.length} line(s), starting "${pending[0]}": move them into [${version}] or release them next time`,
    );
  }
  const latest = sections(changelog).filter((section) => section.version);
  const body = latest[0]?.body ?? "";
  if (!body) found.push(`CHANGELOG.md's [${version}] section is empty`);
  if (latest[1] && compareVersions(latest[1].version, version) >= 0) {
    found.push(`[${version}] is not newer than the section below it, [${latest[1].version}]`);
  }
  return found;
}

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|/;

/**
 * Unwrap hard-wrapped Markdown for a GitHub Release body, which renders each newline as a line break:
 * a paragraph becomes one line and a list item, nested ones included, one line each. Headings, tables,
 * fenced code and blank lines stay as they are.
 */
export function unwrap(markdown) {
  const out = [];
  let inFence = false;
  let joinable = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      joinable = false;
      continue;
    }
    if (inFence || line.trim() === "" || line.startsWith("#") || TABLE_ROW.test(line)) {
      out.push(line);
      joinable = false;
      continue;
    }
    if (LIST_ITEM.test(line) || !joinable) {
      out.push(line.replace(/\s+$/, ""));
      joinable = true;
      continue;
    }
    out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
  }
  return out.join("\n");
}

/** Relative Markdown links (`[x](docs/A.md)`) point at the tag's tree, as they would in the repository. */
export function absoluteLinks(markdown, tag) {
  return markdown.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, target) => {
    return `](${REPOSITORY}/blob/${tag}/${target.replace(/^\.\//, "")})`;
  });
}

/**
 * The GitHub Release body for `version`: its CHANGELOG.md section (the opening paragraph and its lists),
 * unwrapped, then how to install and verify it.
 */
/**
 * @param {{ attested?: boolean }} [options] `attested: false` (a private repository without
 *   attestations) leaves `gh attestation verify` out of Verify.
 */
export function releaseNotes(changelog, version, { attested = true } = {}) {
  const section = sections(changelog).find((candidate) => candidate.version === version);
  if (!section) throw new ReleaseError(`CHANGELOG.md has no section for ${version}`);
  const tag = `v${version}`;
  const pre = isPreRelease(version);
  const lines = [];
  if (pre) {
    lines.push(
      `> **Pre-release** (odd minor version). VS Code installs it when you choose **Switch to Pre-Release Version** on the extension; stable releases use even minor versions.`,
      "",
    );
  }
  lines.push(absoluteLinks(unwrap(section.body), tag), "");
  lines.push(
    "### Install",
    "",
    `- **VS Code:** [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}), or \`code --install-extension ${EXTENSION_ID}${pre ? " --pre-release" : ""}\`.`,
    `- **Cursor, Windsurf, VSCodium and other editors:** [Open VSX](https://open-vsx.org/extension/opentidehq/opentide).`,
    `- **Offline or a private gallery:** download the package for your platform below (\`opentide-<platform>-${version}.vsix\`, else \`opentide-universal-${version}.vsix\`) and run \`code --install-extension <file>\`.`,
    "- **opentide itself:** the platform packages carry it (`@opentide/opentide`, the Rust core), so nothing else is needed, Python included. The universal package (Alpine, other platforms) runs the workspace's opentide, `opentide.path`, or `npm install -g @opentide/opentide`; without one it gives the editor features only.",
    "",
    "### Verify",
    "",
    "```bash",
    `sha256sum --check --ignore-missing ${SUMS}`,
    ...(attested
      ? [`gh attestation verify opentide-universal-${version}.vsix --repo opentidehq/vscode-extension`]
      : []),
    "```",
    "",
  );
  return lines.join("\n");
}

/** A VSIX's identity, read from its `extension.vsixmanifest`. */
export function vsixIdentity(buffer) {
  const manifest = readZip(buffer).get("extension.vsixmanifest");
  if (!manifest) throw new ReleaseError("no extension.vsixmanifest: not a VSIX");
  const xml = manifest.toString("utf8");
  const identity = /<Identity\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(identity)?.[1];
  return {
    id: `${attribute("Publisher")}.${attribute("Id")}`,
    version: attribute("Version"),
    target: attribute("TargetPlatform") ?? "universal",
    preRelease: /<Property\s+Id="Microsoft\.VisualStudio\.Code\.PreRelease"\s+Value="true"/.test(xml),
  };
}

/**
 * What is wrong with a release's VSIX files (`[{ name, buffer }]`): each is this extension at
 * `version`, with the pre-release flag the version's minor gives, and together they are one universal
 * package and either no platform package (while @opentide/opentide is not pinned on npm) or one for each
 * of the six targets that carry it. Empty when they are right.
 */
export function assetProblems(files, { version }) {
  const found = [];
  const preRelease = isPreRelease(version);
  const byTarget = new Map();
  for (const { name, buffer } of files) {
    let identity;
    try {
      identity = vsixIdentity(buffer);
    } catch (error) {
      found.push(`${name}: ${error.message}`);
      continue;
    }
    if (identity.id !== EXTENSION_ID) found.push(`${name} is ${identity.id}, not ${EXTENSION_ID}`);
    if (identity.version !== version) found.push(`${name} is version ${identity.version}, not ${version}`);
    if (identity.preRelease !== preRelease) {
      found.push(
        `${name} is ${identity.preRelease ? "" : "not "}packaged as a pre-release, but ${version} is ${preRelease ? "a pre-release (odd minor)" : "stable (even minor)"}`,
      );
    }
    if (byTarget.has(identity.target)) {
      found.push(`${name} and ${byTarget.get(identity.target)} are both ${identity.target}`);
    }
    byTarget.set(identity.target, name);
  }
  if (!byTarget.has("universal")) found.push("no universal package");
  const platforms = [...byTarget.keys()].filter((target) => target !== "universal");
  for (const target of platforms) {
    if (!Object.hasOwn(TARGETS, target))
      found.push(`${byTarget.get(target)} is ${target}: no @opentide/opentide native package for it`);
  }
  if (platforms.length > 0) {
    const missing = Object.keys(TARGETS).filter((target) => !byTarget.has(target));
    if (missing.length > 0) found.push(`platform packages missing for ${missing.join(", ")}`);
  }
  return found;
}

/**
 * Whether pins.json pins @opentide/opentide on npm for every target (the package and its six native
 * packages' integrity): only then does a release build the platform packages.
 */
export function platformsPinned(pins) {
  const integrity = pins.opentide?.npm?.integrity ?? {};
  return [PACKAGE, ...Object.values(TARGETS).map((platform) => `${PACKAGE}-${platform}`)].every(
    (name) => typeof integrity[name] === "string",
  );
}

/** The platform packages' build matrix: each target with the runner that builds and smoke-tests it natively. */
export const PLATFORM_RUNNERS = {
  "linux-x64": "ubuntu-latest",
  "linux-arm64": "ubuntu-24.04-arm",
  "darwin-x64": "macos-15-intel",
  "darwin-arm64": "macos-latest",
  "win32-x64": "windows-latest",
  "win32-arm64": "windows-11-arm",
};

/**
 * `sha256sum` lines for `files` (`[{ name, buffer }]`), sorted by name. A name with whitespace or a
 * backslash, which `sha256sum` escapes, is an error rather than an asset the sums would leave out.
 */
export function sha256sums(files) {
  const lines = [];
  for (const { name, buffer } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (name === SUMS) continue;
    if (/[\s\\]/.test(name))
      throw new ReleaseError(`${JSON.stringify(name)}: sha256sum cannot read back this name`);
    lines.push(`${createHash("sha256").update(buffer).digest("hex")}  ${name}\n`);
  }
  if (lines.length === 0) throw new ReleaseError("no assets to sum");
  return lines.join("");
}

const MB = 1024 * 1024;
const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/**
 * A job-summary table of package sizes from the `<name>.size.json` reports (`[{ name, report }]`,
 * report `{ bytes, largest: [{ path, bytes }] }`, as package-lib's `sizeReport` writes it) against
 * the budget and target in pins.json.
 */
export function sizeSummary(reports, { budgetBytes, targetBytes }) {
  const lines = [
    "### Package sizes",
    "",
    `Universal: budget ${mb(budgetBytes)}, target ${mb(targetBytes)}. Platform packages carry their own (pins.json vsix.platform).`,
    "",
    "| Package | Size | | Largest directories |",
    "|---------|-----:|-|---------------------|",
  ];
  for (const { name, report } of [...reports].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const budget = report.budgetBytes ?? budgetBytes;
    const target = report.targetBytes ?? targetBytes;
    const verdict = report.bytes > budget ? "over budget" : report.bytes > target ? "over target" : "ok";
    const dirs = (report.largest ?? [])
      .slice(0, 5)
      .map((dir) => `\`${dir.path}\` ${mb(dir.bytes)}`)
      .join(", ");
    lines.push(`| \`${name}\` | ${mb(report.bytes)} | ${verdict} | ${dirs} |`);
  }
  if (reports.length === 0) lines.push("| (no size reports) | | | |");
  return `${lines.join("\n")}\n`;
}
