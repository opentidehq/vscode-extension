import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { STORES, sizeReport, storeManifest, vsixName } from "../../scripts/package-lib.mjs";
import {
  absoluteLinks,
  assetProblems,
  isPreRelease,
  MARKETPLACE_ID,
  OPENVSX_ID,
  problems,
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
function vsix({
  version = "0.1.0",
  target,
  preRelease = true,
  publisher = "opentidehq",
  displayName = "opentide",
  id = "opentide",
  main = "./dist/extension.js",
}) {
  const platform = target ? ` TargetPlatform="${target}"` : "";
  const pre = preRelease ? `<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />` : "";
  return zip({
    "[Content_Types].xml": "<Types/>",
    "extension.vsixmanifest": `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${id}" Version="${version}" Publisher="${publisher}"${platform}/>
    <DisplayName>${displayName}</DisplayName>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.91.0" />
      ${pre}
    </Properties>
  </Metadata>
</PackageManifest>`,
    "extension/package.json": `{\n  "name": "${id}",\n  "displayName": ${JSON.stringify(displayName)},\n  "publisher": "${publisher}",\n  "main": "${main}"\n}\n`,
    "extension/dist/extension.js": "module.exports = {};\n",
  });
}

/** The two stores' packages of `version`, as `npm run package` names them. */
function storePackages(version, overrides = {}) {
  return STORES.map(({ store, publisher, name, displayName }) => ({
    name: vsixName(store, version),
    buffer: vsix({
      version,
      preRelease: isPreRelease(version),
      publisher,
      id: name,
      displayName,
      ...overrides[store],
    }),
  }));
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
    // A real digest for the WASI module is fine; the marked placeholder keeps the release from going out.
    const sha256 = "a".repeat(64);
    const licences = Object.fromEntries(
      [
        "THIRD-PARTY-LICENSES.html",
        "WASI-LIBC-LICENSES.txt",
        "LICENSE",
        "NOTICE",
        "THIRD-PARTY-DATA-LICENSES.txt",
      ].map((name) => [name, { url: `https://example.invalid/${name}`, sha256 }]),
    );
    assert.deepEqual(
      problems({
        changelog: CHANGELOG,
        packageVersion: "0.3.0",
        pins: { wasi: { version: "1.0.0-rc.3", sha256, licences } },
      }),
      [],
    );
    // The licence set is pinned too: a digest still a placeholder keeps the release from going out.
    const unpinned = problems({
      changelog: CHANGELOG,
      packageVersion: "0.3.0",
      pins: {
        wasi: {
          version: "1.0.0-rc.3",
          sha256,
          licences: { ...licences, NOTICE: { url: "u", sha256: "PLACEHOLDER-x" } },
        },
      },
    });
    assert.equal(unpinned.length, 1);
    assert.match(unpinned[0], /wasi\.licences has no digest for NOTICE/);
    const placeholder = problems({
      changelog: CHANGELOG,
      packageVersion: "0.3.0",
      pins: { wasi: { version: "1.0.0-rc.3", sha256: "PLACEHOLDER-set-it", licences } },
    });
    assert.equal(placeholder.length, 1);
    assert.match(placeholder[0], /wasi\.sha256 is a placeholder.*v1\.0\.0-rc\.3/);
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
    assert.match(notes, /code --install-extension opentide\.opentide-vscode --pre-release/);
    assert.match(notes, /marketplace\.visualstudio\.com\/items\?itemName=opentide\.opentide-vscode\)/);
    assert.match(notes, /open-vsx\.org\/extension\/opentidehq\/opentide\) \(`opentidehq\.opentide`\)/);
    for (const file of ["opentide-marketplace-0.3.0.vsix", "opentide-openvsx-0.3.0.vsix"]) {
      assert.ok(notes.includes(`download \``) && notes.includes(`\`${file}\``), file);
      assert.ok(notes.includes(`gh attestation verify ${file} --repo opentidehq/vscode-extension`), file);
    }
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
    assert.match(notes, /`code --install-extension opentide\.opentide-vscode`/);
  });

  it("fails for a version the changelog does not have", () => {
    assert.throws(() => releaseNotes(CHANGELOG, "9.9.9"), /no section for 9\.9\.9/);
  });
});

