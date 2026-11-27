// The antivirus gate (.github/workflows/av-gate.yml, scripts/av-gate.mjs, scripts/av-lib.mjs): no native
// executable at any depth, the recorded size, and the scanners wired in before any store.
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { nativeExecutables, nativeFormat, sizeGrowthProblem } from "../../scripts/av-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** A stored (uncompressed) zip of `entries` (name -> Buffer), enough for zipEntries and zipRead. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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

/** A ustar archive of `files` (name -> Buffer). */
function tar(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
function pe() {
  const bytes = Buffer.alloc(0x100);
  bytes.write("MZ", 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32BE(0x50450000, 0x80);
  return bytes;
}
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
// A Java class file: the fat Mach-O magic, with its version where the fat header has its architecture count.
const JAVA_CLASS = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]);

describe("AV gate: no native executables", () => {
  it("recognises PE, ELF and Mach-O, and passes WebAssembly, text and a Java class", () => {
    assert.equal(nativeFormat(pe()), "PE");
    assert.equal(nativeFormat(ELF), "ELF");
    assert.equal(nativeFormat(MACHO), "Mach-O");
    assert.equal(nativeFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])), "Mach-O (universal)");
    assert.equal(nativeFormat(WASM), undefined);
    assert.equal(
      nativeFormat(Buffer.from("MZ is how this text starts, with no PE header".padEnd(200))),
      undefined,
    );
    assert.equal(nativeFormat(JAVA_CLASS), undefined);
  });

  it("finds them at any depth: a VSIX, a zip in it, a gzipped tar in that", () => {
    const inner = gzipSync(tar({ "bin/tool": MACHO, README: Buffer.from("text") }));
    const vsix = zip({
      "extension/dist/opentide.wasm": WASM,
      "extension/dist/extension.js": Buffer.from("module.exports = {};"),
      "extension/native/a.node": ELF,
      "extension/vendor/tools.zip": zip({ "win/tool.exe": pe(), "deeper.tgz": inner }),
    });
    assert.deepEqual(nativeExecutables(vsix, "p.vsix"), [
      { path: "p.vsix!/extension/native/a.node", format: "ELF" },
      { path: "p.vsix!/extension/vendor/tools.zip!/win/tool.exe", format: "PE" },
      { path: "p.vsix!/extension/vendor/tools.zip!/deeper.tgz!/(gunzip)!/bin/tool", format: "Mach-O" },
    ]);
  });

  it("passes a package of WebAssembly, JavaScript and data", () => {
    const vsix = zip({ "extension/a.wasm": WASM, "extension/b.json": Buffer.from("{}") });
    assert.deepEqual(nativeExecutables(vsix, "p.vsix"), []);
  });

  it("fails an archive it cannot read: what is not read is not passed", () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    const found = nativeExecutables(zip({ "extension/x.zip": broken }), "p.vsix");
    assert.equal(found.length, 1);
    assert.match(found[0].format, /an archive that cannot be read/);
    assert.match(
      nativeExecutables(Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2]), "x.gz")[0].format,
      /cannot be read/,
    );
  });
});

describe("AV gate: the size budget", () => {
  const vsix = { recordedBytes: 1000, growthLimit: 0.1 };
  it("allows up to 10 % over the recorded size, and names the growth beyond it", () => {
    assert.equal(sizeGrowthProblem("p.vsix", 1100, vsix), undefined);
    assert.equal(sizeGrowthProblem("p.vsix", 900, vsix), undefined);
    assert.match(
      sizeGrowthProblem("p.vsix", 1101, vsix),
      /p\.vsix is 1101 bytes, 10\.1 % over the 1000 recorded/,
    );
    assert.match(sizeGrowthProblem("p.vsix", 1, {}), /no vsix\.recordedBytes/);
  });

  it("pins.json records a size and a 10 % limit, under the hard budget", () => {
    const pins = JSON.parse(read("pins.json")).vsix;
    assert.equal(pins.growthLimit, 0.1);
    assert.ok(pins.recordedBytes > 1024 * 1024 && pins.recordedBytes < pins.budgetBytes);
  });
});

