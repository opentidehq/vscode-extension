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
