import * as assert from "node:assert/strict";
import {
  GuestPaths,
  guestPathOf,
  launcherMounts,
  type Mount,
  rewriteStrings,
} from "../../../src/core/wasi/paths";

const POSIX: Mount = {
  host: "/home/me/detections",
  hostUri: "file:///home/me/detections",
  guest: "/workspace",
  guestUri: "file:///workspace",
};
const WINDOWS: Mount = {
  host: "c:\\Users\\me\\detections",
  hostUri: "file:///c%3A/Users/me/detections",
  guest: "/workspace",
  guestUri: "file:///workspace",
};

describe("WASI guest paths (src/core/wasi/paths.ts)", () => {
  it("names the guest folder: /workspace for the only folder, /workspaces/<name> for several", () => {
    assert.equal(guestPathOf("detections", true), "/workspace");
    assert.equal(guestPathOf("detections", false), "/workspaces/detections");
  });

  it("rewrites a path that starts with a mounted folder, at a separator or the end", () => {
    const paths = new GuestPaths([POSIX], "linux");
    assert.equal(paths.toGuest("/home/me/detections"), "/workspace");
    assert.equal(
      paths.toGuest("/home/me/detections/objects/rules/a.yaml"),
      "/workspace/objects/rules/a.yaml",
    );
    assert.equal(paths.toHost("/workspace/objects/rules/a.yaml"), "/home/me/detections/objects/rules/a.yaml");
    // Another folder with the same prefix, or the name inside another path, is left alone.
    assert.equal(paths.toGuest("/home/me/detections-old/a.yaml"), "/home/me/detections-old/a.yaml");
    assert.equal(paths.toHost("/workspaces/a/b"), "/workspaces/a/b");
    assert.equal(paths.toHost("/other/workspace/a"), "/other/workspace/a");
    assert.equal(paths.toGuest("/elsewhere/a.yaml"), "/elsewhere/a.yaml");
  });

  it("maps a run's argv, cwd and environment to guest paths, and a document back", () => {
    const paths = new GuestPaths([POSIX], "linux");
    const params = {
      argv: ["validate", "--file", "/home/me/detections/objects/a.yaml", "--repo=/home/me/detections", "x"],
      cwd: "/home/me/detections",
      env: { OPENTIDE_REPO_ROOT: "/home/me/detections", TOKEN: "abc" },
    };
    assert.deepEqual(paths.paramsToGuest(params), {
      argv: ["validate", "--file", "/workspace/objects/a.yaml", "--repo=/workspace", "x"],
      cwd: "/workspace",
      env: { OPENTIDE_REPO_ROOT: "/workspace", TOKEN: "abc" },
    });
    const document = {
      repo: "/workspace",
      issues: [
        {
          file_path: "/workspace/objects/a.yaml",
          path: "objects/a.yaml",
          message: "bad /workspace/objects/a.yaml: x",
        },
      ],
      n: 3,
      ok: true,
      none: null,
    };
    assert.deepEqual(paths.documentToHost(document), {
      repo: "/home/me/detections",
      issues: [
        {
          file_path: "/home/me/detections/objects/a.yaml",
          path: "objects/a.yaml",
          message: "bad /home/me/detections/objects/a.yaml: x",
        },
      ],
      n: 3,
      ok: true,
      none: null,
    });
  });

  it("keeps several folders apart: /workspaces/<name> for each", () => {
    const paths = new GuestPaths(
      [
        {
          host: "/a/one",
          hostUri: "file:///a/one",
          guest: "/workspaces/one",
          guestUri: "file:///workspaces/one",
        },
        {
          host: "/b/two",
          hostUri: "file:///b/two",
          guest: "/workspaces/two",
          guestUri: "file:///workspaces/two",
        },
      ],
      "linux",
    );
    assert.equal(paths.toGuest("/b/two/objects/x.yaml"), "/workspaces/two/objects/x.yaml");
    assert.equal(paths.toHost("/workspaces/one/y.yaml"), "/a/one/y.yaml");
    assert.equal(paths.mounted("/a/one/objects"), true);
    assert.equal(paths.mounted("/a/other"), false);
  });

  it("maps the language server's URIs and rootPath both ways", () => {
    const paths = new GuestPaths([POSIX], "linux");
    const initialize = {
      method: "initialize",
      params: {
        rootPath: "/home/me/detections",
        rootUri: "file:///home/me/detections",
        workspaceFolders: [{ uri: "file:///home/me/detections", name: "detections" }],
        textDocument: { uri: "file:///home/me/detections/objects/a.yaml" },
      },
    };
    const guest = paths.lspToGuest(initialize);
    assert.deepEqual(guest.params, {
      rootPath: "/workspace",
      rootUri: "file:///workspace",
      workspaceFolders: [{ uri: "file:///workspace", name: "detections" }],
      textDocument: { uri: "file:///workspace/objects/a.yaml" },
    });
    assert.deepEqual(paths.lspToHost(guest), initialize);
    // A document outside every folder keeps its URI.
    assert.equal(paths.lspToGuest({ uri: "untitled:Untitled-1" }).uri, "untitled:Untitled-1");
  });

  it("on Windows, host paths have backslashes and guest paths slashes", () => {
    const paths = new GuestPaths([WINDOWS], "win32");
    assert.equal(paths.toGuest("c:\\Users\\me\\detections\\objects\\a.yaml"), "/workspace/objects/a.yaml");
    assert.equal(paths.toHost("/workspace/objects/a.yaml"), "c:\\Users\\me\\detections\\objects\\a.yaml");
    assert.equal(paths.toHost("/workspace"), "c:\\Users\\me\\detections");
    assert.equal(
      paths.lspToGuest({ uri: "file:///c%3A/Users/me/detections/objects/a.yaml" }).uri,
      "file:///workspace/objects/a.yaml",
    );
    assert.equal(paths.mounted("c:\\Users\\me\\detections\\objects"), true);
  });

  it("changes nothing without a mount, and leaves keys alone", () => {
    assert.deepEqual(rewriteStrings({ "/workspace": "/workspace/a" }, []), { "/workspace": "/workspace/a" });
    const paths = new GuestPaths([POSIX], "linux");
    assert.deepEqual(paths.documentToHost({ "/workspace": "/workspace/a" }), {
      "/workspace": "/home/me/detections/a",
    });
  });

  it("mounts the launcher's folders where they are on POSIX, and /workspace or /workspaces/<name> on Windows", () => {
    const folders = [
      { name: "one", fsPath: "/a/one", uri: "file:///a/one" },
      { name: "two", fsPath: "/b/two", uri: "file:///b/two" },
    ];
    const uri = (path: string) => `file://${path}`;
    assert.deepEqual(
      launcherMounts(folders, "linux", uri).map(({ host, guest, guestUri }) => [host, guest, guestUri]),
      [
        ["/a/one", "/a/one", "file:///a/one"],
        ["/b/two", "/b/two", "file:///b/two"],
      ],
    );
    const win = [{ name: "one", fsPath: "c:\\w\\one", uri: "file:///c%3A/w/one" }];
    assert.equal(launcherMounts(win, "win32", uri)[0]?.guest, "/workspace");
    assert.deepEqual(
      launcherMounts(
        [...win, { name: "two", fsPath: "c:\\w\\two", uri: "file:///c%3A/w/two" }],
        "win32",
        uri,
      ).map((mount) => mount.guest),
      ["/workspaces/one", "/workspaces/two"],
    );
    // On POSIX the module's paths are the host's: mapping changes nothing.
    const paths = new GuestPaths(launcherMounts(folders, "linux", uri), "linux");
    assert.equal(paths.toGuest("/a/one/objects/x.yaml"), "/a/one/objects/x.yaml");
    assert.equal(paths.toHost("/b/two/y.yaml"), "/b/two/y.yaml");
  });
});
