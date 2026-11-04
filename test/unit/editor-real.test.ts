// Diagnostics and new objects against a real opentide (OPENTIDE_TEST_BIN, OPENTIDE_TEST_WORKSPACE).
// Read-only on the given workspace: `new` and `generate` run in a temporary copy of its objects and
// .opentide/configurations and templates. Skipped when either variable is missing.
import * as assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../src/core/backend/backend";
import { spawnRun } from "../../src/core/backend/spawn";
import { classify } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import { cliRange, linesOf } from "../../src/core/positions";
import { processEnv } from "../../src/core/runtime/env";
import type { Runtime } from "../../src/core/runtime/types";
import { explainCodes, explainMarkdown } from "../../src/features/diagnostics/explain";
import { lintFindings, validateFindings } from "../../src/features/diagnostics/findings";
import { lintArgv, validateArgv } from "../../src/features/diagnostics/plan";
import {
  createdOf,
  failureAction,
  newArgv,
  objectHeader,
  platformsOf,
} from "../../src/features/new-object/flow";
import { placeholderLines } from "../../src/features/new-object/placeholders";
import { tideSnippets } from "../../src/features/new-object/snippets";

const BIN = process.env.OPENTIDE_TEST_BIN;
// Resolved: CI's spelling on Windows mixes separators (D:\\a\\_temp/opentide-ws).
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE
  ? path.resolve(process.env.OPENTIDE_TEST_WORKSPACE)
  : undefined;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("real opentide: diagnostics and new objects", function () {
  this.timeout(180_000);
  let backend: Backend;
  let tree: CommandTree;
  let scratch: string;

  before(async function () {
    if (!available) this.skip();
    const bin = BIN as string;
    const runtime: Runtime = {
      tier: 1,
      source: "setting",
      kind: "opentide",
      command: bin,
      args: [],
      version: "real",
      env: {},
      restricted: false,
      binDirs: [path.dirname(bin)],
    };
    const commands = await spawnRun({
      command: bin,
      args: ["--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    tree = CommandTree.parse(commands.document);
    backend = new Backend({
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
    // A small copy for the commands that write.
    scratch = mkdtempSync(path.join(tmpdir(), "otide-real-editor-"));
    const ws = WORKSPACE as string;
    for (const dir of [
      "objects/threats",
      "objects/objectives",
      ".opentide/configurations",
      ".opentide/templates",
    ])
      if (existsSync(path.join(ws, dir)))
        cpSync(path.join(ws, dir), path.join(scratch, dir), { recursive: true });
  });

  after(async () => {
    await backend?.dispose();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("validate --file: findings land on the right characters and carry their fixes", async () => {
    // The workspace's objects are valid (opentide new writes them): misspell the first rule's tlp in
    // a copy, so validate has a finding with a fix to place.
    const rules = path.join(WORKSPACE as string, "objects", "rules");
    const name = readdirSync(rules)
      .filter((n) => n.endsWith(".yaml"))
      .sort()[0] as string;
    const original = readFileSync(path.join(rules, name), "utf8");
    assert.match(original, /^[ \t]*tlp: amber\b/m, "the workspace's first rule has tlp: amber");
    const file = path.join(scratch, "objects", "rules", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original.replace(/^([ \t]*tlp: )amber\b/m, "$1ambr"));
    try {
      const result = await backend.run(scratch, validateArgv([file]));
      const parsed = validateFindings(result.document, scratch);
      assert.ok(parsed.complete, JSON.stringify(result.document.failure));
      const source = linesOf(readFileSync(file, "utf8"));
      const mine = parsed.findings.filter((f) => f.file === file);
      for (const finding of mine) {
        const range = cliRange(source, finding.span);
        assert.ok(range.start.line < source.lineCount, `${finding.code} is inside the file`);
        for (const edit of finding.fix?.edits ?? []) {
          // The edit replaces the bad value: the text under it is what the finding is about.
          const span = cliRange(source, edit);
          const under = source.lineText(span.start.line).slice(span.start.character, span.end.character);
          assert.ok(
            under.length > 0 && under !== edit.replacement,
            `${finding.code}: '${under}' → '${edit.replacement}'`,
          );
        }
      }
      const tlp = mine.find((f) => f.fix?.edits.some((e) => e.replacement === "amber"));
      assert.ok(tlp, `a fix for tlp: ambr in ${JSON.stringify(mine)}`);
      const edit = tlp.fix?.edits.find((e) => e.replacement === "amber");
      assert.ok(edit);
      const span = cliRange(source, edit);
      assert.equal(source.lineText(span.start.line).slice(span.start.character, span.end.character), "ambr");
    } finally {
      // The later tests create objects in the scratch copy: leave them only their own files.
      rmSync(file, { force: true });
    }
  });

  it("lint (--file when the CLI has it) gives findings in the workspace's files", async () => {
    const rules = path.join(WORKSPACE as string, "objects", "rules");
    const file = path.join(
      rules,
      readdirSync(rules)
        .filter((n) => n.endsWith(".yaml"))
        .sort()[0] as string,
    );
    const argv = tree.hasOption("lint", "--file") ? lintArgv([file]) : lintArgv();
    const parsed = lintFindings((await backend.run(WORKSPACE as string, argv)).document, WORKSPACE as string);
    assert.ok(parsed.complete);
    for (const finding of parsed.findings)
      assert.ok(finding.file.startsWith(WORKSPACE as string), finding.file);
    if (tree.hasOption("lint", "--file"))
      for (const finding of parsed.findings) assert.equal(finding.file, file);
  });

  it("explain renders markdown offline, and lists codes", async () => {
    const page = explainMarkdown(
      "vocab_unknown",
      (await backend.run(scratch, ["explain", "vocab_unknown"])).document,
    );
    assert.ok(page?.startsWith("# vocab_unknown"), page);
    assert.ok(
      explainCodes((await backend.run(scratch, ["explain"])).document).some(
        (c) => c.code === "vocab_unknown",
      ),
    );
  });

  it("new rule creates a file that validates, opens on its placeholders, and never overwrites", async function () {
    if (!tree.hasCommand("new rule")) this.skip();
    const objectives = path.join(scratch, "objects", "objectives");
    const objectiveFile = existsSync(objectives)
      ? readdirSync(objectives).find((n) => n.endsWith(".yaml"))
      : undefined;
    const objective = objectiveFile
      ? objectHeader(readFileSync(path.join(objectives, objectiveFile), "utf8"))
      : undefined;
    const platforms = platformsOf((await backend.run(scratch, ["info"])).document);
    const enabled = platforms.filter((p) => p.enabled).map((p) => p.name);
    const argv = newArgv({
      kind: "rule",
      name: "Editor Test Rule 🔥",
      platforms: enabled.slice(0, 1),
      ...(objective ? { objective: objective.uuid } : {}),
    });
    const result = await backend.run(scratch, argv);
    const created = createdOf(result.document, scratch);
    assert.ok(created, JSON.stringify(result.document));
    const lines = readFileSync(created.file, "utf8").split(/\r?\n/);
    assert.equal(placeholderLines(lines).length, created.placeholders);
    const validated = await backend.run(scratch, validateArgv([created.file]));
    const errors = validateFindings(validated.document, scratch).findings.filter(
      (f) => f.file === created.file && f.severity === "error",
    );
    assert.deepEqual(errors, [], "the new rule validates");
    const again = await backend.run(
      scratch,
      newArgv({ kind: "rule", name: "Editor Test Rule 🔥", path: created.file }),
    );
    const action = failureAction(
      again.document.failure?.code,
      again.document.failure?.message ?? "",
      scratch,
    );
    assert.deepEqual(action, { kind: "exists", file: created.file });
  });

  it("generate snippets writes tide-* snippets the extension can serve in opentide-yaml", async function () {
    if (!tree.hasCommand("generate")) this.skip();
    const result = await backend.run(scratch, ["generate", "snippets"]);
    assert.equal(result.exitCode, 0, JSON.stringify(result.document.failure));
    const file = path.join(scratch, ".vscode", "model-templates.code-snippets");
    const all = tideSnippets(readFileSync(file, "utf8"), true);
    assert.ok(all.some((s) => s.prefix === "tide-rule"));
    const missing = tideSnippets(readFileSync(file, "utf8"));
    // Before opentide#752 the scope is `yaml` and the extension serves them; after, VS Code does.
    assert.ok(missing.length === 0 || missing.length === all.length);
  });
});
