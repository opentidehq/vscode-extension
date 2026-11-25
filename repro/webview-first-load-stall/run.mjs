// Runs trial.js in N fresh VS Code windows per arm (each with its own empty user data and extensions folders),
// arms interleaved, and writes every window's result to results/<label>.json, with a summary on stdout.
//
//   node run.mjs --version stable --windows 40 [--arms cut,control,…] [--label linux-stable]
//
// Each window runs with --remote-debugging-port: when its trial says a page has been silent for a while
// (`<out>.silent`), the webview frames are probed over the DevTools protocol (cdp.mjs) and the probe is kept with
// the window's result.
//
// @vscode/test-electron comes from the repository's node_modules (npm ci at the root).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

import { probeWebviews } from "./cdp.mjs";
import { summarize } from "./summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "stable" },
    windows: { type: "string", default: "40" },
    arms: {
      type: "string",
      default: "cut,control,cut-inline,cut-delay,cut-recreate,cut-recreate-5s,cut-recreate-3s",
    },
    port: { type: "string", default: "9333" },
    label: { type: "string" },
  },
});
const windows = Number(values.windows);
const arms = values.arms.split(",").filter(Boolean);
const label = values.label ?? `${process.platform}-${values.version}`;

/**
 * The page's script: its first statement posts `started`, then ~1.2 MB of code to parse, then `ready`. It takes the
 * webview API from the page's inline script when there is one (it can be acquired once).
 */
function bigScript(bytes = 1_200_000) {
  const head =
    "const vscode = globalThis.reproApi ?? acquireVsCodeApi();\n" +
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** While `running` is pending: answer the trial's `<out>.silent` with a probe of the window's webview frames. */
async function answerProbes(out, running, probes) {
  const state = { done: false };
  const finish = () => {
    state.done = true;
  };
  running.then(finish, finish);
  while (!state.done) {
    if (existsSync(`${out}.silent`)) {
      const what = readFileSync(`${out}.silent`, "utf8");
      rmSync(`${out}.silent`, { force: true });
      const began = Date.now();
      probes.push({ what, ms: 0, ...(await probeWebviews(values.port)) });
      probes[probes.length - 1].ms = Date.now() - began;
      writeFileSync(`${out}.probed`, "");
    }
    await sleep(100);
  }
}

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
    const probes = [];
    try {
      const running = runTests({
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
          `--remote-debugging-port=${values.port}`,
        ],
        extensionTestsEnv: { REPRO_ARM: arm, REPRO_OUT: out, REPRO_WINDOW: String(window) },
      });
      await Promise.all([running, answerProbes(out, running, probes)]);
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
    if (probes.length > 0) result.probes = probes;
    results.push(result);
    const started = (result.thirdMessages ?? result.secondMessages)?.find((m) => m.type === "started");
    const seen = (messages) => `[${(messages ?? []).map((m) => m.type).join(",")}]`;
    say(
      `REPRO ${label} window ${window} ${arm}: ` +
        (result.error
          ? `error ${result.error.split("\n")[0]}`
          : result.stalled
            ? `STALLED (first page at close: [${result.firstMessagesAtClose ?? []}]; second ${seen(result.secondMessages)}` +
              `${result.recreated ? `; recreated, third ${seen(result.thirdMessages)}` : ""})`
            : `started after ${started?.afterMs} ms${result.recreated ? " (in the recreated panel)" : ""}`),
    );
    for (const probe of result.probes ?? [])
      say(`REPRO ${label} window ${window} ${arm} probe ${JSON.stringify(probe)}`);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${label}.json`), JSON.stringify(results, null, 1));
say(summarize(results));
