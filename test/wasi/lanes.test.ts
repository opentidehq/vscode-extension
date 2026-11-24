// Two serve lanes on tier 4 (the bundled WASI module): a slow tenant request on the long lane does not hold up what the
// editor asks while you work. The module's `opentide/fetch` is answered by a stub that waits 10 s (the extension
// host's FetchHost with `perform` replaced, ExtensionApi.stubWasiFetch). `doctor` contacts the network for its release
// check (one `opentide/fetch`) and is classified as contacting a tenant, so it runs on the long lane; meanwhile the
// catalogue refresh (`info catalog`) and validate-on-save (`validate`) answer on the interactive one.
import * as assert from "node:assert/strict";
import * as path from "node:path";

import * as vscode from "vscode";

import { activated, waitFor } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const HOLD_MS = 10_000;

describe("serve lanes on the bundled opentide (tier 4)", function () {
  this.timeout(2 * 60_000);
  let fetches = 0;

  before(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global);
    const api = await activated();
    api.stubWasiFetch((params, signal) => {
      fetches += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              status: 200,
              headers: [["content-type", "application/json"]],
              url: params.url,
              body: Buffer.from(JSON.stringify({ info: { version: "1.0.0rc4" }, releases: {} })).toString(
                "base64",
              ),
              elapsed_ms: HOLD_MS,
            }),
          HOLD_MS,
        );
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { kind: "aborted" }));
        });
      });
    });
    // New serve processes, so the long lane's answers its tenant requests with the stub.
    await api.ctx.runtime.restart("lanes test");
  });

  after(async () => {
    const api = await activated();
    api.stubWasiFetch(undefined);
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    await api.ctx.runtime.restart("lanes test: done");
  });

  it("answers the catalogue and validate in under 1 s while a tenant request holds a long command for 10 s", async () => {
    const api = await activated();
    assert.equal(api.ctx.runtime.current?.source, "wasi", JSON.stringify(api.ctx.runtime.attempts));
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const backend = api.ctx.backend;
    // Warm: the interactive serve is up and has read the workspace once.
    assert.equal((await backend.run(folder.path, ["info", "catalog"])).exitCode, 0);
    await backend.run(folder.path, ["validate"]);
    assert.deepEqual(
      backend.lanesRunning,
      { interactive: true, long: false },
      "the long lane starts only when needed",
    );

    const startedAt = Date.now();
    let doctorDone = false;
    const doctor = backend.run(folder.path, ["doctor"]).finally(() => {
      doctorDone = true;
    });
    await waitFor(() => (fetches > 0 ? true : undefined), 30_000);
    assert.equal(backend.lanesRunning.long, true);

    for (const argv of [["info", "catalog"], ["validate"]]) {
      const began = Date.now();
      const result = await backend.run(folder.path, argv);
      const took = Date.now() - began;
      assert.ok(took < 1000, `${argv.join(" ")} took ${took} ms while doctor waited for its tenant`);
      assert.equal(result.via, "serve");
    }
    assert.equal(doctorDone, false, "doctor is still waiting for its tenant request");

    const result = await doctor;
    assert.equal(result.via, "serve");
    assert.ok(Date.now() - startedAt >= HOLD_MS - 500, `doctor ended after ${Date.now() - startedAt} ms`);
  });
});
