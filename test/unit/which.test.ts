// Finding a program on PATH (src/core/runtime/process.ts): one stat per PATH folder and PATHEXT extension, remembered
// while PATH stays the same, and a lookup that never blocks the extension host's thread.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PathLookup, pathCandidates, which } from "../../src/core/runtime/process";

const WIN_PATH = "C:\\Windows;C:\\tools;C:\\Python";
const PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** A filesystem that holds `files`, matched without case on Windows as NTFS does, and counts its stats. */
function fakeFs(files: Iterable<string>, platform: NodeJS.Platform) {
  // Case-insensitive on Windows. Either separator on every platform: the candidates are joined with the separator of
  // the host the tests run on (a Windows runner too), as the lookup does.
  const fold = (file: string) => {
    const slashed = file.replaceAll("\\", "/");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const present = new Set([...files].map(fold));
  const counts = { stats: 0 };
  const exists = (file: string) => {
    counts.stats += 1;
    return present.has(fold(file));
  };
  return {
    counts,
    exists,
    existsAsync: async (file: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      return exists(file);
    },
    add: (file: string) => void present.add(fold(file)),
    remove: (file: string) => void present.delete(fold(file)),
  };
}

describe("PATH lookup", () => {
  describe("candidates", () => {
    it("tries each PATH folder with each PATHEXT extension, once each, in order (Windows)", () => {
      assert.deepEqual(pathCandidates("opentide", "C:\\a;;C:\\b", "win32", ".EXE;.CMD"), [
        path.join("C:\\a", "opentide.exe"),
        path.join("C:\\a", "opentide.cmd"),
        path.join("C:\\b", "opentide.exe"),
        path.join("C:\\b", "opentide.cmd"),
      ]);
    });

    it("tries a name that has an extension as it is first, as Windows does", () => {
      assert.deepEqual(pathCandidates("opentide.exe", "C:\\a", "win32", ".EXE"), [
        path.join("C:\\a", "opentide.exe"),
        path.join("C:\\a", "opentide.exe.exe"),
      ]);
    });

    it("is unchanged on Linux and macOS: each folder, no extension, PATHEXT ignored", () => {
      for (const platform of ["linux", "darwin"] as const) {
        assert.deepEqual(pathCandidates("opentide", "/usr/bin::/opt/bin", platform, ".EXE"), [
          path.join("/usr/bin", "opentide"),
          path.join("/opt/bin", "opentide"),
        ]);
      }
      assert.deepEqual(pathCandidates("opentide", undefined, "linux"), []);
    });
  });

  it("finds an upper-case extension (OPENTIDE.EXE) with one stat per candidate, not one per spelling", () => {
    const disk = fakeFs(["C:\\Python\\OPENTIDE.EXE"], "win32");
    const found = which("opentide", WIN_PATH, "win32", disk.exists, PATHEXT);
    assert.equal(found, path.join("C:\\Python", "opentide.exe"));
    // C:\Windows and C:\tools: four misses each; C:\Python: found at the second extension.
    assert.equal(disk.counts.stats, 4 + 4 + 2);
  });

  it("tries every candidate once for a program that is not installed, and finds nothing", () => {
    const disk = fakeFs([], "win32");
    assert.equal(which("opentide", WIN_PATH, "win32", disk.exists, PATHEXT), undefined);
    assert.equal(disk.counts.stats, 3 * 4, "three folders × four extensions, one stat each");
    const unix = fakeFs([], "linux");
    assert.equal(which("opentide", "/usr/bin:/bin", "linux", unix.exists), undefined);
    assert.equal(unix.counts.stats, 2);
  });

  describe("the cache", () => {
    it("answers a missing program again without a stat, until PATH changes", async () => {
      const disk = fakeFs([], "win32");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      assert.equal(lookup.which("opentide", WIN_PATH, "win32", PATHEXT), undefined);
      assert.equal(disk.counts.stats, 12);
      assert.equal(lookup.which("opentide", WIN_PATH, "win32", PATHEXT), undefined);
      assert.equal(await lookup.whichAsync("opentide", WIN_PATH, "win32", PATHEXT), undefined);
      assert.equal(disk.counts.stats, 12, "remembered, sync and async alike");

      disk.add("C:\\new\\opentide.exe");
      assert.equal(
        lookup.which("opentide", `C:\\new;${WIN_PATH}`, "win32", PATHEXT),
        path.join("C:\\new", "opentide.exe"),
      );
      assert.equal(disk.counts.stats, 14, "a new PATH looks again (.com, then .exe)");
      assert.equal(
        lookup.which("opentide", `C:\\new;${WIN_PATH}`, "win32", ".EXE"),
        path.join("C:\\new", "opentide.exe"),
      );
      assert.equal(disk.counts.stats, 15, "so does a new PATHEXT");
    });

    it("forgets everything on clear (a runtime restart, after the user installed the program)", () => {
      const disk = fakeFs([], "linux");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      assert.equal(lookup.which("opentide", "/usr/bin", "linux"), undefined);
      disk.add("/usr/bin/opentide");
      assert.equal(lookup.which("opentide", "/usr/bin", "linux"), undefined, "still remembered as missing");
      lookup.clear();
      assert.equal(lookup.which("opentide", "/usr/bin", "linux"), path.join("/usr/bin", "opentide"));
    });

    it("checks a program it found again (one stat), and looks again when it is gone", () => {
      const disk = fakeFs(["/a/opentide", "/b/opentide"], "linux");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      assert.equal(lookup.which("opentide", "/a:/b", "linux"), path.join("/a", "opentide"));
      disk.counts.stats = 0;
      assert.equal(lookup.which("opentide", "/a:/b", "linux"), path.join("/a", "opentide"));
      assert.equal(disk.counts.stats, 1);
      disk.remove("/a/opentide");
      assert.equal(lookup.which("opentide", "/a:/b", "linux"), path.join("/b", "opentide"));
    });

    it("keys by name: another program is looked up on its own", () => {
      const disk = fakeFs(["/usr/bin/python3"], "linux");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      assert.equal(lookup.which("opentide", "/usr/bin", "linux"), undefined);
      assert.equal(lookup.which("python3", "/usr/bin", "linux"), path.join("/usr/bin", "python3"));
    });
  });

  describe("off the thread", () => {
    it("answers as the synchronous lookup does, in PATH order, on Windows and Linux", async () => {
      const files = ["C:\\tools\\opentide.CMD", "C:\\Python\\opentide.exe"];
      const disk = fakeFs(files, "win32");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      assert.equal(
        await lookup.whichAsync("opentide", WIN_PATH, "win32", PATHEXT),
        which("opentide", WIN_PATH, "win32", fakeFs(files, "win32").exists, PATHEXT),
      );
      assert.equal(
        await lookup.whichAsync("opentide", WIN_PATH, "win32", PATHEXT),
        path.join("C:\\tools", "opentide.cmd"),
      );
      const long = Array.from({ length: 40 }, (_, i) => `/d${i}`).join(":");
      const unix = fakeFs(["/d33/opentide", "/d35/opentide"], "linux");
      assert.equal(
        await new PathLookup(unix.exists, unix.existsAsync).whichAsync("opentide", long, "linux"),
        path.join("/d33", "opentide"),
      );
      assert.equal(
        await new PathLookup(unix.exists, unix.existsAsync).whichAsync("missing", long, "linux"),
        undefined,
      );
    });

    it("shares one lookup between concurrent callers of the same name", async () => {
      const disk = fakeFs([], "win32");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      const answers = await Promise.all(
        [1, 2, 3].map(() => lookup.whichAsync("opentide", WIN_PATH, "win32", PATHEXT)),
      );
      assert.deepEqual(answers, [undefined, undefined, undefined]);
      assert.equal(disk.counts.stats, 12, "one set of stats for three callers");
    });

    it("does not keep an answer for a PATH that changed (or a clear) while it looked", async () => {
      const disk = fakeFs([], "linux");
      const lookup = new PathLookup(disk.exists, disk.existsAsync);
      const pending = lookup.whichAsync("opentide", "/usr/bin", "linux");
      lookup.clear();
      assert.equal(await pending, undefined, "it answers its caller");
      disk.add("/usr/bin/opentide");
      assert.equal(
        lookup.which("opentide", "/usr/bin", "linux"),
        path.join("/usr/bin", "opentide"),
        "but did not keep it",
      );
    });

    it("finds a real file and misses a missing one, without a synchronous stat", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "which-"));
      try {
        const name = process.platform === "win32" ? "tool.cmd" : "tool";
        fs.writeFileSync(path.join(dir, name), "");
        const lookup = new PathLookup(() => {
          throw new Error("no synchronous stat");
        });
        const envPath = [path.join(dir, "missing"), dir].join(path.delimiter);
        assert.equal(
          await lookup.whichAsync("tool", envPath, process.platform, ".CMD"),
          path.join(dir, name),
        );
        assert.equal(await lookup.whichAsync("absent", envPath, process.platform, ".CMD"), undefined);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
