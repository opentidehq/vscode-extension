import * as assert from "node:assert/strict";
import * as path from "node:path";
import { cliRange, linesOf } from "../../../src/core/positions";
import {
  diagnosticMessage,
  docsUrl,
  fixTitle,
  isDeprecationCode,
  lintFindings,
  severityOf,
  validateFindings,
} from "../../../src/features/diagnostics/findings";

const ROOT = path.resolve("/ws");

// Shapes as opentide 0.21.0 prints them (`opentide --json validate --file …`, `lint --file …`).
const VALIDATE = {
  command: "validate",
  exit_code: 1,
  workspace: ROOT,
  report: {
    issues: [
      {
        code: "vocab_unknown",
        severity: "error",
        file_path: path.join(ROOT, "objects/rules/r.yaml"),
        yaml_line: 8,
        message: "Value 'ambr' is not a valid 'tlp::1.0' vocabulary entry",
        context: { vocab: "tlp::1.0", value: "ambr" },
        path: "objects/rules/r.yaml",
        line: 9,
        column: 8,
        end_column: 12,
        help: "did you mean 'amber'?",
        fix: {
          safe: false,
          edits: [{ line: 9, column: 8, end_line: 9, end_column: 12, replacement: "amber" }],
        },
      },
      {
        code: "unknown_key",
        severity: "error",
        file_path: null,
        message: "platforms/sentinel.toml.platform.flags: unknown key",
        context: { file: "platforms/sentinel.toml" },
        path: null,
        line: null,
        column: null,
        end_column: null,
        help: null,
        fix: null,
      },
      { code: "internal", severity: "error", message: "no file", path: null, file_path: null },
      {
        code: "duplicate_id",
        severity: "error",
        file_path: path.join(ROOT, "objects/rules/b.yaml"),
        message: "Duplicated ID",
        context: {
          value: "u-1",
          original: { name: "A", file_path: path.join(ROOT, "objects/rules/a.yaml") },
        },
        line: 4,
        column: 9,
        end_line: 4,
        end_column: 12,
      },
    ],
    warnings: [{ code: "x_warn", severity: "warning", path: "objects/rules/r.yaml", line: 2, message: "w" }],
  },
};

const LINT = {
  command: "lint",
  path: ROOT,
  findings: [
    {
      check: "placeholders",
      severity: "warning",
      path: "objects/rules/test-rule.yaml",
      yaml_line: 17,
      message: "description holds a placeholder value written by opentide new",
      code: "placeholder",
      line: 18,
      column: 1,
      end_column: 12,
      help: "replace the value, then delete the '# opentide:placeholder' comment",
      fix: null,
    },
    {
      check: "metadata",
      severity: "info",
      path: "objects/rules/test-rule.yaml",
      code: "metadata_recommended",
      line: 3,
      message: "m",
    },
  ],
};

