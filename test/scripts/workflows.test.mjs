import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/publish.yml"];

/** The jobs of a workflow, by name, as the text of each (two-space job keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n"));
  const out = new Map();
  const parts = body.split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/);
  for (const part of parts.slice(1)) out.set(/^ {2}([a-z][a-z0-9-]*):/.exec(part)?.[1], part);
  return out;
}

const firstIndex = (text, pattern) => {
  const match = pattern.exec(text);
  return match ? match.index : -1;
};

describe("workflows: the bundled runtime", () => {
  for (const file of WORKFLOWS) {
    for (const [name, job] of jobs(read(file))) {
      if (!/npm run (package|runtime:)/.test(job)) continue;
      it(`${file} ${name}: a per-target package is built after the runtime, and uv is installed first`, () => {
        const flagsTarget = /flags=\(--target /.test(job);
        const packages = [...job.matchAll(/npm run package -- [^\n]*/g)].filter(
          (match) => /--target/.test(match[0]) || (flagsTarget && /flags\[@\]/.test(match[0])),
        );
        const build = firstIndex(job, /npm run runtime:build -- --target/);
        for (const pkg of packages) {
          assert.ok(build >= 0 && build < pkg.index, `${name} packages a target without runtime:build first`);
        }
        const uv = firstIndex(job, /uses: astral-sh\/setup-uv@[0-9a-f]{40} # v/);
        for (const use of job.matchAll(/npm run runtime:(lock|build)/g)) {
          assert.ok(uv >= 0 && uv < use.index, `${name} runs runtime:${use[1]} before installing uv`);
        }
        if (uv >= 0) assert.match(job, /version: \$\{\{ env\.UV_VERSION \}\}/);
      });
    }
  }

  it("pins.json names the uv the workflows install", () => {
    assert.match(JSON.parse(read("pins.json")).uv.version, /^\d+\.\d+\.\d+$/);
  });
});

describe("publish.yml: the release job can be re-run", () => {
  const release = jobs(read(".github/workflows/publish.yml")).get("release") ?? "";
  it("finishes an existing Release on this run's commit instead of creating it again", () => {
    const view = firstIndex(release, /gh release view "\$\{TAG\}"/);
    const create = firstIndex(release, /gh release create "\$\{TAG\}"/);
    assert.ok(view >= 0 && view < create);
    assert.match(release, /if \[\[ "\$\{commit\}" != "\$\{GITHUB_SHA\}" \]\]/);
    assert.match(
      release,
      /gh release upload "\$\{TAG\}" release\/\* --repo "\$\{GITHUB_REPOSITORY\}" --clobber/,
    );
  });
});

describe("workflows: the publish jobs run locked tools only", () => {
  const publish = jobs(read(".github/workflows/publish.yml"));
  const tools = JSON.parse(read("tools/publish/package.json"));
  const lock = JSON.parse(read("tools/publish/package-lock.json"));

  for (const name of ["publish-marketplace", "publish-openvsx"]) {
    it(`${name}: no npx; vsce and ovsx from tools/publish's lockfile, installed without scripts`, () => {
      const job = publish.get(name);
      assert.ok(job, `publish.yml has a ${name} job`);
      assert.doesNotMatch(
        job,
        /\bnpx\b/,
        "npx resolves the tool's dependencies unlocked and runs their scripts",
      );
      assert.match(job, /npm ci --ignore-scripts [^\n]*--prefix tools\/publish/);
      assert.match(job, /tools\/publish\/node_modules\/\.bin\/(vsce|ovsx) publish/);
      const install = job.indexOf("npm ci --ignore-scripts");
      assert.ok(install < job.search(/node_modules\/\.bin\/(vsce|ovsx) publish/));
    });
  }

  it("OVSX_PAT is only in the ovsx publish step's env, not a job's", () => {
    const text = read(".github/workflows/publish.yml");
    const uses = [...text.matchAll(/^( +)OVSX_PAT: \$\{\{ secrets\.OVSX_PAT \}\}$/gm)];
    assert.equal(uses.length, 1);
    const before = text.slice(0, uses[0].index);
    const step = before.slice(before.lastIndexOf("      - name: "));
    assert.match(step, /^ {6}- name: ovsx publish\n {8}env:\n/);
    for (const [name, job] of publish)
      if (name !== "publish-openvsx") assert.doesNotMatch(job, /OVSX_PAT/, name);
  });

  it("tools/publish pins vsce and ovsx exactly, at versions with --oidc and --trusted-publishing", () => {
    const deps = tools.devDependencies;
    assert.match(deps["@vscode/vsce"], /^\d+\.\d+\.\d+$/);
    assert.match(deps.ovsx, /^\d+\.\d+\.\d+$/);
    const [vsceMajor, vsceMinor] = deps["@vscode/vsce"].split(".").map(Number);
    assert.ok(vsceMajor > 4 || (vsceMajor === 4 && vsceMinor >= 1), "vsce 4.1.0 is the first with --oidc");
    assert.equal(lock.packages["node_modules/@vscode/vsce"].version, deps["@vscode/vsce"]);
    assert.equal(lock.packages["node_modules/ovsx"].version, deps.ovsx);
    for (const [path, entry] of Object.entries(lock.packages))
      if (path) assert.ok(entry.integrity || entry.link, `${path} has an integrity hash`);
  });
});
