// The language server restarted while it is still starting, a few times over, on each WASI host the label has: the
// launcher, and @vscode/wasm-wasi where ms-vscode.wasm-wasi-core is installed. The floor jobs once hung here: a start
// that never settled held the queue every later start and stop waited in, and the editor features never came back
// (src/core/lsp/bounds.ts). Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as path from "node:path";

import * as vscode from "vscode";

import type { LanguageClientManager } from "../../src/core/services/languageClient";
import { activated, fixture, waitFor } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const ROUNDS = 5;
const OVERLAP_MS = 100;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `work`, or a failure that names `what` when it takes longer than `ms`: a hang must say where, not time the job out. */
async function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("the language server restarted while it is starting", function () {
  this.timeout(10 * 60_000);

  const hosts: ("launcher" | "wasm-wasi")[] = ["launcher"];
  if (vscode.extensions.getExtension("ms-vscode.wasm-wasi-core")) hosts.push("wasm-wasi");

  before(() =>
    vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global),
  );
  afterEach(() =>
    vscode.workspace
      .getConfiguration("opentide.wasi")
      .update("host", undefined, vscode.ConfigurationTarget.Global),
  );
  after(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    const api = await activated();
    await api.ctx.runtime.restart("restart test: done");
  });

  for (const host of hosts) {
    it(`${host}: a start asked for ${OVERLAP_MS} ms after another replaces it, ${ROUNDS} times over`, async () => {
      await vscode.workspace
        .getConfiguration("opentide.wasi")
        .update("host", host, vscode.ConfigurationTarget.Global);
      const api = await activated();
      await within("the restart", 120_000, api.ctx.runtime.restart(`restart test: ${host}`));
      const manager = api.ctx.client as LanguageClientManager;
      const runtime = api.ctx.runtime.current;
      assert.ok(runtime, "a runtime resolved");
      const cwd = api.ctx.folders.all[0]?.path;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const first = manager.start(runtime, cwd);
        await sleep(OVERLAP_MS);
        const second = manager.start(runtime, cwd);
        await within(`round ${round}: the first start`, 120_000, first);
        const client = await within(`round ${round}: the second start`, 120_000, second);
        assert.ok(client, `round ${round}: the second start left a language client`);
      }
      const running = await within("the last start", 60_000, manager.ready());
      assert.ok(running, "a language client runs");
      await waitFor(() => api.ctx.client.current, 30_000);
    });

    it(`${host}: a stop asked for ${OVERLAP_MS} ms into a start returns, and the next restart brings the server back`, async () => {
      await vscode.workspace
        .getConfiguration("opentide.wasi")
        .update("host", host, vscode.ConfigurationTarget.Global);
      const api = await activated();
      await within("the restart", 120_000, api.ctx.runtime.restart(`restart test: ${host}`));
      const manager = api.ctx.client as LanguageClientManager;
      const runtime = api.ctx.runtime.current;
      const cwd = api.ctx.folders.all[0]?.path;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const starting = manager.start(runtime, cwd);
        await sleep(OVERLAP_MS);
        await within(`round ${round}: the stop`, 60_000, manager.stop());
        await within(`round ${round}: the abandoned start`, 60_000, starting);
        await within(
          `round ${round}: the restart after the stop`,
          120_000,
          api.ctx.runtime.restart(`restart test: round ${round}`),
        );
        assert.ok(await within(`round ${round}: ready`, 60_000, manager.ready()), "the server is back");
      }
      // The editor features work again: a rule with a misspelt TLP has a diagnostic.
      const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
      await vscode.window.showTextDocument(uri);
      await waitFor(() => (vscode.languages.getDiagnostics(uri).length > 0 ? true : undefined), 60_000);
    });
  }
});
