// The stall rate per OS × VS Code version × arm, as a Markdown table, from the windows' results (run.mjs).
//
//   node summary.mjs results-dir/   (every *.json in it, each an array of window results)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OS = { linux: "Linux", darwin: "macOS", win32: "Windows" };

const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * One row per OS, VS Code version and arm. A `cut` window whose first page had already posted when it was closed did
 * not cut a load short: it is counted apart ("not cut short") and left out of the rate.
 */
export function summarize(results) {
  const rows = new Map();
  for (const result of results) {
    const key = `${OS[result.platform] ?? result.platform ?? "?"}|${result.vscode ?? "?"}|${result.arm}`;
    const row = rows.get(key) ?? { windows: 0, stalled: 0, errors: 0, notCut: 0, startedMs: [] };
    rows.set(key, row);
    row.windows += 1;
    if (result.error) row.errors += 1;
    else if (result.arm === "cut" && (result.firstMessagesAtClose ?? []).length > 0) row.notCut += 1;
    else if (result.stalled) row.stalled += 1;
    else {
      const started = result.secondMessages?.find((m) => m.type === "started");
      if (started) row.startedMs.push(started.afterMs);
    }
  }
  const lines = [
    "| OS | VS Code | arm | windows | stalled | stall rate | not cut short | errors | median ms to first message |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [key, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const [os, version, arm] = key.split("|");
    const counted = row.windows - row.errors - row.notCut;
    const rate = counted > 0 ? `${((100 * row.stalled) / counted).toFixed(1)}%` : "n/a";
    lines.push(
      `| ${os} | ${version} | ${arm} | ${row.windows} | ${row.stalled} | ${rate} | ${row.notCut} | ${row.errors} | ${median(row.startedMs) ?? "n/a"} |`,
    );
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "results";
  const results = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json")) results.push(...JSON.parse(readFileSync(path, "utf8")));
    }
  };
  walk(dir);
  process.stdout.write(`${summarize(results)}\n`);
}
