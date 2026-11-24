import * as assert from "node:assert/strict";

import { directThenHost } from "../../src/engine/reader";

const file = (path: string) => ({ scheme: "file", fsPath: path });

describe("how the engine's feed reads a file (E2)", () => {
  it("reads a file: URI straight from the disk, without the host", async () => {
    const direct: string[] = [];
    const host: string[] = [];
    const read = directThenHost(
      async (fsPath) => {
        direct.push(fsPath);
        return new TextEncoder().encode("a: 1");
      },
      async (uri: { fsPath: string }) => {
        host.push(uri.fsPath);
        return new Uint8Array();
      },
    );
    assert.equal(new TextDecoder().decode(await read(file("/ws/objects/a.yaml"))), "a: 1");
    assert.deepEqual(direct, ["/ws/objects/a.yaml"]);
    assert.deepEqual(host, []);
  });

  it("leaves a virtual file system to the host", async () => {
    const direct: string[] = [];
    const host: string[] = [];
    const read = directThenHost(
      async (fsPath) => {
        direct.push(fsPath);
        return new Uint8Array();
      },
      async (uri: { scheme: string; fsPath: string }) => {
        host.push(`${uri.scheme}:${uri.fsPath}`);
        return new Uint8Array();
      },
    );
    for (const scheme of ["vscode-vfs", "vscode-test-web", "untitled", "vscode-remote"])
      await read({ scheme, fsPath: "/x/y.yaml" });
    assert.deepEqual(direct, []);
    assert.equal(host.length, 4);
  });

  it("passes a read error on, so the feed leaves the file out and says why", async () => {
    const read = directThenHost(
      () => Promise.reject(new Error("ENOENT: no such file")),
      async () => new Uint8Array(),
    );
    await assert.rejects(Promise.resolve(read(file("/ws/objects/gone.yaml"))), /ENOENT/);
  });
});
