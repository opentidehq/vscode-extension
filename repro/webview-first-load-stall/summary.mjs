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
 * One row per OS, VS Code version and arm. A `cut*` window whose first page had already posted when it was closed did
 * not cut a load short: it is counted apart ("not cut short") and left out of the rate. "Silent at 10 s" counts the
 * second pages that had not started by then (the stalls, plus any slow page); in `cut-recreate`, those were recreated,
 * and "stalled" counts the recreated panels that did not start either.
 */
export function summarize(results) {
  const rows = new Map();
  for (const result of results) {
    const key = `${OS[result.platform] ?? result.platform ?? "?"}|${result.vscode ?? "?"}|${result.arm}`;
    const row = rows.get(key) ?? {
      windows: 0,
      stalled: 0,
      errors: 0,
      notCut: 0,
      silent: 0,
      recreated: 0,
      recovered: 0,
      inline: 0,
      startedMs: [],
    };
    rows.set(key, row);
    row.windows += 1;
    if (result.error) {
      row.errors += 1;
      continue;
    }
    if (result.arm?.startsWith("cut") && (result.firstMessagesAtClose ?? []).length > 0) {
      row.notCut += 1;
      continue;
    }
    const secondStarted = result.secondMessages?.some((m) => m.type === "started");
    if (!secondStarted) row.silent += 1;
    if (!secondStarted && result.secondMessages?.some((m) => m.type === "inline")) row.inline += 1;
    if (result.recreated) {
      row.recreated += 1;
      if (!result.stalled) row.recovered += 1;
    }
    if (result.stalled) row.stalled += 1;
    else {
      const started = (result.thirdMessages ?? result.secondMessages)?.find((m) => m.type === "started");
      if (started) row.startedMs.push(started.afterMs);
    }
  }
  const lines = [
    "| OS | VS Code | arm | windows | stalled | stall rate | silent at 10 s | of those, inline ran | recreated → recovered | not cut short | errors | median ms to first message |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [key, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const [os, version, arm] = key.split("|");
    const counted = row.windows - row.errors - row.notCut;
    const rate = counted > 0 ? `${((100 * row.stalled) / counted).toFixed(1)}%` : "n/a";
    lines.push(
      `| ${os} | ${version} | ${arm} | ${row.windows} | ${row.stalled} | ${rate} | ${row.silent} | ${arm === "cut-inline" ? row.inline : "–"} | ${row.recreated > 0 ? `${row.recreated} → ${row.recovered}` : "–"} | ${row.notCut} | ${row.errors} | ${median(row.startedMs) ?? "n/a"} |`,
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
