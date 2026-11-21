// src/core/wasi/launcher.cjs: the module under Node's WASI, where VS Code starts the process itself (MCP,
// tasks, terminals). The layout is tested as it is; the module runs when there is one (OPENTIDE_WASI_MODULE, or
// dist/wasi/ after `npm run build`): `npm run smoke` runs it on every package.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(root, "src", "core", "wasi", "launcher.cjs");
const { layout, moduleEnv } = createRequire(import.meta.url)(launcher);
const MODULE = process.env.OPENTIDE_WASI_MODULE ?? join(root, "dist", "wasi", "opentide.wasm");

describe("the WASI launcher", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wasi-launcher-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("preopens the working directory where it is on POSIX, and /workspace on Windows", () => {
    const posix = layout(dir, {}, "linux");
    assert.equal(posix.preopens[dir], dir);
    assert.equal(posix.env.PWD, dir);
    assert.ok(posix.preopens["/tmp"]);
    const windows = layout("C:\\Users\\me\\detections", {}, "win32");
    assert.deepEqual(windows.preopens, { "/workspace": "C:\\Users\\me\\detections" });
    assert.equal(windows.env.PWD, "/workspace");
  });

  it("preopens the repository root when it is another folder, and names the guest path in the variable", () => {
    const other = mkdtempSync(join(tmpdir(), "wasi-launcher-repo-"));
    try {
      const posix = layout(dir, { OPENTIDE_REPO_ROOT: other }, "linux");
      assert.equal(posix.preopens[other], other);
      assert.equal(posix.env.OPENTIDE_REPO_ROOT, other);
      // The working directory itself: nothing more to mount.
      assert.equal(layout(dir, { OPENTIDE_REPO_ROOT: dir }, "linux").env.OPENTIDE_REPO_ROOT, dir);
      assert.equal(
        layout("C:\\w", { OPENTIDE_REPO_ROOT: "C:\\w" }, "win32").env.OPENTIDE_REPO_ROOT,
        "/workspace",
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("mounts what the extension host names (OPENTIDE_WASI_MOUNTS), every folder of the window", () => {
    const mounts = JSON.stringify([
      { host: "/a/one", guest: "/workspaces/one" },
      { host: "/b/two", guest: "/workspaces/two" },
    ]);
    const posix = layout("/ignored", { OPENTIDE_WASI_MOUNTS: mounts, OPENTIDE_REPO_ROOT: "/x" }, "linux");
    assert.equal(posix.preopens["/workspaces/one"], "/a/one");
    assert.equal(posix.preopens["/workspaces/two"], "/b/two");
    assert.equal(posix.env.PWD, "/workspaces/one");
    assert.equal(posix.preopens["/ignored"], undefined);
    // Not a list of mounts: the working directory is mounted as without it.
    for (const bad of ["not json", "[]", '[{"host":1}]', '[{"host":"/a","guest":"a"}]'])
      assert.equal(layout(dir, { OPENTIDE_WASI_MOUNTS: bad }, "linux").preopens[dir], dir, bad);
  });

  it("does not hand the module the variables that are the launcher's", () => {
    assert.deepEqual(
      moduleEnv({
        ELECTRON_RUN_AS_NODE: "1",
        OPENTIDE_WASI_MOUNTS: "[]",
        OPENTIDE_PROXY: "p",
        GONE: undefined,
      }),
      { OPENTIDE_PROXY: "p" },
    );
  });

  it("says how to use it, and fails clearly for a module that is none", () => {
    const usage = spawnSync(process.execPath, [launcher], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: launcher.cjs/);
    const bad = spawnSync(process.execPath, [launcher, join(dir, "missing.wasm")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /opentide \(WASI\):/);
  });

  describe("with the module", () => {
    before(function () {
      if (!existsSync(MODULE)) this.skip();
    });
    const run = (args, options = {}) =>
      spawnSync(process.execPath, ["--no-turbo-fast-api-calls", launcher, MODULE, ...args], {
        encoding: "utf8",
        cwd: dir,
        ...options,
      });

    it("runs a command, prints as the CLI does and exits with its code", () => {
      const version = run(["--version"]);
      assert.equal(version.status, 0, version.stderr);
      assert.match(version.stdout, /^opentide \d+\.\d+\.\d+/);
      // No Node warning on stderr, which an MCP client or a terminal would show.
      assert.equal(version.stderr, "");
      const usage = run(["--json", "no-such-command"]);
      assert.notEqual(usage.status, 0);
    });

    it("sees the working directory as it is, and serves over stdio with opentide/fetch on request", () => {
      const info = run(["--json", "info"]);
      assert.equal(info.status, 0, info.stderr);
      assert.equal(JSON.parse(info.stdout).repo, dir);
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { fetch: true } } },
        { jsonrpc: "2.0", id: 2, method: "shutdown" },
        { jsonrpc: "2.0", method: "exit" },
      ]
        .map((message) => `${JSON.stringify(message)}\n`)
        .join("");
      const served = run(["serve"], { input });
      assert.equal(served.status, 0, served.stderr);
      const first = JSON.parse(served.stdout.split("\n")[0]);
      assert.equal(first.result.protocol, 1);
      assert.equal(first.result.capabilities.fetch, true);
    });

    it("runs the language server over stdio with Content-Length framing, in the workspace it was started in", () => {
      const frame = (message) => {
        const body = JSON.stringify(message);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      };
      const uri = `file://${dir}`;
      const input = [
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { processId: null, rootUri: uri, workspaceFolders: [{ uri, name: "w" }], capabilities: {} },
        }),
        frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }),
        frame({ jsonrpc: "2.0", method: "exit" }),
      ].join("");
      const served = run(["lsp", "start"], { input });
      assert.equal(served.status, 0, served.stderr);
      const header = /^Content-Length: (\d+)\r\n\r\n/.exec(served.stdout);
      assert.ok(header, served.stdout.slice(0, 200));
      const start = header[0].length;
      const initialize = JSON.parse(served.stdout.slice(start, start + Number(header[1])));
      assert.equal(initialize.id, 1);
      assert.equal(initialize.result.serverInfo.name, "opentide-lsp");
      assert.equal(initialize.result.capabilities.experimental.opentide.host.name, "opentide");
    });
  });
});
