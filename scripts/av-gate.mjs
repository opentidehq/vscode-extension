#!/usr/bin/env node
// The antivirus gate's local steps (.github/workflows/av-gate.yml; docs/RELEASING.md "The antivirus gate"):
//   node scripts/av-gate.mjs static DIR        every DIR/*.vsix: no native executable at any depth (nested
//                                               archives opened), and within pins.json's recorded size
//   node scripts/av-gate.mjs extract DIR OUT   unpack every DIR/*.vsix into OUT/<file name>/, for the scanners
// Exits 1 on any finding. Dependency-free (Node built-ins and scripts/*-lib.mjs), so the Windows job needs no npm ci.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nativeExecutables, sizeGrowthProblem } from "./av-lib.mjs";
import { zipEntries, zipRead } from "./package-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [command, dir, out] = process.argv.slice(2);

function packages(folder) {
  const names = readdirSync(folder)
    .filter((name) => name.endsWith(".vsix"))
    .sort();
  if (names.length === 0) {
    console.error(`av-gate: no .vsix in ${folder}`);
    process.exit(1);
  }
  return names.map((name) => ({ name, buffer: readFileSync(join(folder, name)) }));
}

if (command === "static" && dir) {
  const vsix = JSON.parse(readFileSync(join(root, "pins.json"), "utf8")).vsix;
  const problems = [];
  for (const { name, buffer } of packages(dir)) {
    const found = nativeExecutables(buffer, name);
    for (const { path, format } of found) problems.push(`${path}: ${format}`);
    const grown = sizeGrowthProblem(name, buffer.length, vsix);
    if (grown) problems.push(grown);
    if (found.length === 0) console.log(`av-gate: ${name}: no native executable; ${buffer.length} bytes`);
  }
  for (const problem of problems) console.error(`::error title=AV gate::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("av-gate: static checks passed");
} else if (command === "extract" && dir && out) {
  for (const { name, buffer } of packages(dir)) {
    const target = join(out, name);
    const entries = zipEntries(buffer);
    for (const entry of entries) {
      const file = join(target, ...entry.name.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, zipRead(buffer, entry));
    }
    console.log(`av-gate: ${name}: ${entries.length} files in ${target}`);
  }
} else {
  console.error("usage: av-gate.mjs static DIR | extract DIR OUT");
  process.exit(2);
}
