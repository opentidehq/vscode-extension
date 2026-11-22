// src/core/wasi/launcher.cjs: the module under Node's WASI, where VS Code starts the process itself (MCP,
// tasks, terminals). The layout is tested as it is; the module runs when there is one (OPENTIDE_WASI_MODULE, or
// dist/wasi/ after `npm run build`): `npm run smoke` runs it on every package.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(root, "src", "core", "wasi", "launcher.cjs");
const { layout, moduleEnv, withDirectoryListing } = createRequire(import.meta.url)(launcher);
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
  describe("listing a folder where Node's WASI cannot (fd_readdir answers ENOSYS on Windows)", () => {
    const ENOSYS = 52;
    const SUCCESS = 0;

    /** A host whose `fd_readdir` is not implemented, with a linear memory and the folder `dir` preopened as fd 3. */
    function host(folder) {
      const memory = new DataView(new ArrayBuffer(65536));
      const calls = [];
      const imports = {
        wasi_snapshot_preview1: {
          path_open: (...args) => {
            calls.push(["path_open", ...args]);
            memory.setUint32(args[8], 7, true); // the new fd
            return SUCCESS;
          },
          fd_close: (fd) => {
            calls.push(["fd_close", fd]);
            return SUCCESS;
          },
          fd_readdir: () => ENOSYS,
        },
      };
      withDirectoryListing(imports, [folder], () => memory);
      const ns = imports.wasi_snapshot_preview1;
      const put = (offset, text) => Buffer.from(memory.buffer, offset, Buffer.byteLength(text)).write(text);
      /** Opens `relative` under fd 3 and returns the fd the host gave. */
      const open = (relative) => {
        put(100, relative);
        assert.equal(ns.path_open(3, 0, 100, Buffer.byteLength(relative), 0, 0n, 0n, 0, 200), SUCCESS);
        return memory.getUint32(200, true);
      };
      /** `fd_readdir` into a buffer of `size` bytes at 1000: the entries as [name, type, d_next], and the used bytes. */
      const list = (fd, size, cookie = 0n) => {
        const status = ns.fd_readdir(fd, 1000, size, cookie, 300);
        const used = memory.getUint32(300, true);
        const entries = [];
        let at = 1000;
        while (at + 24 <= 1000 + used) {
          const namlen = memory.getUint32(at + 16, true);
          if (at + 24 + namlen > 1000 + used) break; // a record cut by the buffer's end
          entries.push([
            Buffer.from(memory.buffer, at + 24, namlen).toString("utf8"),
            memory.getUint8(at + 20),
            Number(memory.getBigUint64(at, true)),
          ]);
          at += 24 + namlen;
        }
        return { status, used, entries };
      };
      return { ns, open, list, calls };
    }

    it("lists a folder the module opened, with the types WASI defines", () => {
      mkdirSync(join(dir, "configurations"));
      writeFileSync(join(dir, "configurations", "paths.toml"), "x");
      mkdirSync(join(dir, "configurations", "sub"));
      const { open, list } = host(dir);
      const fd = open("configurations");
      const { status, entries } = list(fd, 4096);
      assert.equal(status, SUCCESS);
      assert.deepEqual(entries, [
        [".", 3, 1],
        ["..", 3, 2],
        ["paths.toml", 4, 3],
        ["sub", 3, 4],
      ]);
    });

    it("lists the preopened folder itself (fd 3)", () => {
      writeFileSync(join(dir, "a.yaml"), "x");
      const { list } = host(dir);
      assert.deepEqual(
        list(3, 4096).entries.map((entry) => entry[0]),
        [".", "..", "a.yaml"],
      );
    });

    it("resumes from the cookie when the buffer is smaller than the folder", () => {
      for (const name of ["a", "b", "c"]) writeFileSync(join(dir, name), "x");
      const { list } = host(dir);
      const seen = [];
      let cookie = 0n;
      for (let round = 0; round < 20; round += 1) {
        // 24 bytes of header and one name byte: room for one record at a time.
        const { used, entries } = list(3, 26, cookie);
        if (used === 0) break;
        for (const [name, , next] of entries) {
          seen.push(name);
          cookie = BigInt(next);
        }
      }
      assert.deepEqual(seen, [".", "..", "a", "b", "c"]);
    });

    it("answers the end of the folder with no bytes", () => {
      const { list } = host(dir);
      assert.equal(list(3, 4096, 2n).used, 0);
    });

    it("leaves a folder it does not know, and a host that lists, alone", () => {
      const { ns } = host(dir);
      assert.equal(
        ns.fd_readdir(9, 1000, 100, 0n, 300),
        ENOSYS,
        "an fd the module never opened under a preopen",
      );
      const listing = {
        wasi_snapshot_preview1: {
          path_open: () => SUCCESS,
          fd_close: () => SUCCESS,
          fd_readdir: () => SUCCESS,
        },
      };
      withDirectoryListing(listing, [dir], () => new DataView(new ArrayBuffer(16)));
      assert.equal(
        listing.wasi_snapshot_preview1.fd_readdir(3, 0, 0, 0n, 0),
        SUCCESS,
        "Node's own answer stands",
      );
    });

    it("forgets a folder when the module closes it", () => {
      const { ns, open } = host(dir);
      const fd = open(".");
      assert.equal(ns.fd_close(fd), SUCCESS);
      assert.equal(ns.fd_readdir(fd, 1000, 100, 0n, 300), ENOSYS);
    });
  });
});
