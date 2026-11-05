import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  ALPINE_IMAGE,
  absoluteLinks,
  assetProblems,
  buildMatrix,
  isPreRelease,
  problems,
  RUNNERS,
  releasedVersion,
  releaseNotes,
  sha256sums,
  sizeSummary,
  unreleasedEntries,
  unwrap,
  vsixIdentity,
} from "../../scripts/release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "release.mjs");

/** A minimal zip writer (deflate), enough for readZip. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A VSIX with the manifest `vsce package` writes (its Identity and PreRelease property). */
function vsix({ version = "0.1.0", target, preRelease = true, publisher = "opentidehq", id = "opentide" }) {
  const platform = target ? ` TargetPlatform="${target}"` : "";
  const pre = preRelease ? `<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />` : "";
  return zip({
    "[Content_Types].xml": "<Types/>",
    "extension.vsixmanifest": `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${id}" Version="${version}" Publisher="${publisher}"${platform}/>
    <DisplayName>opentide</DisplayName>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.91.0" />
      ${pre}
    </Properties>
  </Metadata>
</PackageManifest>`,
    "extension/package.json": "{}",
  });
}

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

## [0.3.0] - 2026-11-20

The first pre-release on both stores. It bundles opentide 0.21.0 and
checks Tide objects as you type.

### Added

