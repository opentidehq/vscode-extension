// Finding a program on PATH, as the runtime resolution, the terminal integration and the MCP check do. On Windows a
// lookup tries every PATH folder with every PATHEXT extension, so a program that is not installed costs one stat per
// pair. Measured here in the extension host, with its real PATH: the line printed shows the count on each OS.
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { isFile, which } from "../../src/core/runtime/process";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

describe("PATH lookup", () => {
  it("says how many stats, and how long, a lookup of a program that is not installed takes", () => {
    const envPath = process.env.PATH ?? "";
    const dirs = envPath.split(path.delimiter).filter(Boolean).length;
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).length
        : 1;
    let stats = 0;
    const counted = (file: string): boolean => {
      stats += 1;
      return isFile(file);
    };
    const began = performance.now();
    const found = which("opentide-not-installed", envPath, process.platform, counted);
    const ms = performance.now() - began;
    assert.equal(found, undefined);
    say(
      `WHICH platform=${process.platform} dirs=${dirs} extensions=${extensions} stats=${stats} ` +
        `ms=${ms.toFixed(1)} (one uncached lookup of a missing program)`,
    );
    assert.ok(stats >= dirs * extensions, "every folder and extension is tried");
  });
});
