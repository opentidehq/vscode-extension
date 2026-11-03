// The diagnostics pipeline against test/fixtures/fake-opentide.mjs: argv → backend → findings → ranges.
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { spawnRun } from "../../../src/core/backend/spawn";
import { Capabilities } from "../../../src/core/capabilities/capabilities";
import { classify } from "../../../src/core/capabilities/classification";
import { cliRange, linesOf } from "../../../src/core/positions";
import { processEnv } from "../../../src/core/runtime/env";
import type { Runtime } from "../../../src/core/runtime/types";
import { lintFindings, validateFindings } from "../../../src/features/diagnostics/findings";
import { FindingsModel } from "../../../src/features/diagnostics/model";
import { lintArgv, planSave, validateArgv } from "../../../src/features/diagnostics/plan";
import { fakeRuntime } from "../helpers";

async function setup(env: Record<string, string>) {
  const runtime: Runtime = fakeRuntime({ env });
  const capabilities = new Capabilities({
    fetch: async (rt) =>
      (
        await spawnRun({
          command: rt.command,
          args: [...rt.args, "--json", "commands"],
          commandName: "commands",
          env: processEnv(process.env, rt, process.platform, {}),
          cwd: undefined,
          platform: process.platform,
        })
      ).document,
    cache: { read: async () => undefined, write: async () => {} },
    log: () => {},
  });
  const tree = await capabilities.load(runtime);
  const backend = new Backend({
    runtime: () => runtime,
    commands: async () => tree,
    classify: (argv) => classify(argv),
    serveMode: () => "auto",
    baseEnv: () => process.env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: () => {},
  });
  return { capabilities, backend };
}

describe("diagnostics against the fake opentide", function () {
  this.timeout(20_000);
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "otide-diag-"));
    mkdirSync(path.join(root, "objects", "rules"), { recursive: true });
    file = path.join(root, "objects", "rules", "r.yaml");
    writeFileSync(
      file,
      "name: r\nmetadata:\n  tlp: 🔥 ambr\ndescription: |  # opentide:placeholder\n  ...\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("validate --file: the finding after an emoji underlines `ambr`, with its fix", async () => {
    const { backend } = await setup({});
    const result = await backend.run(root, validateArgv([file]));
    assert.equal(result.exitCode, 1);
    const parsed = validateFindings(result.document, root);
    assert.equal(parsed.complete, true);
    const [finding] = parsed.findings;
    assert.ok(finding);
    assert.equal(finding.file, file);
    const range = cliRange(linesOf(readFileSync(file, "utf8")), finding.span);
    assert.equal("  tlp: 🔥 ambr".slice(range.start.character, range.end.character), "ambr");
    assert.equal(finding.fix?.edits[0]?.replacement, "amber");
    const model = new FindingsModel();
    const seq = model.begin();
    model.apply("validate", seq, { kind: "files", folder: root, files: [file] }, parsed.findings);
    assert.equal(model.get("validate", file).length, 1);
    await backend.dispose();
  });

  it("lints on save only when the CLI has `lint --file`", async () => {
    const settings = { validateOnSave: "file", lintOnSave: "file", lintWithValidate: false } as const;
    const target = { isObject: true, isConfiguration: false };
    const without = await setup({});
    assert.equal(without.capabilities.hasOption("lint", "--file"), false);
    assert.deepEqual(
      planSave(target, settings, {
        validateFile: without.capabilities.hasOption("validate", "--file"),
        lintFile: without.capabilities.hasOption("lint", "--file"),
      }),
      { validate: "file" },
    );
    await without.backend.dispose();

    const withFile = await setup({ FAKE_LINT_FILE: "1" });
    assert.equal(withFile.capabilities.hasOption("lint", "--file"), true);
    const result = await withFile.backend.run(root, lintArgv([file]));
    const parsed = lintFindings(result.document, root);
    assert.deepEqual(
      parsed.findings.map((f) => [f.code, f.severity, f.span.line, f.file]),
      [["placeholder", "warning", 4, file]],
    );
    await withFile.backend.dispose();
  });

  it("lint without --file covers the workspace", async () => {
    const { backend } = await setup({});
    const parsed = lintFindings((await backend.run(root, lintArgv())).document, root);
    assert.equal(parsed.findings.length, 1);
    await backend.dispose();
  });
});
