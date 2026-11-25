// Runs trial.js in N fresh VS Code windows per arm (each with its own empty user data and extensions folders),
// arms interleaved, and writes every window's result to results/<label>.json, with a summary on stdout.
//
//   node run.mjs --version stable --windows 40 [--arms cut,control] [--label linux-stable]
//
// @vscode/test-electron comes from the repository's node_modules (npm ci at the root).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

import { summarize } from "./summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "stable" },
    windows: { type: "string", default: "40" },
    arms: { type: "string", default: "cut,control" },
    label: { type: "string" },
  },
});
const windows = Number(values.windows);
const arms = values.arms.split(",").filter(Boolean);
const label = values.label ?? `${process.platform}-${values.version}`;

/** The page's script: its first statement posts `started`, then ~1.2 MB of code to parse, then `ready`. */
function bigScript(bytes = 1_200_000) {
  const head =
    "const vscode = acquireVsCodeApi();\n" +
    'vscode.postMessage({ type: "started", at: performance.now() });\n';
  const parts = [head];
  let size = head.length;
  for (let n = 0; size < bytes; n += 1) {
    const line = `function f${n}(a, b) { const s = "${"x".repeat(40)}" + a; return s.length + b * ${n}; }\n`;
    parts.push(line);
    size += line.length;
  }
  parts.push('vscode.postMessage({ type: "ready", at: performance.now() });\n');
  return parts.join("");
}

const say = (line) => process.stdout.write(`${line}\n`);

writeFileSync(join(here, "media", "big.js"), bigScript());
const vscodeExecutablePath = await downloadAndUnzipVSCode(values.version);
say(`REPRO ${label}: ${windows} windows per arm (${arms.join(", ")}), VS Code ${values.version}`);

const results = [];
for (let window = 0; window < windows; window += 1) {
  // Interleaved, alternating the order, so a slower stretch of the runner falls on both arms.
  const order = window % 2 === 0 ? arms : [...arms].reverse();
  for (const arm of order) {
    const scratch = mkdtempSync(join(tmpdir(), `repro-${arm}-`));
    const out = join(scratch, "result.json");
    const began = Date.now();
    let result;
    try {
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: here,
        extensionTestsPath: join(here, "trial.js"),
        launchArgs: [
          "--user-data-dir",
          join(scratch, "user-data"),
          "--extensions-dir",
          join(scratch, "extensions"),
          "--disable-extensions",
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
        ],
        extensionTestsEnv: { REPRO_ARM: arm, REPRO_OUT: out },
      });
      result = JSON.parse(readFileSync(out, "utf8"));
    } catch (error) {
      result = {
        arm,
        platform: process.platform,
        vscode: values.version,
        error: String(error?.message ?? error),
      };
    }
    result.window = window;
    result.wallMs = Date.now() - began;
    results.push(result);
    const started = result.secondMessages?.find((m) => m.type === "started");
    say(
      `REPRO ${label} window ${window} ${arm}: ` +
        (result.error
          ? `error ${result.error.split("\n")[0]}`
          : result.stalled
            ? `STALLED (no message in 30 s; first page at close: [${result.firstMessagesAtClose ?? []}])`
            : `started after ${started?.afterMs} ms`),
    );
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${label}.json`), JSON.stringify(results, null, 1));
say(summarize(results));