describe("av-gate.mjs (the command line)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "av-gate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync(process.execPath, [join(root, "scripts", "av-gate.mjs"), ...args], { encoding: "utf8" });

  it("static passes clean packages and fails one with a nested executable, naming it", () => {
    mkdirSync(join(dir, "ok"));
    writeFileSync(join(dir, "ok", "a.vsix"), zip({ "extension/a.wasm": WASM }));
    const ok = run("static", join(dir, "ok"));
    assert.equal(ok.status, 0, ok.stderr);
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "b.vsix"), zip({ "extension/x.zip": zip({ "x.so": ELF }) }));
    const bad = run("static", join(dir, "bad"));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error title=AV gate::b\.vsix!\/extension\/x\.zip!\/x\.so: ELF/);
  });

  it("extract unpacks each package into its own folder", () => {
    writeFileSync(join(dir, "a.vsix"), zip({ "extension/package.json": Buffer.from("{}") }));
    const out = join(dir, "out");
    assert.equal(run("extract", dir, out).status, 0);
    assert.equal(readFileSync(join(out, "a.vsix", "extension", "package.json"), "utf8"), "{}");
  });
});

describe("AV gate: the workflows", () => {
  const gate = read(".github/workflows/av-gate.yml");
  const publish = read(".github/workflows/publish.yml");
  const ci = read(".github/workflows/ci.yml");

  it("publish.yml runs the gate on both packages before attest and the GitHub Release, so before either store", () => {
    assert.match(
      publish,
      /\n {2}av-gate:\n[\s\S]*?uses: \.\/\.github\/workflows\/av-gate\.yml\n {4}with:\n {6}artifact: vsix-universal\n/,
    );
    assert.match(publish, /\n {2}attest:\n[^\n]*\n {4}needs: \[prepare, universal, av-gate\]\n/);
    assert.match(
      publish,
      /\n {2}release:\n[^\n]*\n {4}needs: \[prepare, av-gate, attest\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.av-gate\.result == 'success' && needs\.attest\.result == 'success' \}\}\n/,
    );
    for (const job of ["publish-marketplace", "publish-openvsx"])
      assert.match(publish, new RegExp(`\\n {2}${job}:\\n[^\\n]*\\n {4}needs: \\[prepare, release\\]\\n`));
  });

  it("ci.yml runs the gate on every pull request's packages", () => {
    assert.match(
      ci,
      /\n {2}av-gate:\n[^\n]*\n {4}needs: package\n {4}uses: \.\/\.github\/workflows\/av-gate\.yml\n {4}with:\n {6}artifact: vsix\n/,
    );
    assert.match(gate, /workflow_call:/);
    assert.match(gate, /workflow_dispatch:/, "the dry path: package and scan, release nothing");
  });

  it("Defender: windows-latest runs scripts/av/defender-scan.ps1 on the .vsix files and the extracted packages", () => {
    const defender = gate.slice(gate.indexOf("\n  defender:"));
    assert.match(defender, /runs-on: windows-latest/);
    assert.match(defender, /node scripts\/av-gate\.mjs extract vsix extracted/);
    assert.match(
      defender,
      /pwsh -NoProfile -File scripts\/av\/defender-scan\.ps1 -Packages vsix -Extracted extracted/,
    );
  });

  describe("defender-scan.ps1 keeps opentide#1752's lessons, so a 'clean' means something", () => {
    const ps = read("scripts/av/defender-scan.ps1");
    it("removes the runner image's exclusions, fails if a path exclusion remains, and never sends samples", () => {
      assert.match(
        ps,
        /Format-List ExclusionPath, ExclusionExtension, ExclusionProcess, DisableRealtimeMonitoring/,
      );
      for (const kind of ["ExclusionPath", "ExclusionExtension", "ExclusionProcess"])
        assert.match(ps, new RegExp(`Remove-MpPreference -${kind} \\$pref\\.${kind}`));
      assert.match(ps, /if \(\$after\.ExclusionPath\) \{ Fail "path exclusions remain/);
      assert.match(ps, /-SubmitSamplesConsent 2/);
      assert.match(ps, /-DisableArchiveScanning \$false/);
    });

    it("updates the signatures and refuses old ones", () => {
      assert.match(ps, /-SignatureUpdate/);
      assert.match(ps, /TotalHours -gt 48/);
    });

    it("counts a scan only once the canary is detected, by the scan or by real-time protection", () => {
      assert.match(
        ps,
        /\$text = 'X5O[^']*\$' \+ 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H\+H\*'/,
        "two halves",
      );
      assert.match(ps, /'canary\.com'/);
      assert.match(ps, /elseif \(\$refused -or \$vanished\)/);
      assert.match(ps, /Fail "Defender is not scanning/);
    });

    it("reads each verdict from MpCmdRun's output: clean, detected with names, else unreadable", () => {
      assert.match(ps, /-Scan -ScanType 3 -File \$target -DisableRemediation/);
      assert.match(ps, /'found \(\\d\+\) threats\?'/);
      assert.match(ps, /'found no threats'/);
      assert.match(ps, /\^\\s\*Threat\\s\*:\\s\*\(\.\+\?\)/);
      assert.match(ps, /verdict = 'unreadable'/);
      assert.match(
        ps,
        /\$_\.Extension -in '\.wasm', '\.js', '\.cjs', '\.mjs'/,
        "each .wasm and JS file on its own",
      );
      assert.match(ps, /-Filter \*\.vsix/);
    });

    it("exits 2 itself: no Write-Error, which throws first under ErrorActionPreference Stop", () => {
      assert.match(ps, /\$ErrorActionPreference = 'Stop'/);
      const code = ps
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.doesNotMatch(code, /Write-Error/);
      assert.match(ps, /function Fail\(\[string\]\$message\) \{\n {2}Write-Host [^\n]*\n {2}exit 2\n\}/);
      assert.match(ps, /\nexit 0\n$/);
    });

    it("finds MpCmdRun under Program Files, else the newest under the Defender platform folder", () => {
      assert.match(ps, /Join-Path \$env:ProgramFiles 'Windows Defender\\MpCmdRun\.exe'/);
      assert.match(ps, /Microsoft\\Windows Defender\\Platform/);
    });
  });

  it("ClamAV: the latest signatures, archive scanning, canaries plain and zipped, limits that report rather than skip", () => {
    const clamav = gate.slice(gate.indexOf("\n  clamav:"), gate.indexOf("\n  defender:"));
    assert.match(clamav, /freshclam/);
    // The signatures' age is not a gate: CI scans with whatever ClamAV last published.
    assert.doesNotMatch(clamav, /age >|hours old/);
    assert.match(clamav, /eicar\.zip/);
    assert.match(clamav, /--scan-archive=yes --alert-exceeds-max=yes/);
    assert.match(clamav, /--file-list=/);
  });

  it("uploads nothing to an external scanner", () => {
    // Code only: the gate's header comment says it never uploads to VirusTotal.
    const code = (text) =>
      text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    for (const text of [gate, publish, ci])
      assert.doesNotMatch(
        code(text),
        /virustotal|metadefender|hybrid-analysis|curl |wget |Invoke-WebRequest/i,
      );
  });

  it("no file in the repository carries the EICAR string: the canaries are written at run time", () => {
    const signature = ["EICAR-STANDARD", "ANTIVIRUS-TEST-FILE"].join("-");
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const carrying = tracked.filter((file) => {
      try {
        const text = readFileSync(join(root, file), "latin1");
        return text.includes(`X5O!P%@AP[4\\PZX54(P^)7CC)7}$${signature}`) || text.includes(`$${signature}`);
      } catch {
        return false;
      }
    });
    assert.deepEqual(carrying, []);
  });
});
