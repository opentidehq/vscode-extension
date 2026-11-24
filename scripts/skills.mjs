#!/usr/bin/env node
// Copies the opentide skills (opentidehq/skills, EUPL-1.2) into skills/ and writes contrib/skills.json, which
// `npm run manifest` merges into package.json as `contributes.chatSkills`. The tree is pinned in pins.json
// `skills` by commit and by a digest of its content (scripts/skills-lib.mjs), checked on whatever archive it
// comes from.
//   node scripts/skills.mjs                    download the commit's archive (cached in .cache/), verify, write
//   node scripts/skills.mjs --zip <file>       use a local archive of that commit (`git archive --format=zip`)
//   node scripts/skills.mjs --check            fail when skills/ or contrib/skills.json differ
//   node scripts/skills.mjs --print-digest     print the content digest of the archive: for a new pin
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readZip } from "./grammars-lib.mjs";
import { contentDigest, SKILLS_DIR, SkillsError, skillsOutputs, upstreamFiles } from "./skills-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

async function archive(pin) {
  const local = option("--zip");
  if (local) return readFileSync(local);
  const path = join(root, ".cache", `opentide-skills-${pin.commit.slice(0, 12)}.zip`);
  if (existsSync(path)) return readFileSync(path);
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok) throw new SkillsError(`GET ${pin.url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return buffer;
}

/** The skills folder as it is, to compare with what the pin produces. */
function stale(writes) {
  return [...writes].filter(([path, data]) => !existsSync(path) || !readFileSync(path).equals(data));
}

async function main() {
  const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
  const pin = pins.skills;
  const files = upstreamFiles(readZip(await archive(pin)));
  const digest = contentDigest(files);
  if (args.includes("--print-digest")) {
    console.log(digest);
    return;
  }
  if (digest !== pin.contentSha256)
    throw new SkillsError(`the content digest is ${digest}, but pins.json records ${pin.contentSha256}`);
  const { names, outputs, manifestText } = skillsOutputs(pin, files);
  const writes = new Map([...outputs].map(([path, data]) => [join(root, path), data]));
  writes.set(join(root, "contrib", "skills.json"), Buffer.from(manifestText));

  // A skill the pin no longer has must not stay behind in skills/.
  const wanted = new Set(names);
  const leftovers = existsSync(join(root, SKILLS_DIR))
    ? readdirSync(join(root, SKILLS_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !wanted.has(entry.name))
        .map((entry) => entry.name)
    : [];
  const differing = stale(writes);
  if (args.includes("--check")) {
    if (differing.length > 0 || leftovers.length > 0) {
      const list = [
        ...differing.map(([path]) => path.slice(root.length + 1)),
        ...leftovers.map((n) => `${SKILLS_DIR}/${n} (not in the pin)`),
      ];
      console.error(`skills are stale: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}`);
      console.error("Run `npm run skills && npm run manifest`.");
      process.exit(1);
    }
    console.log(`skills match opentidehq/skills@${pin.commit.slice(0, 12)} (${names.length} skills)`);
    return;
  }
  for (const name of leftovers) rmSync(join(root, SKILLS_DIR, name), { recursive: true, force: true });
  for (const [path, data] of differing) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  console.log(
    `wrote ${differing.length} file(s) for ${names.length} skills from opentidehq/skills@${pin.commit.slice(0, 12)}; now run \`npm run manifest\``,
  );
}

main().catch((error) => {
  console.error(`skills: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
