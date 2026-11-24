// What the runtime resolution reads from disk (src/core/services/runtime.ts): the repository's pin and the bundled
// WASI module's and engine's manifests. The first resolution starts while the window activates, so it reads them
// without a synchronous call (SPEC §14), and gets what the synchronous readers get.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
// The module object itself (`import * as` is a read-only namespace): the code under test reads through it.
import fsModule = require("node:fs");
import { tmpdir } from "node:os";
import * as path from "node:path";

import { readBundledAsync, readEngine, readPin, readWasi } from "../../src/core/services/runtime";

/** Run `work` with every synchronous fs call made to throw: what it reads, it reads off the thread. */
async function withoutSyncFs<T>(work: () => Promise<T>): Promise<T> {
  const fsRecord = fsModule as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of Object.keys(fsModule)) {
    if (key.endsWith("Sync") && typeof fsRecord[key] === "function") {
      saved.set(key, fsRecord[key]);
      fsRecord[key] = () => {
        throw new Error(`fs.${key} during the resolution's reads`);
      };
    }
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) fsRecord[key] = value;
  }
}

describe("the runtime resolution's reads", () => {
  const ext = fs.mkdtempSync(path.join(tmpdir(), "otide-ext-"));
  const repo = fs.mkdtempSync(path.join(tmpdir(), "otide-repo-"));
  before(() => {
    fs.mkdirSync(path.join(ext, "dist", "wasi"), { recursive: true });
    fs.mkdirSync(path.join(ext, "dist", "engine"), { recursive: true });
    fs.writeFileSync(
      path.join(ext, "dist", "wasi", "wasi.json"),
      '{"version":"1.0.0-rc.5","module":"opentide.wasm","launcher":"launcher.cjs","source":"release"}',
    );
    fs.writeFileSync(
      path.join(ext, "dist", "engine", "engine.json"),
      '{"version":"1.0.0-rc.5","module":"opentide_wasm_bg.wasm"}',
    );
    fs.writeFileSync(path.join(repo, "requirements.txt"), "# tools\nopentide==0.20.1\n");
  });
  after(() => {
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("read the pin and the bundled manifests with no synchronous fs call, as the synchronous readers do", async () => {
    const problems: string[] = [];
    const expected = { wasi: readWasi(ext), engine: readEngine(ext) };
    assert.ok(expected.wasi && expected.engine, "the fixture has both");
    const [pin, bundled] = await withoutSyncFs(() =>
      Promise.all([readPin(repo), readBundledAsync(ext, (problem) => problems.push(problem))]),
    );
    assert.deepEqual(pin, { version: "0.20.1", source: "requirements.txt" });
    assert.deepEqual(bundled, expected);
    assert.deepEqual(problems, []);
  });

  it("find no pin and no bundled tiers where there are none, and say why a manifest is unusable", async () => {
    const empty = fs.mkdtempSync(path.join(tmpdir(), "otide-none-"));
    const broken = fs.mkdtempSync(path.join(tmpdir(), "otide-broken-"));
    try {
      fs.mkdirSync(path.join(broken, "dist", "wasi"), { recursive: true });
      fs.writeFileSync(
        path.join(broken, "dist", "wasi", "wasi.json"),
        '{"version":"1","module":"../x.wasm"}',
      );
      const problems: string[] = [];
      const [pin, none, bad] = await withoutSyncFs(() =>
        Promise.all([
          readPin(empty),
          readBundledAsync(empty, (problem) => problems.push(problem)),
          readBundledAsync(broken, (problem) => problems.push(problem)),
        ]),
      );
      assert.equal(pin, undefined);
      assert.equal(await readPin(undefined), undefined);
      assert.deepEqual(none, { wasi: undefined, engine: undefined });
      assert.deepEqual(bad, { wasi: undefined, engine: undefined });
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /the bundled WASI runtime is not available/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });
});
