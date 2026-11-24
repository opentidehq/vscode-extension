// A restart that lands while `opentide serve` is busy, on each WASI host the label has: the launcher, and
// @vscode/wasm-wasi where ms-vscode.wasm-wasi-core is installed. Under wasm-wasi-core 1.0.4 `terminate()` kills the
// worker but never settles `run()`, so the exit of a serve the extension had to kill (it was mid-run and ignored
// `shutdown`) was never reported, `backend.restart()` waited for ever and every later restart behind it
// (src/core/wasi/exit.ts). Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as path from "node:path";

import * as vscode from "vscode";

import { activated } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const ROUNDS = 5;
/** Into the run: long enough that the serve is working when the restart arrives, short enough to land mid-run. */
const BUSY_MS = 130;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `work`, or a failure that names `what` after `ms`: a hang must say where, not time the job out. */
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

describe("a restart while opentide serve is busy", function () {
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
    await api.ctx.runtime.restart("busy restart test: done");
  });

  for (const host of hosts) {
    it(`${host}: ${ROUNDS} restarts ${BUSY_MS} ms into a run each finish, and the serve answers afterwards`, async () => {
      await vscode.workspace
        .getConfiguration("opentide.wasi")
        .update("host", host, vscode.ConfigurationTarget.Global);
      const api = await activated();
      await within("the first restart", 120_000, api.ctx.runtime.restart(`busy restart test: ${host}`));
      const folder = api.ctx.folders.all[0];
      assert.ok(folder, "the fixture workspace has an opentide folder");
      for (let round = 1; round <= ROUNDS; round += 1) {
        // A run that takes a while (it validates the workspace), left to end however it ends: the restart cancels it.
        const busy = api.ctx.backend.run(folder.path, ["validate"]).then(
          () => "finished",
          () => "ended",
        );
        await sleep(BUSY_MS);
        await within(
          `round ${round}: the restart`,
          120_000,
          api.ctx.runtime.restart(`busy restart test: round ${round}`),
        );
        await within(`round ${round}: the run that was going`, 60_000, busy);
        const answer = await within(
          `round ${round}: a command after the restart`,
          120_000,
          api.ctx.backend.run(folder.path, ["explain", "vocab_unknown"]),
        );
        assert.ok(answer.document, `round ${round}: the serve answers`);
      }
      assert.ok(
        await within("the language client", 60_000, api.ctx.client.ready()),
        "the language server runs",
      );
    });
  }
});