describe("release: assets", () => {
  it("has an id per store: the Marketplace's opentide.opentide-vscode, Open VSX's opentidehq.opentide", () => {
    // 0.3.1 and 0.3.2 were refused on the Marketplace: "The extension 'opentide' already exists".
    assert.equal(MARKETPLACE_ID, "opentide.opentide-vscode");
    assert.equal(OPENVSX_ID, "opentidehq.opentide");
    assert.deepEqual(
      STORES.map(({ store, publisher, name }) => [store, publisher, name, vsixName(store, "0.3.3")]),
      [
        ["marketplace", "opentide", "opentide-vscode", "opentide-marketplace-0.3.3.vsix"],
        ["openvsx", "opentidehq", "opentide", "opentide-openvsx-0.3.3.vsix"],
      ],
    );
    const [marketplace, openvsx] = storePackages("0.3.3");
    assert.equal(vsixIdentity(marketplace.buffer).id, "opentide.opentide-vscode");
    assert.equal(vsixIdentity(openvsx.buffer).id, "opentidehq.opentide");
  });

  it("refuses a Marketplace package still named opentide (0.3.2's), and an Open VSX one renamed", () => {
    const found = assetProblems(
      storePackages("0.3.3", { marketplace: { id: "opentide" }, openvsx: { id: "opentide-vscode" } }),
      { version: "0.3.3" },
    );
    assert.deepEqual(found, [
      "opentide-marketplace-0.3.3.vsix is opentide.opentide, not opentide.opentide-vscode (the Visual Studio Marketplace package)",
      "opentide-openvsx-0.3.3.vsix is opentidehq.opentide-vscode, not opentidehq.opentide (the Open VSX package)",
    ]);
  });

  it("reads a VSIX's identity", () => {
    assert.deepEqual(vsixIdentity(vsix({ target: "linux-x64" })), {
      id: "opentidehq.opentide",
      version: "0.1.0",
      target: "linux-x64",
      preRelease: true,
      displayName: "opentide",
    });
    assert.equal(vsixIdentity(vsix({ preRelease: false })).target, "universal");
    assert.throws(() => vsixIdentity(zip({ "a.txt": "x" })), /not a VSIX/);
  });

  it("names each store's package: the Marketplace's 'opentide for VS Code', Open VSX's 'opentide'", () => {
    // 0.3.1's Marketplace publish was refused: the banned opentidehq extension still holds "opentide".
    assert.deepEqual(
      STORES.map(({ store, publisher, displayName }) => [store, publisher, displayName]),
      [
        ["marketplace", "opentide", "opentide for VS Code"],
        ["openvsx", "opentidehq", "opentide"],
      ],
    );
    const [marketplace, openvsx] = storePackages("0.3.3");
    assert.equal(vsixIdentity(marketplace.buffer).displayName, "opentide for VS Code");
    assert.equal(vsixIdentity(openvsx.buffer).displayName, "opentide");
  });

  it("refuses a Marketplace package named 'opentide' (0.3.1's), and an Open VSX one renamed", () => {
    const found = assetProblems(
      storePackages("0.3.1", {
        marketplace: { displayName: "opentide" },
        openvsx: { displayName: "opentide for VS Code" },
      }),
      { version: "0.3.1" },
    );
    assert.deepEqual(found, [
      'opentide-marketplace-0.3.1.vsix is named "opentide", not "opentide for VS Code" (the Visual Studio Marketplace package)',
      'opentide-openvsx-0.3.1.vsix is named "opentide for VS Code", not "opentide" (the Open VSX package)',
    ]);
  });

  it("accepts one package per store, the same but for the publisher and display name", () => {
    assert.deepEqual(assetProblems(storePackages("0.3.1"), { version: "0.3.1" }), []);
    assert.deepEqual(assetProblems(storePackages("0.4.0"), { version: "0.4.0" }), []);
  });

  it("refuses a store's package with the other store's publisher (0.3.0's one package was opentidehq only)", () => {
    const found = assetProblems(storePackages("0.3.1", { marketplace: { publisher: "opentidehq" } }), {
      version: "0.3.1",
    });
    assert.deepEqual(found, [
      "opentide-marketplace-0.3.1.vsix is opentidehq.opentide-vscode, not opentide.opentide-vscode (the Visual Studio Marketplace package)",
    ]);
  });

  it("refuses packages that differ beyond the name, publisher and display name", () => {
    const found = assetProblems(storePackages("0.3.1", { openvsx: { main: "./dist/other.js" } }), {
      version: "0.3.1",
    });
    assert.deepEqual(found, [
      "extension/package.json differs between opentide-marketplace-0.3.1.vsix and opentide-openvsx-0.3.1.vsix, beyond the name, publisher and display name",
    ]);
  });

  it("names what is missing, extra, of another target, or of the wrong version or channel", () => {
    const [marketplace] = storePackages("0.1.0");
    const found = assetProblems(
      [
        marketplace,
        { name: "opentide-universal-0.1.0.vsix", buffer: vsix({}) },
        {
          name: "opentide-openvsx-0.1.0.vsix",
          buffer: vsix({ target: "linux-x64", version: "0.0.9", preRelease: false }),
        },
      ],
      { version: "0.1.0" },
    );
    assert.deepEqual(found, [
      "opentide-universal-0.1.0.vsix is not a release package: they are opentide-marketplace-0.1.0.vsix and opentide-openvsx-0.1.0.vsix",
      "opentide-openvsx-0.1.0.vsix is version 0.0.9, not 0.1.0",
      "opentide-openvsx-0.1.0.vsix is not packaged as a pre-release, but 0.1.0 is a pre-release (odd minor)",
      "opentide-openvsx-0.1.0.vsix is linux-x64: the release has universal packages only",
    ]);
    assert.deepEqual(assetProblems([marketplace], { version: "0.1.0" }), ["no opentide-openvsx-0.1.0.vsix"]);
  });

  it("refuses a pre-release package for a stable version", () => {
    const found = assetProblems(storePackages("0.2.0", { openvsx: { preRelease: true } }), {
      version: "0.2.0",
    });
    assert.deepEqual(found, [
      "opentide-openvsx-0.2.0.vsix is packaged as a pre-release, but 0.2.0 is stable (even minor)",
    ]);
  });

  it("package.json's name, publisher and display name are replaced alone, keeping the text as it is", () => {
    const text =
      '{\n  "name": "opentide",\n  "displayName": "opentide",\n  "publisher": "opentidehq",\n  "x": {\n    "name": "keep",\n    "publisher": "keep",\n    "displayName": "keep"\n  }\n}\n';
    const [marketplace, openvsx] = STORES;
    assert.equal(
      storeManifest(text, marketplace),
      text
        .replace('"name": "opentide"', '"name": "opentide-vscode"')
        .replace('"opentidehq"', '"opentide"')
        .replace('"displayName": "opentide"', '"displayName": "opentide for VS Code"'),
    );
    assert.equal(storeManifest(text, openvsx), text);
    assert.throws(
      () => storeManifest('{\n  "name": "opentide",\n  "displayName": "opentide"\n}\n', marketplace),
      /0 top-level "publisher" lines/,
    );
    assert.throws(
      () => storeManifest('{\n  "name": "opentide",\n  "publisher": "opentidehq"\n}\n', marketplace),
      /0 top-level "displayName" lines/,
    );
    assert.throws(() => storeManifest(text, { ...marketplace, publisher: "Bad Id" }), /not a publisher id/);
    assert.throws(
      () => storeManifest(text, { ...marketplace, name: "Opentide VS" }),
      /not an extension name/,
    );
    assert.throws(
      () => storeManifest('{\n  "displayName": "opentide",\n  "publisher": "opentidehq"\n}\n', marketplace),
      /0 top-level "name" lines/,
    );
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
            largest: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `runtime/d${n}`, bytes: n * MB })),
          },
        },
        { name: "opentide-universal-0.1.0.vsix", report: { bytes: 2 * MB, largest: [] } },
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

  it("lists the largest directories of a report written by package-lib's sizeReport", () => {
    const MB = 1024 * 1024;
    const report = sizeReport({
      file: "opentide-linux-x64-0.1.0.vsix",
      target: "linux-x64",
      bytes: 80 * MB,
      entries: [
        { name: "extension/runtime/bin/python3", compressedSize: 3 * MB, size: 6 * MB },
        { name: "extension/dist/extension.js", compressedSize: 1 * MB, size: 2 * MB },
      ],
      budget: { bytes: 100 * MB },
      targetBytes: 70 * MB,
      opentide: "0.22.0",
    });
    // Round-trip through JSON, as release.mjs reads the <name>.size.json that package.mjs writes.
    const text = sizeSummary([{ name: report.file, report: JSON.parse(JSON.stringify(report)) }], {
      budgetBytes: 100 * MB,
      targetBytes: 70 * MB,
    });
    assert.match(
      text,
      /\| `opentide-linux-x64-0\.1\.0\.vsix` \| 80\.0 MB \| over target \| `extension\/runtime\/bin` 3\.0 MB, `extension\/dist` 1\.0 MB \|/,
    );
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
    writeFileSync(join(dir, "pins.json"), JSON.stringify({ vsix: { budgetBytes: 100, targetBytes: 70 } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the version, the channel and the notes", () => {
    assert.equal(run("version").stdout, "0.3.0\n");
    assert.equal(run("prerelease").stdout, "true\n");
    assert.equal(run("prerelease", "v0.2.0").stdout, "false\n");
    assert.match(run("notes").stdout, /The first pre-release on both stores/);
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
    for (const file of storePackages("0.3.0")) writeFileSync(join(assets, file.name), file.buffer);
    const checked = run("assets", assets);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(
      checked.stdout,
      /2 packages of 0\.3\.0: opentide-marketplace-0\.3\.0\.vsix, opentide-openvsx-0\.3\.0\.vsix/,
    );

    assert.equal(run("sums", assets).status, 0);
    const sums = readFileSync(join(assets, "SHA256SUMS"), "utf8");
    assert.deepEqual(
      sums
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("  ")[1]),
      ["opentide-marketplace-0.3.0.vsix", "opentide-openvsx-0.3.0.vsix"],
      "SHA256SUMS covers both stores' packages",
    );
    assert.equal(run("sums", assets).status, 0, "a second run replaces SHA256SUMS instead of summing it");
    assert.equal(readFileSync(join(assets, "SHA256SUMS"), "utf8"), sums);
    const check = spawnSync("sha256sum", ["--check", "--strict", "SHA256SUMS"], {
      cwd: assets,
      encoding: "utf8",
    });
    if (!check.error) assert.equal(check.status, 0, check.stderr);

    writeFileSync(join(assets, "opentide-universal-0.3.0.vsix"), vsix({ version: "0.3.0" }));
    const extra = run("assets", assets);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /error: opentide-universal-0\.3\.0\.vsix is not a release package/);
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
    assert.match(result.stderr, /version, check, prerelease, notes, assets, sums or sizes/);
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
