// Times `opentide lsp start` under dist/wasi/launcher.cjs the way the extension runs it: spawn -> `initialize` answered ->
// diagnostics for the first document opened, and a second document in the same process. Docs/PACKAGING.md, "Cold start".
//
//   node scripts/bench-lsp-cold-start.mjs <dist> <fixture workspace> [extra rules=0] [runs=5] [idle ms before the first document=0] [node flags...]
//   WARMDOC=1   opens, analyses and closes a synthetic rule first (the warm-up that was tried and dropped: PACKAGING.md)
//   WARM=symbol|catalog|docsymbol   sends that request first instead
//
// <dist> is an unpacked extension's dist/ (it needs dist/wasi/); the fixture is test/fixtures/workspace. Prints one JSON line.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , dist, fixtures, count = "0", repeat = "5", settle = "0", ...nodeFlags] = process.argv;
const launcher = join(dist, "wasi", "launcher.cjs");
const wasm = join(dist, "wasi", "opentide.wasm");
const ws = mkdtempSync(join(tmpdir(), "bench-ws-"));
cpSync(join(fixtures, "objects"), join(ws, "objects"), { recursive: true });
const rulesDir = join(ws, "objects", "rules");
const sample = readdirSync(rulesDir)[0];
const text = readFileSync(join(rulesDir, sample), "utf8");
for (let i = 0; i < Number(count); i++) {
  const uuid = `6b2e9c14-7a31-4f58-9d0c-${String(i).padStart(12, "0")}`;
  writeFileSync(join(rulesDir, `gen-${i}.yaml`), text.replace(/uuid: [0-9a-f-]+/, `uuid: ${uuid}`));
}
mkdirSync(join(ws, ".opentide", "configurations"), { recursive: true });
const target = join(rulesDir, sample);

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
async function once() {
  const t0 = performance.now();
  const child = spawn(process.execPath, [...nodeFlags, launcher, wasm, "lsp", "start"], {
    cwd: ws,
    env: {
      ...process.env,
      OPENTIDE_REPO_ROOT: ws,
      OPENTIDE_WASI_MOUNTS: JSON.stringify([{ host: ws, guest: ws }]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = Buffer.alloc(0);
  const waiters = [];
  let peak = 0;
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
      if (buf.length < sep + 4 + len) break;
      const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
      buf = buf.subarray(sep + 4 + len);
      for (const w of [...waiters])
        if (w.test(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
    }
  });
  child.stderr.on("data", () => {});
  const wait = (test) => new Promise((resolve) => waiters.push({ test, resolve }));
  const send = (m) => child.stdin.write(frame(m));
  const rootUri = pathToFileURL(ws).href;
  const init = wait((m) => m.id === 1);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri,
      capabilities: { textDocument: { publishDiagnostics: {} }, workspace: {} },
      workspaceFolders: [{ uri: rootUri, name: "ws" }],
    },
  });
  await init;
  const tInit = performance.now() - t0;
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  const uri = pathToFileURL(target).href;
  // `settle` ms between `initialized` and the first document: what a server started at activation has before a document opens.
  if (Number(settle) > 0) await new Promise((r) => setTimeout(r, Number(settle)));
  let tWarm = 0;
  const warm = process.env.WARM;
  if (warm) {
    const tw = performance.now();
    const answer = wait((m) => m.id === 50);
    if (warm === "symbol")
      send({ jsonrpc: "2.0", id: 50, method: "workspace/symbol", params: { query: "" } });
    else if (warm === "catalog") send({ jsonrpc: "2.0", id: 50, method: "opentide/catalog", params: {} });
    else if (warm === "docsymbol")
      send({
        jsonrpc: "2.0",
        id: 50,
        method: "textDocument/documentSymbol",
        params: { textDocument: { uri: pathToFileURL(target).href } },
      });
    await answer;
    tWarm = performance.now() - tw;
  }
  if (process.env.WARMDOC) {
    // a synthetic document that is not a file: opened, analysed, closed
    const tw = performance.now();
    const wuri = pathToFileURL(join(rulesDir, ".opentide-warmup.yaml")).href;
    const wdiag = wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === wuri);
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: wuri, languageId: "opentide-yaml", version: 1, text } },
    });
    await wdiag;
    send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: wuri } } });
    tWarm = performance.now() - tw;
  }
  const tOpen = performance.now();
  const diag = wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri);
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "opentide-yaml", version: 1, text } },
  });
  await diag;
  const tDiag = performance.now() - t0;
  const tOpenToDiag = performance.now() - tOpen;
  // a second document in the same process: the warm cost
  const second = join(rulesDir, "second-open.yaml");
  const uri2 = pathToFileURL(second).href;
  const text2 = text.replace(/uuid: [0-9a-f-]+/, "uuid: 7b2e9c14-7a31-4f58-9d0c-ffffffffffff");
  const t1 = performance.now();
  const diag2 = wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri2);
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: uri2, languageId: "opentide-yaml", version: 1, text: text2 } },
  });
  await diag2;
  const tSecond = performance.now() - t1;
  // peak RSS of the child, from /proc when there is one
  try {
    peak = Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
  } catch {}
  send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  send({ jsonrpc: "2.0", method: "exit" });
  await new Promise((r) => child.on("close", r));
  return { tInit, tDiag, tSecond, tOpenToDiag, tWarm, peak };
}
const rows = [];
for (let i = 0; i < Number(repeat); i++) rows.push(await once());
const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(
  JSON.stringify({
    files: Number(count) + 1,
    flags: nodeFlags.join(" ") || "none",
    initializeMs: rows.map((r) => Math.round(r.tInit)),
    firstDiagnosticsMs: rows.map((r) => Math.round(r.tDiag)),
    medianInit: Math.round(med(rows.map((r) => r.tInit))),
    medianDiag: Math.round(med(rows.map((r) => r.tDiag))),
    warmRequestMs: rows.map((r) => Math.round(r.tWarm)),
    openToDiagnosticsMs: rows.map((r) => Math.round(r.tOpenToDiag)),
    secondDocMs: rows.map((r) => Math.round(r.tSecond)),
    peakRssMB: Math.round(med(rows.map((r) => r.peak))),
  }),
);
