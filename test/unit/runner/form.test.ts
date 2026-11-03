import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { modesOf, runnableCommands } from "../../../src/features/runner/commands";
import {
  buildArgv,
  describeValue,
  type FieldValue,
  fieldsOf,
  missingRequired,
  optionalFields,
  requiredFields,
  splitValues,
  validateValue,
} from "../../../src/features/runner/form";
import { COMMANDS_FIXTURE } from "../helpers";

const tree = CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));
const command = (path: string) => {
  const found = tree.command(path);
  assert.ok(found, path);
  return found;
};

describe("runner form", () => {
  it("turns a command's arguments and options into typed fields", () => {
    const fields = fieldsOf(command("query"));
    const byId = new Map(fields.map((field) => [field.id, field]));
    assert.equal(fields[0]?.id, "arg:query", "positional arguments come first");
    assert.equal(byId.get("opt:--platform")?.kind, "choice");
    assert.equal(byId.get("opt:--platform")?.required, true);
    assert.ok(byId.get("opt:--platform")?.choices.includes("sentinel"));
    assert.equal(byId.get("opt:--limit")?.kind, "integer");
    assert.equal(byId.get("opt:--timeout")?.kind, "number");
    assert.equal(byId.get("opt:--file")?.picker, "file");
    assert.equal(byId.get("opt:--query-file")?.picker, "file");
    assert.equal(byId.get("opt:--rule")?.picker, "uuid");
    assert.equal(byId.get("opt:--rule")?.objectType, "rule");
    assert.equal(byId.get("opt:--tenant")?.multiple, true);
  });

  it("tells flags, toggles, folders and object pickers apart", () => {
    const setup = new Map(fieldsOf(command("setup ci")).map((field) => [field.id, field]));
    assert.equal(setup.get("opt:--staging")?.kind, "toggle");
    assert.equal(setup.get("opt:--staging")?.negative, "--no-staging");
    assert.equal(setup.get("opt:--yes")?.kind, "flag");
    assert.equal(setup.get("opt:--path")?.picker, "folder");
    assert.equal(setup.get("arg:ci_platform")?.required, true);
    const validate = new Map(fieldsOf(command("validate")).map((field) => [field.id, field]));
    assert.equal(validate.get("opt:--output")?.picker, "file", "a path-typed --output is a file");
    assert.equal(validate.get("opt:--uuid")?.picker, "uuid");
    assert.equal(validate.get("opt:--uuid")?.objectType, undefined);
    const objective = new Map(fieldsOf(command("new objective")).map((field) => [field.id, field]));
    assert.equal(objective.get("opt:--threat")?.objectType, "threat");
  });

  it("builds the argv: path, positionals in order, then options as given", () => {
    const query = command("query");
    const fields = fieldsOf(query);
    const values = new Map<string, FieldValue>([
      ["opt:--platform", ["sentinel"]],
      ["arg:query", ["SecurityEvent | take 1"]],
      ["opt:--tenant", ["prod", "dev"]],
    ]);
    assert.deepEqual(buildArgv(query, fields, values), [
      "query",
      "SecurityEvent | take 1",
      "--platform",
      "sentinel",
      "--tenant",
      "prod",
      "--tenant",
      "dev",
    ]);
    const ci = command("setup ci");
    const ciFields = fieldsOf(ci);
    assert.deepEqual(
      buildArgv(
        ci,
        ciFields,
        new Map<string, FieldValue>([
          ["arg:ci_platform", ["github"]],
          ["opt:--staging", false],
          ["opt:--yes", true],
        ]),
      ),
      ["setup", "ci", "github", "--no-staging", "--yes"],
    );
  });

  it("splits required from optional and finds what is missing", () => {
    const fields = fieldsOf(command("query"));
    assert.deepEqual(
      requiredFields(fields).map((f) => f.id),
      ["opt:--platform"],
    );
    assert.ok(optionalFields(fields).some((f) => f.id === "arg:query"));
    assert.equal(missingRequired(fields, new Map())?.id, "opt:--platform");
    assert.equal(missingRequired(fields, new Map([["opt:--platform", ["splunk"]]])), undefined);
  });

  it("validates typed values and splits comma-separated ones", () => {
    const fields = new Map(fieldsOf(command("query")).map((field) => [field.id, field]));
    const limit = fields.get("opt:--limit");
    const timeout = fields.get("opt:--timeout");
    const platform = fields.get("opt:--platform");
    const tenant = fields.get("opt:--tenant");
    assert.ok(limit && timeout && platform && tenant);
    assert.equal(validateValue(limit, "10"), undefined);
    assert.match(validateValue(limit, "ten") ?? "", /whole number/);
    assert.equal(validateValue(timeout, "2.5"), undefined);
    assert.match(validateValue(timeout, "soon") ?? "", /number/);
    assert.match(validateValue(platform, "") ?? "", /required/);
    assert.match(validateValue(platform, "nope") ?? "", /one of/);
    assert.deepEqual(splitValues(tenant, "prod, dev ,"), ["prod", "dev"]);
    assert.deepEqual(splitValues(limit, " 5 "), ["5"]);
    assert.equal(describeValue(["a", "b"], tenant), "a, b");
  });

  it("offers no option the backend or the folder already sets", () => {
    for (const info of tree.commands) {
      for (const field of fieldsOf(info)) {
        assert.ok(!["--json", "--repo"].includes(field.flag ?? ""), `${info.path} ${field.flag}`);
      }
    }
  });

  it("lists every runnable command, and keeps servers and the TUI to a terminal", () => {
    const entries = runnableCommands(tree, (argv) => classify(argv));
    const paths = entries.map((entry) => entry.command.path);
    assert.ok(paths.includes("validate"));
    assert.ok(!paths.includes("new"), "a group that only prints help is left out");
    assert.deepEqual(entries.find((e) => e.command.path === "tui")?.modes, ["terminal"]);
    assert.deepEqual(entries.find((e) => e.command.path === "mcp start")?.modes, ["terminal"]);
    assert.deepEqual(modesOf("validate", ["validate", "--watch"]), ["terminal"]);
    assert.deepEqual(modesOf("validate", ["validate"]), ["background", "terminal"]);
    for (const entry of entries) assert.ok(!entry.classification.unclassified, entry.command.path);
  });
});
