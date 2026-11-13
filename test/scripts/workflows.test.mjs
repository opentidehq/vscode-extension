import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_RUNNERS } from "../../scripts/release-lib.mjs";

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

describe("workflows: the universal package and the platform packages carrying @opentide/opentide", () => {
  for (const file of WORKFLOWS) {
    it(`${file} builds no Python runtime and smoke-tests every package it builds`, () => {
      const text = read(file);
      assert.doesNotMatch(text, /runtime:(build|lock)|setup-uv|setup-python|pip install/);
      assert.match(text, /npm run package -- (--universal|"\$\{flags\[@\]\}")/);
      for (const [name, job] of jobs(text)) {
        if (!/npm run package/.test(job)) continue;
        if (/npm run package -- --universal|flags=\(--universal\)/.test(job))
          assert.match(job, /npm run smoke -- dist-vsix\/opentide-universal-/, name);
        if (/npm run package -- --target|flags=\(--target/.test(job))
          assert.match(job, /npm run smoke -- "?dist-vsix\/opentide-(\$\{TARGET\}|linux-x64)-/, name);
      }
    });
  }

  it("publish.yml builds each platform package on its own platform, once pins.json pins the package", () => {
    const platforms = jobs(read(".github/workflows/publish.yml")).get("platforms") ?? "";
    const matrix = [...platforms.matchAll(/- target: (\S+)\n\s+runner: (\S+)/g)].map(([, target, runner]) => [
      target,
      runner,
    ]);
    assert.deepEqual(Object.fromEntries(matrix), PLATFORM_RUNNERS);
    assert.match(platforms, /if: \$\{\{ needs\.prepare\.outputs\.platforms == 'true' \}\}/);
    const attest = jobs(read(".github/workflows/publish.yml")).get("attest") ?? "";
    assert.match(attest, /needs\.platforms\.result == 'skipped'/);
  });

  it("ci.yml builds @opentide/opentide from pins.json's source while it is not on npm", () => {
    const ci = jobs(read(".github/workflows/ci.yml"));
    const build = ci.get("opentide-npm") ?? "";
    assert.match(build, /opentide\.source\.ref/);
    assert.match(build, /npm run build/);
    for (const name of ["real-opentide", "integration", "package"])
      assert.match(ci.get(name) ?? "", /needs: opentide-npm/, name);
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