- Languages for Tide YAML and the query
  languages, with [grammars](docs/SPEC.md#5-languages).
  - A nested item that
    wraps.
- Runtime resolution.

### Fixed

- A [bug](https://github.com/opentidehq/vscode-extension/issues/3).

\`\`\`bash
code --install-extension
  opentidehq.opentide
\`\`\`

## [0.2.0] - 2026-11-10

### Added

- Older.

[Unreleased]: https://github.com/opentidehq/vscode-extension/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/opentidehq/vscode-extension/releases/tag/v0.3.0
`;

describe("release: the version CHANGELOG.md releases", () => {
  it("is the first dated section, not [Unreleased]", () => {
    assert.equal(releasedVersion(CHANGELOG), "0.3.0");
    assert.equal(releasedVersion("## [Unreleased]\n\n## [1.2.3] — 2026-01-01\n\n- x\n"), "1.2.3");
  });

  it("fails without a dated section", () => {
    assert.throws(() => releasedVersion("## [Unreleased]\n\n- pending\n"), /no released section/);
    assert.throws(() => releasedVersion("## [0.1.0]\n\n- undated\n"), /no released section/);
  });

  it("counts entries under [Unreleased], ignoring empty subsection headings and comments", () => {
    assert.deepEqual(unreleasedEntries(CHANGELOG), []);
    assert.deepEqual(
      unreleasedEntries("## [Unreleased]\n\n### Added\n\n<!-- none yet -->\n\n## [0.1.0] - 2026-01-01\n"),
      [],
    );
    assert.deepEqual(
      unreleasedEntries("## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [0.1.0] - 2026-01-01\n"),
      ["- A fix."],
    );
  });

  it("odd minors are pre-releases and even minors stable", () => {
    assert.equal(isPreRelease("0.1.0"), true);
    assert.equal(isPreRelease("0.3.7"), true);
    assert.equal(isPreRelease("0.2.0"), false);
    assert.equal(isPreRelease("1.0.0"), false);
    assert.throws(() => isPreRelease("1.0.0-beta.1"), /not a release version/);
  });
});

describe("release: check", () => {
  it("passes when the notes PR moved [Unreleased] and bumped package.json", () => {
    assert.deepEqual(problems({ changelog: CHANGELOG, packageVersion: "0.3.0", tag: "v0.3.0" }), []);
    assert.deepEqual(problems({ changelog: CHANGELOG, packageVersion: "0.3.0" }), []);
  });

  it("refuses a package.json that was not bumped", () => {
    const found = problems({ changelog: CHANGELOG, packageVersion: "0.2.0", tag: "v0.3.0" });
    assert.equal(found.length, 1);
    assert.match(found[0], /package.json's version is 0.2.0/);
  });

  it("refuses a tag that is not the changelog's version", () => {
    assert.match(problems({ changelog: CHANGELOG, packageVersion: "0.3.0", tag: "v0.2.0" })[0], /v0.3.0/);
  });

  it("refuses entries left under [Unreleased]", () => {
    const pending = CHANGELOG.replace(
      "### Added\n\n## [0.3.0]",
      "### Added\n\n- Not released.\n\n## [0.3.0]",
    );
    const found = problems({ changelog: pending, packageVersion: "0.3.0", tag: "v0.3.0" });
    assert.equal(found.length, 1);
    assert.match(found[0], /Unreleased\] still holds 1 line\(s\), starting "- Not released."/);
  });

  it("refuses an empty section and a version older than the one below it", () => {
    const text = "## [Unreleased]\n\n## [0.1.0] - 2026-01-02\n\n## [0.2.0] - 2026-01-01\n\n- x\n";
    const found = problems({ changelog: text, packageVersion: "0.1.0" });
    assert.ok(found.some((line) => /\[0.1.0\] section is empty/.test(line)));
    assert.ok(found.some((line) => /not newer than the section below it, \[0.2.0\]/.test(line)));
  });

  it("reports a changelog with no release instead of throwing", () => {
    assert.match(
      problems({ changelog: "## [Unreleased]\n- x\n", packageVersion: "0.1.0" })[0],
      /no released/,
    );
  });
});

describe("release: notes", () => {
  it("unwraps paragraphs and list items, keeps nesting, headings and code", () => {
    const text = unwrap(
      "Para one\ncontinues.\n\n- item\n  wraps\n  - nested\n    wraps\n\n```\na\n  b\n```\n| a |\n| b |",
    );
    assert.equal(
      text,
      "Para one continues.\n\n- item wraps\n  - nested wraps\n\n```\na\n  b\n```\n| a |\n| b |",
    );
  });

  it("leaves attestation verify out of the notes of a release without attestations", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.0", { attested: false });
    assert.match(notes, /sha256sum --check --ignore-missing SHA256SUMS/);
    assert.doesNotMatch(notes, /gh attestation verify/);
  });

  it("points relative links at the tag and leaves absolute ones and anchors alone", () => {
    assert.equal(
      absoluteLinks("[a](docs/SPEC.md#x) [b](https://x.y/z) [c](#top) [d](./README.md)", "v0.3.0"),
      "[a](https://github.com/opentidehq/vscode-extension/blob/v0.3.0/docs/SPEC.md#x) [b](https://x.y/z) [c](#top) [d](https://github.com/opentidehq/vscode-extension/blob/v0.3.0/README.md)",
    );
  });

  it("is the version's opening paragraph and lists, then install and verify", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.0");
    assert.match(notes, /^> \*\*Pre-release\*\*/);
    assert.match(
      notes,
      /The first pre-release on both stores\. It bundles opentide 0\.21\.0 and checks Tide/,
    );
    assert.match(
      notes,
      /- Languages for Tide YAML and the query languages, with \[grammars\]\(https:\/\/github\.com\/opentidehq\/vscode-extension\/blob\/v0\.3\.0\/docs\/SPEC\.md#5-languages\)\./,
    );
    assert.match(notes, / {2}- A nested item that wraps\./);
    assert.match(
      notes,
      /code --install-extension\n {2}opentidehq\.opentide/,
      "fenced code is left as written",
    );
    assert.match(notes, /code --install-extension opentidehq\.opentide --pre-release/);
    assert.match(
      notes,
      /gh attestation verify opentide-<platform>-0\.3\.0\.vsix --repo opentidehq\/vscode-extension/,
    );
    assert.doesNotMatch(
      notes,
      /Older\.|\[Unreleased\]:|releases\/tag\/v0\.3\.0\n/,
      "no other section, no link definitions",
    );
  });

  it("has no pre-release banner for a stable version", () => {
    const notes = releaseNotes(CHANGELOG, "0.2.0");
    assert.doesNotMatch(notes, /Pre-release/);
    assert.match(notes, /^### Added\n\n- Older\./);
    assert.match(notes, /`code --install-extension opentidehq\.opentide`/);
  });

  it("fails for a version the changelog does not have", () => {
    assert.throws(() => releaseNotes(CHANGELOG, "9.9.9"), /no section for 9\.9\.9/);
  });
});

describe("release: build matrix", () => {
  it("maps each runtime target to its native runner, Alpine in a container", () => {
    assert.deepEqual(buildMatrix({ runtimeTargets: ["linux-x64", "alpine-arm64", "darwin-x64"] }), {
      include: [
        { target: "linux-x64", os: "ubuntu-latest", container: "" },
        { target: "alpine-arm64", os: "ubuntu-24.04-arm", container: ALPINE_IMAGE },
        { target: "darwin-x64", os: "macos-15-intel", container: "" },
      ],
    });
  });

  it("smoke-tests Alpine in a digest-pinned Alpine image", () => {
    assert.match(ALPINE_IMAGE, /^node:\d+-alpine@sha256:[0-9a-f]{64}$/);
  });

  it("covers the eight targets of SPEC §3", () => {
    assert.deepEqual(Object.keys(RUNNERS).sort(), [
      "alpine-arm64",
      "alpine-x64",
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
  });

  it("refuses a missing list, an unknown target and a duplicate", () => {
    assert.throws(() => buildMatrix({}), /no runtimeTargets/);
    assert.throws(() => buildMatrix({ runtimeTargets: ["linux-armhf"] }), /"linux-armhf" is not one of/);
    assert.throws(() => buildMatrix({ runtimeTargets: ["linux-x64", "linux-x64"] }), /twice/);
  });

  it("is empty when no target bundles a runtime", () => {
    assert.deepEqual(buildMatrix({ runtimeTargets: [] }), { include: [] });
  });
  it("the committed pins build win32-arm64 on the Windows on Arm runner, as every other target natively", () => {
    const committed = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    const matrix = buildMatrix(committed);
    assert.deepEqual(
      matrix.include.find((entry) => entry.target === "win32-arm64"),
      { target: "win32-arm64", os: "windows-11-arm", container: "" },
    );
    assert.equal(matrix.include.length, 8);
  });
});

describe("release: assets", () => {
  const files = (specs) => specs.map((spec, i) => ({ name: spec.name ?? `p${i}.vsix`, buffer: vsix(spec) }));

  it("reads a VSIX's identity", () => {
    assert.deepEqual(vsixIdentity(vsix({ target: "linux-x64" })), {
      id: "opentidehq.opentide",
      version: "0.1.0",
      target: "linux-x64",
      preRelease: true,
    });
    assert.equal(vsixIdentity(vsix({ preRelease: false })).target, "universal");
    assert.throws(() => vsixIdentity(zip({ "a.txt": "x" })), /not a VSIX/);
  });

  it("accepts the universal package plus one per runtime target", () => {
    const set = files([{}, { target: "linux-x64" }, { target: "win32-x64" }]);
    assert.deepEqual(assetProblems(set, { version: "0.1.0", targets: ["linux-x64", "win32-x64"] }), []);
  });

  it("names what is missing, extra, duplicated or of the wrong version or channel", () => {
    const set = files([
      { name: "a.vsix", target: "linux-x64" },
      { name: "b.vsix", target: "linux-x64" },
      { name: "c.vsix", target: "darwin-arm64" },
      { name: "d.vsix", target: "win32-x64", version: "0.0.9" },
      { name: "e.vsix", target: "alpine-x64", preRelease: false },
      { name: "f.vsix", target: "alpine-arm64", publisher: "someone" },
    ]);
    const found = assetProblems(set, {
      version: "0.1.0",
      targets: ["linux-x64", "win32-x64", "alpine-x64", "alpine-arm64"],
    });
    assert.deepEqual(found, [
      "b.vsix and a.vsix are both linux-x64",
      "d.vsix is version 0.0.9, not 0.1.0",
      "e.vsix is not packaged as a pre-release, but 0.1.0 is a pre-release (odd minor)",
      "f.vsix is someone.opentide, not opentidehq.opentide",
      "no universal package",
      "c.vsix is darwin-arm64, which pins.json runtimeTargets does not list",
    ]);
  });

  it("refuses a pre-release package for a stable version", () => {
    const found = assetProblems(files([{ version: "0.2.0" }]), { version: "0.2.0", targets: [] });
    assert.deepEqual(found, ["p0.vsix is packaged as a pre-release, but 0.2.0 is stable (even minor)"]);
  });
});

describe("release: SHA256SUMS", () => {
  it("writes sha256sum lines sorted by name, without itself", () => {
    const sums = sha256sums([
      { name: "b.vsix", buffer: Buffer.from("b") },
      { name: "SHA256SUMS", buffer: Buffer.from("old") },
      { name: "a.vsix", buffer: Buffer.from("a") },
    ]);
    assert.equal(
      sums,
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.vsix\n" +
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.vsix\n",
    );
  });

  it("refuses names sha256sum cannot read back, and an empty folder", () => {
    assert.throws(() => sha256sums([{ name: "a b.vsix", buffer: Buffer.from("") }]), /cannot read back/);
    assert.throws(() => sha256sums([]), /no assets/);
  });
});

describe("release: size summary", () => {
  it("tabulates each package against the budget and target, with its five largest directories", () => {
    const MB = 1024 * 1024;
    const text = sizeSummary(
      [
        {
          name: "opentide-linux-x64-0.1.0.vsix",
          report: {
            bytes: 80 * MB,
            largestDirs: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `runtime/d${n}`, bytes: n * MB })),
          },
        },
        { name: "opentide-universal-0.1.0.vsix", report: { bytes: 2 * MB, largestDirs: [] } },
        { name: "opentide-win32-x64-0.1.0.vsix", report: { bytes: 101 * MB } },
      ],
      { budgetBytes: 100 * MB, targetBytes: 70 * MB },
    );
    assert.match(text, /Budget 100\.0 MB, target 70\.0 MB\./);
    assert.match(
      text,
      /\| `opentide-linux-x64-0\.1\.0\.vsix` \| 80\.0 MB \| over target \| `runtime\/d1` 1\.0 MB, .*`runtime\/d5` 5\.0 MB \|/,
    );
    assert.doesNotMatch(text, /d6/);
    assert.match(text, /\| `opentide-universal-0\.1\.0\.vsix` \| 2\.0 MB \| ok \|/);
    assert.match(text, /\| `opentide-win32-x64-0\.1\.0\.vsix` \| 101\.0 MB \| over budget \|/);
  });
});

describe("release.mjs (the command line)", () => {
  let dir;
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, OPENTIDE_RELEASE_ROOT: dir },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-"));
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }));
    writeFileSync(
      join(dir, "pins.json"),
      JSON.stringify({ runtimeTargets: ["linux-x64"], vsix: { budgetBytes: 100, targetBytes: 70 } }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the version, the channel, the notes and the matrix", () => {
    assert.equal(run("version").stdout, "0.3.0\n");
    assert.equal(run("prerelease").stdout, "true\n");
    assert.equal(run("prerelease", "v0.2.0").stdout, "false\n");
    assert.match(run("notes").stdout, /The first pre-release on both stores/);
    assert.deepEqual(JSON.parse(run("matrix").stdout), {
      include: [{ target: "linux-x64", os: "ubuntu-latest", container: "" }],
    });
  });

  it("check exits 0 when ready and 1 with each problem otherwise", () => {
    const ok = run("check", "v0.3.0");
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /v0\.3\.0 is ready to release/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    const bad = run("check", "v0.3.0");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^error: package.json's version is 0\.1\.0/m);
  });

  it("version fails plainly when nothing is released yet", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n- pending\n");
    const result = run("version");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^error: CHANGELOG\.md has no released section/m);
  });

  it("assets checks a folder of packages, and sums writes SHA256SUMS that sha256sum reads back", () => {
    const assets = join(dir, "dist");
    mkdirSync(assets);
    writeFileSync(join(assets, "opentide-universal-0.3.0.vsix"), vsix({ version: "0.3.0" }));
    writeFileSync(
      join(assets, "opentide-linux-x64-0.3.0.vsix"),
      vsix({ version: "0.3.0", target: "linux-x64" }),
    );
    const checked = run("assets", assets);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /2 packages of 0\.3\.0/);

    assert.equal(run("sums", assets).status, 0);
    const sums = readFileSync(join(assets, "SHA256SUMS"), "utf8");
    assert.equal(sums.split("\n").filter(Boolean).length, 2);
    assert.equal(run("sums", assets).status, 0, "a second run replaces SHA256SUMS instead of summing it");
    assert.equal(readFileSync(join(assets, "SHA256SUMS"), "utf8"), sums);
    const check = spawnSync("sha256sum", ["--check", "--strict", "SHA256SUMS"], {
      cwd: assets,
      encoding: "utf8",
    });
    if (!check.error) assert.equal(check.status, 0, check.stderr);

    writeFileSync(join(dir, "pins.json"), JSON.stringify({ runtimeTargets: ["linux-x64", "win32-x64"] }));
    const missing = run("assets", assets);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /error: no win32-x64 package/);
  });

  it("assets and sums refuse a subfolder", () => {
    const assets = join(dir, "dist");
    mkdirSync(join(assets, "nested"), { recursive: true });
    const result = run("sums", assets);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a file; release assets are one flat folder/);
  });

  it("sizes renders the size reports", () => {
    const assets = join(dir, "dist");
    mkdirSync(assets);
    writeFileSync(join(assets, "opentide-linux-x64-0.3.0.vsix.size.json"), JSON.stringify({ bytes: 50 }));
    assert.match(run("sizes", assets).stdout, /\| `opentide-linux-x64-0\.3\.0\.vsix` \| 0\.0 MB \| ok \|/);
  });

  it("an unknown command exits 1 and lists the commands", () => {
    const result = run("publish");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version, check, prerelease, notes, matrix, assets, sums or sizes/);
  });
});

describe("publish.yml: attestations", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
  it("attests only a public repository, or a private one with ATTEST=true, and warns otherwise", () => {
    assert.match(
      workflow,
      /ATTEST: \$\{\{ github\.event\.repository\.visibility == 'public' \|\| vars\.ATTEST == 'true' \}\}/,
    );
    assert.match(
      workflow,
      /- name: Attest build provenance\n\s+id: attest\n\s+if: \$\{\{ env\.ATTEST == 'true' \}\}/,
    );
    assert.match(
      workflow,
      /if: \$\{\{ env\.ATTEST != 'true' \}\}[\s\S]*?::warning title=No build provenance::/,
    );
  });
  it("always publishes SHA256SUMS, and verifies attestations only when there are some", () => {
    assert.match(workflow, /- name: SHA256SUMS\n\s+run: node scripts\/release\.mjs sums release/);
    assert.match(workflow, /attested: \$\{\{ steps\.attest\.outcome == 'success' \}\}/);
    assert.match(workflow, /if \[\[ "\$\{ATTESTED\}" != "true" \]\]; then notes\+=\(--no-attestation\); fi/);
  });
});
