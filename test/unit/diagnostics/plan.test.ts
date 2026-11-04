import * as assert from "node:assert/strict";
import { CancellationTokenSource } from "../../../src/core/util/cancellation";
import {
  dryRunFixes,
  explainCodes,
  explainMarkdown,
  isCode,
} from "../../../src/features/diagnostics/explain";
import {
  codeText,
  countSeverities,
  dedupeKey,
  lintArgv,
  nonOverlapping,
  planSave,
  planSaveBatch,
  serverKeys,
  summaryText,
  validateArgv,
  withoutDuplicates,
} from "../../../src/features/diagnostics/plan";
import { Runs, runKey } from "../../../src/features/diagnostics/runs";

const defaults = { validateOnSave: "file", lintOnSave: "file", lintWithValidate: false } as const;
const both = { validateFile: true, lintFile: true };
const object = { isObject: true, isConfiguration: false };
const config = { isObject: false, isConfiguration: true };

describe("diagnostics: plan", () => {
  it("validates and lints a saved object file alone", () => {
    assert.deepEqual(planSave(object, defaults, both), { validate: "file", lint: "file" });
  });

  it("lints on save only with `lint --file`; without it lint runs on demand", () => {
    assert.deepEqual(planSave(object, defaults, { validateFile: true, lintFile: false }), {
      validate: "file",
    });
  });

  it("validates the workspace for a configuration file, and for onSave: workspace", () => {
    assert.deepEqual(planSave(config, defaults, both), { validate: "workspace" });
    assert.deepEqual(planSave(object, { ...defaults, validateOnSave: "workspace" }, both), {
      validate: "workspace",
      lint: "file",
    });
    assert.deepEqual(
      planSave(object, { ...defaults, validateOnSave: "workspace", lintWithValidate: true }, both),
      {
        validate: "workspace",
        lint: "workspace",
      },
    );
  });

  it("a batch with a configuration file validates the workspace, with lint.withValidate's workspace lint", () => {
    const withValidate = { ...defaults, lintWithValidate: true };
    assert.deepEqual(planSaveBatch({ objects: 0, configuration: true }, withValidate, both), {
      validate: "workspace",
      lint: "workspace",
    });
    assert.deepEqual(planSaveBatch({ objects: 2, configuration: true }, withValidate, both), {
      validate: "workspace",
      lint: "workspace",
    });
    // Without withValidate, the saved objects are still linted alone.
    assert.deepEqual(planSaveBatch({ objects: 2, configuration: true }, defaults, both), {
      validate: "workspace",
      lint: "file",
    });
    assert.deepEqual(planSaveBatch({ objects: 0, configuration: true }, defaults, both), {
      validate: "workspace",
    });
    assert.deepEqual(planSaveBatch({ objects: 1, configuration: false }, defaults, both), {
      validate: "file",
      lint: "file",
    });
  });

  it("does nothing when off, and for other files", () => {
    assert.deepEqual(planSave(object, { ...defaults, validateOnSave: "off", lintOnSave: "off" }, both), {});
    assert.deepEqual(planSave({ isObject: false, isConfiguration: false }, defaults, both), {});
  });

  it("builds argv with one --file per file", () => {
    assert.deepEqual(validateArgv(), ["validate"]);
    assert.deepEqual(validateArgv(["/a", "/b"]), ["validate", "--file", "/a", "--file", "/b"]);
    assert.deepEqual(lintArgv(["/a"]), ["lint", "--file", "/a"]);
  });

  it("drops what the language server reports (file + code + start line): two problems, not four", () => {
    const server = new Set([dedupeKey("vocab_unknown", 8), dedupeKey("kql_parse_error", 59)]);
    const validate = [
      { code: "vocab_unknown", line: 8 },
      { code: "kql_parse_error", line: 59 },
      { code: "kql_parse_error", line: 60 },
    ];
    const kept = withoutDuplicates(validate, (item) => dedupeKey(item.code, item.line), server);
    assert.deepEqual(kept, [{ code: "kql_parse_error", line: 60 }]);
  });

  it("drops lint findings the server reports under its own codes (#46): five problems become two", () => {
    // Engine 0.9.1 and opentide 0.21.0's lint name the same checks differently.
    const server = new Set([
      dedupeKey("filename_slug", 0),
      dedupeKey("missing_author", 2),
      dedupeKey("missing_organisation", 2),
    ]);
    const lint = [
      {
        code: "filename_mismatch",
        line: 0,
        message: "Filename 'broken-rule.yaml' does not match slugify(name)",
      },
      {
        code: "metadata_recommended",
        line: 2,
        message: "Recommended metadata missing: author, organisation",
      },
      { code: "metadata_recommended", line: 2, message: "Recommended metadata missing: author, version" },
    ];
    const kept = withoutDuplicates(lint, (item) => serverKeys(item.code, item.line, item.message), server);
    assert.deepEqual(
      kept.map((item) => item.message),
      ["Recommended metadata missing: author, version"],
      "a key the server does not report keeps the lint finding",
    );
    assert.deepEqual(serverKeys("vocab_unknown", 3), [[dedupeKey("vocab_unknown", 3)]]);
  });

  it("reads codes as the language client gives them", () => {
    assert.equal(codeText("a"), "a");
    assert.equal(codeText(3), "3");
    assert.equal(codeText({ value: "b", target: {} }), "b");
    assert.equal(codeText(undefined), undefined);
  });

  it("counts errors and warnings, not notes", () => {
    assert.deepEqual(countSeverities(["error", "warning", "info", "hint", "error"]), {
      errors: 2,
      warnings: 1,
    });
    assert.equal(summaryText({ errors: 2, warnings: 1 }, 1), "2 errors, 1 warning in 1 file");
    assert.equal(summaryText({ errors: 0, warnings: 0 }, 0), "No problems");
  });
});

