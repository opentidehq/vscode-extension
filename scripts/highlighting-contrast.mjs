#!/usr/bin/env node
// The highlighting contrast gate's data (test/scripts/highlighting-contrast.test.mjs):
//   node scripts/highlighting-contrast.mjs capture <opentide>   the server's semantic tokens for the samples, from a real
//                                                                `opentide lsp start` (rerun when pins.json's highlights move)
//   node scripts/highlighting-contrast.mjs baseline             write the grammar-only plain share the gate ratchets on
//   node scripts/highlighting-contrast.mjs report               print every theme x language x token type
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  contrast,
  DEFAULT_THEMES,
  languageOfSample,
  mainColour,
  measure,
  plainShare,
  semanticFailures,
} from "./highlighting-contrast-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures", "highlighting");
const samples = join(fixtures, "samples");
const snapshotPath = join(fixtures, "semantic-tokens.json");
const baselinePath = join(fixtures, "baseline.json");

/** The sample files, as `yaml/<name>` and `query/<name>`. */
export function sampleNames() {
  return ["yaml", "query"]
    .flatMap((dir) => readdirSync(join(samples, dir)).map((name) => `${dir}/${name}`))
    .sort();
}

async function capture(bin) {
  const server = spawn(bin, ["lsp", "start"], { cwd: samples, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    server.stdin.write(body);
  };
  server.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const header = buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
      if (buffer.length < header + 4 + length) return;
      const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
      buffer = buffer.subarray(header + 4 + length);
      if (message.method && message.id !== undefined) send({ id: message.id, result: null });
      else if (pending.has(message.id)) pending.get(message.id)(message);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const folder = pathToFileURL(samples).href;
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: folder,
    workspaceFolders: [{ uri: folder, name: "samples" }],
    capabilities: {
      textDocument: {
        semanticTokens: {
          requests: { full: true },
          tokenTypes: [],
          tokenModifiers: [],
          formats: ["relative"],
        },
      },
    },
  });
  if (!init.result) throw new Error(`initialize: ${JSON.stringify(init)}`);
  const legend = init.result.capabilities.semanticTokensProvider.legend;
  send({ method: "initialized", params: {} });
  const files = {};
  for (const name of sampleNames()) {
    const uri = pathToFileURL(join(samples, name)).href;
    const text = readFileSync(join(samples, name), "utf8");
    send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: languageOfSample(name), version: 1, text } },
    });
    const { result } = await request("textDocument/semanticTokens/full", { textDocument: { uri } });
    const data = result?.data ?? [];
    const tokens = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
      tokens.push([line, character, data[i + 2], legend.tokenTypes[data[i + 3]]]);
    }
    files[name] = tokens;
  }
  await request("shutdown");
  send({ method: "exit" });
  server.stdin.end();
  const snapshot = {
    $comment:
      "Written by `node scripts/highlighting-contrast.mjs capture <opentide>`. [line, character, length, type] per token.",
    server: init.result.serverInfo,
    files,
  };
  const lines = Object.entries(files).map(
    ([name, tokens]) => `    ${JSON.stringify(name)}: ${JSON.stringify(tokens)}`,
  );
  writeFileSync(
    snapshotPath,
    `{\n  "$comment": ${JSON.stringify(snapshot.$comment)},\n  "server": ${JSON.stringify(snapshot.server)},\n  "files": {\n${lines.join(",\n")}\n  }\n}\n`,
  );
  console.log(
    `wrote ${snapshotPath.slice(root.length + 1)} from ${snapshot.server.name} ${snapshot.server.version}`,
  );
}

export async function measureDefaults() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  return measure({
    root,
    pkg,
    themesDir: join(fixtures, "themes"),
    themes: DEFAULT_THEMES,
    samples,
    snapshot,
  });
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === "capture" && arg) return capture(arg);
  if (command === "baseline") {
    const share = plainShare(await measureDefaults(), "textmate");
    const rounded = Object.fromEntries(
      Object.entries(share)
        .sort()
        .map(([g, s]) => [g, Math.ceil(s * 1000) / 1000]),
    );
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ $comment: "The most of a group's meaningful tokens the grammars alone may leave in the default foreground, in any default theme. `node scripts/highlighting-contrast.mjs baseline` writes it; lower it as opentide's grammars improve.", textmate: rounded }, null, 2)}\n`,
    );
    console.log(`wrote ${baselinePath.slice(root.length + 1)}`);
    return;
  }
  if (command === "report") {
    const rows = await measureDefaults();
    for (const r of rows) {
      const tm = mainColour(r.textmate);
      const sem = mainColour(r.semantic);
      console.log(
        [
          r.theme.label,
          r.group,
          r.type,
          r.n,
          `${tm} ${contrast(tm, r.theme.background).toFixed(2)}`,
          `${sem} ${contrast(sem, r.theme.background).toFixed(2)}`,
        ].join(" | "),
      );
    }
    const failures = semanticFailures(rows);
    console.log(`\n${failures.length} failure(s)`);
    for (const f of failures) console.log(f);
    return;
  }
  console.error("usage: highlighting-contrast.mjs capture <opentide> | baseline | report");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