describe("diagnostics: findings", () => {
  it("reads validate issues and warnings with absolute files and CLI spans", () => {
    const parsed = validateFindings(VALIDATE, "/elsewhere");
    assert.equal(parsed.complete, true);
    assert.equal(parsed.unlocated, 1, "the finding without any file is counted, not shown");
    const [vocab, config, dup, warn] = parsed.findings;
    assert.equal(vocab?.file, path.join(ROOT, "objects/rules/r.yaml"));
    assert.deepEqual(vocab?.span, { line: 9, column: 8, end_line: null, end_column: 12 });
    assert.equal(vocab?.severity, "error");
    assert.deepEqual(vocab?.fix?.edits[0], {
      line: 9,
      column: 8,
      end_line: 9,
      end_column: 12,
      replacement: "amber",
    });
    assert.equal(vocab?.fix?.safe, false);
    assert.equal(config?.file, path.join(ROOT, ".opentide", "configurations", "platforms/sentinel.toml"));
    assert.deepEqual(config?.span, { line: 1, column: null, end_line: null, end_column: null });
    assert.deepEqual(dup?.related, [
      { file: path.join(ROOT, "objects/rules/a.yaml"), message: "already used by 'A'", value: "u-1" },
    ]);
    assert.equal(dup?.span.end_line, 4);
    assert.equal(warn?.severity, "warning");
  });

  it("resolves lint's workspace-relative paths against the document's path", () => {
    const parsed = lintFindings(LINT, "/elsewhere");
    assert.equal(parsed.findings.length, 2);
    assert.equal(parsed.findings[0]?.file, path.join(ROOT, "objects/rules/test-rule.yaml"));
    assert.equal(parsed.findings[0]?.source, "lint");
    assert.equal(parsed.findings[1]?.severity, "info");
  });

  it("says a document without findings is incomplete (a failure, not 'no problems')", () => {
    const failure = { ok: false, exit_code: 2, failure: { code: "workspace_not_found", message: "x" } };
    assert.equal(validateFindings(failure, ROOT).complete, false);
    assert.equal(lintFindings(failure, ROOT).complete, false);
  });

  it("says a failed run is incomplete even with an empty findings list, so it clears nothing", () => {
    // `lint --file objects/rules/sub/x.yaml` (opentide 0.21.0): exit 1, findings [], command_failed.
    const lint = {
      path: ROOT,
      findings: [],
      count: 0,
      unmatched: ["objects/rules/sub/x.yaml"],
      ok: false,
      status: "failed",
      exit_code: 1,
      failure: { code: "command_failed", message: "No object file directly in objects/rules matched" },
    };
    assert.equal(lintFindings(lint, ROOT).complete, false);
    // `validate --file objects/rules/sub/x.yaml`: issues_found, with only an unlocated scope_no_match.
    const validate = {
      workspace: ROOT,
      exit_code: 1,
      ok: false,
      failure: { code: "issues_found", message: "Validation failed" },
      report: { ok: false, issues: [{ code: "scope_no_match", severity: "error", file_path: null }] },
    };
    assert.equal(validateFindings(validate, ROOT).complete, false);
    // Issues found is a complete run.
    const found = { ...VALIDATE, ok: false, failure: { code: "issues_found", message: "Validation failed" } };
    assert.equal(validateFindings(found, ROOT).complete, true);
    assert.equal(
      lintFindings({ ...lint, ok: true, failure: null, status: "completed" }, ROOT).complete,
      true,
    );
  });

  it("falls back to yaml_line + 1 and to the first line", () => {
    const parsed = validateFindings(
      {
        report: {
          issues: [
            { code: "a", path: "x.yaml", yaml_line: 4 },
            { code: "b", path: "y.yaml" },
          ],
        },
      },
      ROOT,
    );
    assert.equal(parsed.findings[0]?.span.line, 5);
    assert.equal(parsed.findings[1]?.span.line, 1);
  });

  it("never resolves a configuration file outside the workspace", () => {
    const parsed = validateFindings(
      { report: { issues: [{ code: "a", context: { file: "../../etc/passwd" } }] } },
      ROOT,
    );
    assert.equal(parsed.findings.length, 0);
  });

  it("maps severities, docs targets, deprecation tags, messages and fix titles", () => {
    assert.equal(severityOf("error"), "error");
    assert.equal(severityOf("warning"), "warning");
    assert.equal(severityOf("info"), "info");
    assert.equal(severityOf("note"), "hint");
    assert.equal(severityOf("hint"), "hint");
    assert.equal(docsUrl("vocab_unknown"), "https://opentide.org/docs/cli/diagnostics/#vocab_unknown");
    assert.ok(isDeprecationCode("kql_deprecated_function"));
    assert.ok(!isDeprecationCode("vocab_unknown"));
    const [vocab] = validateFindings(VALIDATE, ROOT).findings;
    assert.ok(vocab);
    assert.equal(
      diagnosticMessage(vocab),
      "Value 'ambr' is not a valid 'tlp::1.0' vocabulary entry\ndid you mean 'amber'?",
    );
    assert.equal(fixTitle(vocab), "Replace with 'amber'");
  });

  it("underlines the right characters after an emoji (code points to UTF-16)", () => {
    // `name: 🔥 ambr`: the CLI counts 🔥 as one column, so `ambr` is columns 9–12 (end exclusive 13).
    const text = "line one\nname: 🔥 ambr\n";
    const finding = validateFindings(
      { report: { issues: [{ code: "vocab_unknown", path: "r.yaml", line: 2, column: 9, end_column: 13 }] } },
      ROOT,
    ).findings[0];
    assert.ok(finding);
    const range = cliRange(linesOf(text), finding.span);
    const line = text.split("\n")[1] ?? "";
    assert.equal(line.slice(range.start.character, range.end.character), "ambr");
  });

  it("uses end_line when the CLI gives it (opentide#755)", () => {
    const text = "query: |\n  a\n  bcd\n";
    const finding = validateFindings(
      { report: { issues: [{ code: "q", path: "r.yaml", line: 2, column: 3, end_line: 3, end_column: 6 }] } },
      ROOT,
    ).findings[0];
    assert.ok(finding);
    assert.deepEqual(cliRange(linesOf(text), finding.span), {
      start: { line: 1, character: 2 },
      end: { line: 2, character: 5 },
    });
  });
});