describe("diagnostics: explain and fixes", () => {
  it("renders explain's markdown with a footer, and refuses a failure", () => {
    const page = explainMarkdown("vocab_unknown", { ok: true, markdown: "# vocab_unknown\n\nA value…\n" });
    assert.ok(page?.startsWith("# vocab_unknown\n\nA value…"));
    assert.ok(page?.includes("https://opentide.org/docs/cli/diagnostics/#vocab_unknown"));
    assert.equal(explainMarkdown("x", { ok: false, failure: { code: "usage", message: "no" } }), undefined);
    assert.ok(explainMarkdown("x", { ok: true, meaning: "m" })?.startsWith("# x\n\nm"));
  });

  it("lists codes and accepts only code-shaped values", () => {
    assert.deepEqual(explainCodes({ codes: [{ code: "a", meaning: "m" }, { nope: 1 }] }), [
      { code: "a", meaning: "m" },
    ]);
    assert.ok(isCode("vocab_unknown"));
    assert.ok(!isCode("a b"));
    assert.ok(!isCode("--help"));
    assert.ok(!isCode(""));
  });

  it("reads validate --fix --dry-run", () => {
    const { diff, fixes } = dryRunFixes({
      diff: "--- a/x\n+++ b/x\n",
      would_fix: [
        { path: "objects/rules/x.yaml", line: 9, code: "vocab_unknown", before: "AMBER", after: "amber" },
        {},
      ],
    });
    assert.equal(diff, "--- a/x\n+++ b/x\n");
    assert.equal(fixes.length, 1);
    assert.deepEqual(dryRunFixes(undefined), { diff: "", fixes: [] });
  });
});

describe("diagnostics: runs", () => {
  it("cancels the run a new one for the same key supersedes, and no other", () => {
    const runs = new Runs();
    const first = runs.start(runKey("validate", "/ws", "/ws/a.yaml"));
    const other = runs.start(runKey("validate", "/ws", "/ws/b.yaml"));
    const second = runs.start(runKey("validate", "/ws", "/ws/a.yaml"));
    assert.equal(first.token.isCancellationRequested, true);
    assert.equal(other.token.isCancellationRequested, false);
    assert.equal(second.token.isCancellationRequested, false);
    second.finish();
    first.finish();
    assert.equal(runs.size, 1);
  });

  it("cancels a folder's runs, not a sibling folder's, and follows a caller's token", () => {
    const runs = new Runs();
    const ws = runs.start(runKey("validate", "/ws"));
    const file = runs.start(runKey("validate", "/ws", "/ws/a.yaml"));
    const sibling = runs.start(runKey("validate", "/ws2"));
    runs.cancel(runKey("validate", "/ws"));
    assert.ok(ws.token.isCancellationRequested && file.token.isCancellationRequested);
    assert.equal(sibling.token.isCancellationRequested, false);
    const caller = new CancellationTokenSource();
    const linked = runs.start("k", caller.token);
    caller.cancel();
    assert.equal(linked.token.isCancellationRequested, true);
  });
});

describe("diagnostics: combined fixes", () => {
  const at = (line: number, a: number, b: number) => ({
    range: { start: { line, character: a }, end: { line, character: b } },
  });
  it("keeps edits that do not overlap, in order", () => {
    assert.deepEqual(nonOverlapping([at(1, 0, 3), at(1, 3, 5), at(1, 2, 4), at(2, 0, 1), at(1, 0, 3)]), [
      at(1, 0, 3),
      at(1, 3, 5),
      at(2, 0, 1),
    ]);
  });
});
