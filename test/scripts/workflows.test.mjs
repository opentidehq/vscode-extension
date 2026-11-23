import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORES } from "../../scripts/package-lib.mjs";

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

describe("workflows: one universal package per store, no bundled runtime", () => {
  for (const file of WORKFLOWS) {
    it(`${file} builds no runtime and no per-platform package, and smoke-tests each store's package`, () => {
      const text = read(file);
      assert.doesNotMatch(
        text,
        /runtime:(build|lock)|npm run package -- --target|setup-uv|opentide-universal-/,
      );
      assert.match(text, /npm run package -- (--universal|"\$\{flags\[@\]\}")/);
      for (const [name, job] of jobs(text))
        if (/npm run package/.test(job))
          for (const { store } of STORES)
            assert.match(
              job,
              new RegExp(`npm run smoke -- dist-vsix/opentide-${store}-\\*\\.vsix`),
              `${name}: ${store}`,
            );
    });
  }
});

describe("publish.yml: each store publishes its own package", () => {
  const publish = jobs(read(".github/workflows/publish.yml"));
  const cases = [
    ["publish-marketplace", "marketplace", /vsce publish "\$\{flags\[@\]\}" --packagePath "\$\{VSIX\}"/],
    [
      "publish-openvsx",
      "openvsx",
      /ovsx publish --trusted-publishing --skip-duplicate --packagePath "\$\{VSIX\}"/,
    ],
  ];
  for (const [name, store, command] of cases) {
    it(`${name} publishes opentide-${store}-<version>.vsix only`, () => {
      const job = publish.get(name) ?? "";
      assert.ok(
        job.includes(`VSIX: release/opentide-${store}-\${{ needs.prepare.outputs.version }}.vsix`),
        `${name} names its package`,
      );
      assert.match(job, command);
      assert.doesNotMatch(job, /--packagePath release\/\*/, "never every package of the Release");
    });
  }

  it("the environment URLs are the stores' ids: opentide.opentide and opentidehq/opentide", () => {
    assert.match(
      publish.get("publish-marketplace") ?? "",
      /url: https:\/\/marketplace\.visualstudio\.com\/items\?itemName=opentide\.opentide\n/,
    );
    assert.match(
      publish.get("publish-openvsx") ?? "",
      /url: https:\/\/open-vsx\.org\/extension\/opentidehq\/opentide\n/,
    );
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
