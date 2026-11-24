// scripts/skills-lib.mjs: the opentide skills pinned by commit and content digest, and the contributions made from them.
import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chatSkillEntries,
  contentDigest,
  frontmatter,
  PLUGIN_CONTEXT_KEY,
  SkillsError,
  skillNames,
  skillsOutputs,
  upstreamFiles,
} from "../../scripts/skills-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const skill = (name, description = "Does a thing. Use when asked.") =>
  Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);

/** An archive as GitHub makes one: every path under `skills-<sha>/`. */
const archive = (files) =>
  new Map(Object.entries(files).map(([path, data]) => [`skills-abc123/${path}`, data]));

describe("skills: the pinned opentide skills", () => {
  it("is pinned by commit and by the digest of its content", () => {
    assert.match(pins.skills.commit, /^[0-9a-f]{40}$/);
    assert.equal(pins.skills.url, `https://github.com/opentidehq/skills/archive/${pins.skills.commit}.zip`);
    assert.match(pins.skills.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(pins.skills.version, /^\d+\.\d+\.\d+$/);
  });

  it("takes skills/ and LICENSE of the tree, whatever the archive's top directory is called", () => {
    const files = upstreamFiles(
      archive({
        LICENSE: Buffer.from("EUPL"),
        "README.md": Buffer.from("x"),
        "skills/a/SKILL.md": skill("a"),
        "plugin.json": Buffer.from("{}"),
      }),
    );
    assert.deepEqual([...files.keys()].sort(), ["LICENSE", "skills/a/SKILL.md"]);
    assert.throws(
      () =>
        upstreamFiles(
          new Map([
            ["a/LICENSE", Buffer.from("x")],
            ["b/skills/a/SKILL.md", skill("a")],
          ]),
        ),
      /single top directory/,
    );
    assert.throws(() => upstreamFiles(archive({ "skills/a/SKILL.md": skill("a") })), /no LICENSE/);
  });

  it("digests the content, not the packing: path order and archive prefix change nothing, a changed byte does", () => {
    const a = upstreamFiles(
      archive({
        LICENSE: Buffer.from("L"),
        "skills/a/SKILL.md": skill("a"),
        "skills/b/SKILL.md": skill("b"),
      }),
    );
    const b = upstreamFiles(
      new Map([
        ["other-prefix/skills/b/SKILL.md", skill("b")],
        ["other-prefix/LICENSE", Buffer.from("L")],
        ["other-prefix/skills/a/SKILL.md", skill("a")],
      ]),
    );
    assert.equal(contentDigest(a), contentDigest(b));
    b.set("skills/a/SKILL.md", skill("a", "Changed."));
    assert.notEqual(contentDigest(a), contentDigest(b));
  });

  it("refuses a skill VS Code would skip silently: a name that is not its folder's, a bad name, no description", () => {
    const base = { LICENSE: Buffer.from("L") };
    assert.deepEqual(skillNames(upstreamFiles(archive({ ...base, "skills/a-b/SKILL.md": skill("a-b") }))), [
      "a-b",
    ]);
    assert.throws(
      () => skillNames(upstreamFiles(archive({ ...base, "skills/a/SKILL.md": skill("b") }))),
      SkillsError,
    );
    assert.throws(
      () => skillNames(upstreamFiles(archive({ ...base, "skills/A/SKILL.md": skill("A") }))),
      /not a valid skill name/,
    );
    assert.throws(
      () => skillNames(upstreamFiles(archive({ ...base, "skills/a/SKILL.md": skill("a", "") }))),
      /no description/,
    );
    assert.throws(
      () =>
        skillNames(upstreamFiles(archive({ ...base, "skills/a/SKILL.md": skill("a", "x".repeat(1025)) }))),
      /1024/,
    );
    assert.throws(
      () => skillNames(upstreamFiles(archive({ ...base, "skills/README.md": Buffer.from("x") }))),
      /no skills/,
    );
    assert.deepEqual(frontmatter("---\nname: \"q\"\ndescription: 'd'\n---\nbody"), {
      name: "q",
      description: "d",
    });
    assert.deepEqual(frontmatter("no frontmatter"), {});
  });

  it("contributes each skill's SKILL.md, left out while the Agent Plugin supplies them", () => {
    assert.deepEqual(chatSkillEntries(["a", "b"]), [
      { path: "./skills/a/SKILL.md", when: `!${PLUGIN_CONTEXT_KEY}` },
      { path: "./skills/b/SKILL.md", when: `!${PLUGIN_CONTEXT_KEY}` },
    ]);
    const { outputs, manifestText } = skillsOutputs(
      { commit: "0123456789abcdef0123456789abcdef01234567" },
      upstreamFiles(archive({ LICENSE: Buffer.from("L"), "skills/a/SKILL.md": skill("a") })),
    );
    assert.deepEqual([...outputs.keys()].sort(), ["skills/LICENSE", "skills/a/SKILL.md"]);
    assert.match(manifestText, /opentidehq\/skills@0123456789ab\. Do not edit/);
  });

  describe("in the repository", () => {
    const folders = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    it("has a SKILL.md for each folder, named like it, and the upstream licence", () => {
      assert.ok(folders.length > 0);
      for (const name of folders) {
        const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
        assert.equal(frontmatter(text).name, name);
      }
      assert.match(
        readFileSync(join(root, "skills", "LICENSE"), "utf8"),
        /EUROPEAN UNION PUBLIC LICENCE v\. 1\.2/,
      );
    });

    it("is what package.json contributes: one chatSkills entry per skill, and no entry for a missing file", () => {
      const entries = pkg.contributes.chatSkills;
      assert.deepEqual(
        entries.map((entry) => entry.path),
        folders.map((name) => `./skills/${name}/SKILL.md`),
      );
      for (const entry of entries) {
        assert.equal(entry.when, `!${PLUGIN_CONTEXT_KEY}`);
        assert.ok(existsSync(join(root, entry.path)), entry.path);
      }
    });

    it("contributes the always-on instructions, with the metadata VS Code reads from the file", () => {
      const [entry] = pkg.contributes.chatInstructions;
      assert.equal(entry.path, "./instructions/opentide.instructions.md");
      const text = readFileSync(join(root, entry.path), "utf8");
      const meta = frontmatter(text);
      assert.equal(meta.name, "opentide");
      assert.ok(meta.description && meta.description.length > 20);
      for (const rule of [/opentide MCP/i, /validate/i, /dry_run: false/]) assert.match(text, rule);
      // Prompt files are not contributed: VS Code runs them in Local sessions only (see contrib/knowledge.json).
      assert.equal(pkg.contributes.chatPromptFiles, undefined);
    });

    it("ships: .vscodeignore keeps skills/ and instructions/", () => {
      const ignore = readFileSync(join(root, ".vscodeignore"), "utf8");
      assert.match(ignore, /^!skills\/\*\*$/m);
      assert.match(ignore, /^!instructions\/\*\*$/m);
    });
  });
});
