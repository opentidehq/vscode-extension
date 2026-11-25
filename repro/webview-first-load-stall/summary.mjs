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
  return [lines.join("\n"), latencies(results), probeDetails(results)].filter(Boolean).join("\n\n");
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

/**
 * How long healthy pages take to send their first message, from the moment their panel was created: what a
 * watchdog threshold must stay above. A page that started at all, in an arm that never replaces it (a recreate arm
 * would cut the slow ones short), counts; one slower than a threshold is a recreation that threshold would have made
 * for nothing.
 */
function latencies(results) {
  const rows = new Map();
  for (const result of results) {
    if (result.error || !result.arm || result.arm.startsWith("cut-recreate")) continue;
    if (result.arm.startsWith("cut") && (result.firstMessagesAtClose ?? []).length > 0) continue;
    const started = result.secondMessages?.find((m) => m.type === "started");
    if (!started) continue;
    const group = result.arm === "control" ? "control" : "cut, cut-inline, cut-delay";
    const key = `${OS[result.platform] ?? result.platform}|${result.vscode}|${group}`;
    const list = rows.get(key) ?? [];
    list.push(started.afterMs);
    rows.set(key, list);
  }
  if (rows.size === 0) return "";
  const lines = [
    "### First message of healthy pages (ms from the panel's creation)",
    "",
    "| OS | VS Code | arms | pages | median | p99 | slowest | over 3 s | over 5 s | over 10 s |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const all = [];
  for (const [key, list] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const [os, version, group] = key.split("|");
    const sorted = [...list].sort((a, b) => a - b);
    all.push(...sorted);
    const over = (ms) => sorted.filter((value) => value > ms).length;
    lines.push(
      `| ${os} | ${version} | ${group} | ${sorted.length} | ${percentile(sorted, 50)} | ${percentile(sorted, 99)} | ${sorted[sorted.length - 1]} | ${over(3000)} | ${over(5000)} | ${over(10000)} |`,
    );
  }
  const sorted = all.sort((a, b) => a - b);
  const over = (ms) => sorted.filter((value) => value > ms).length;
  lines.push(
    `| **all** | | | ${sorted.length} | ${percentile(sorted, 50)} | ${percentile(sorted, 99)} | ${sorted[sorted.length - 1]} | ${over(3000)} | ${over(5000)} | ${over(10000)} |`,
  );
  return lines.join("\n");
}

/** One frame or worker of a probe, on one line. */
function describeFrame(frame) {
  if (frame.error) return `${frame.via}: error ${frame.error}`;
  if (frame.worker) {
    const workers = `installing=${frame.installing} waiting=${frame.waiting} active=${frame.active}`;
    return `service worker: ${workers}; clients [${(frame.clients ?? []).join(", ")}]`;
  }
  const registration =
    frame.registration && typeof frame.registration === "object"
      ? `installing=${frame.registration.installing} waiting=${frame.registration.waiting} active=${frame.registration.active}`
      : String(frame.registration);
  const marks = (frame.marks ?? []).filter((mark) => /content|init|webview|ready/.test(mark));
  const resources = (frame.resources ?? []).map((r) => `${r.name}:${r.status ?? "?"}/${r.ms}ms`);
  return (
    `${frame.path}${frame.id ? `?id=${String(frame.id).slice(0, 8)}` : ""} ${frame.readyState}; ` +
    `controlled=${frame.controlled} (${frame.controller}); registration ${registration}; ` +
    `child frames ${frame.frames}, scripts ${frame.scripts}; marks [${marks.join(" ")}]; resources [${resources.join(" ")}]`
  );
}

/**
 * Every silent page's probes (and one healthy baseline per OS and VS Code version), so that the job's log shows what
 * the webview frames were doing without downloading the artifacts.
 */
function probeDetails(results) {
  const lines = [];
  const baselines = new Set();
  for (const result of results) {
    for (const probe of result.probes ?? []) {
      const where = `${OS[result.platform] ?? result.platform} ${result.vscode} ${result.arm} window ${result.window}`;
      if (probe.what === "healthy") {
        const key = `${result.platform}|${result.vscode}`;
        if (baselines.has(key)) continue;
        baselines.add(key);
      }
      const outcome =
        probe.what === "healthy" ? "healthy baseline" : result.stalled ? "stalled" : "silent at 10 s, then";
      const later =
        probe.what !== "healthy" && !result.stalled
          ? result.recreated
            ? " recovered by recreate"
            : " started"
          : "";
      lines.push(`- **${where}** (${outcome}${later}; probed ${probe.what}, ${probe.ms} ms)`);
      if (probe.error) lines.push(`  - error: ${probe.error}`);
      for (const frame of probe.frames ?? []) lines.push(`  - ${describeFrame(frame)}`);
      if ((probe.frames ?? []).length === 0 && !probe.error) {
        lines.push(
          `  - no webview frames; targets [${(probe.targets ?? []).map((t) => `${t.type} ${t.url}`).join(", ")}]`,
        );
      }
    }
  }
  return lines.length > 0 ? `### Probes\n\n${lines.join("\n")}` : "";
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
