#!/usr/bin/env node
// The browser tests: VS Code for the Web (@vscode/test-web) in Chromium, with the built extension and
// test/fixtures/workspace mounted as a virtual folder (`vscode-test-web://mount/`). The suite
// (test/web/) is bundled for the browser into out/test-web/suite.js first.
//   node scripts/test-web.mjs [--quality stable|insiders] [--port <n>]
// Needs `npm run build` (the extension's dist/) and a Playwright Chromium (`npx playwright install
// chromium`, or PLAYWRIGHT_BROWSERS_PATH naming one).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-web";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

/**
 * Mocha's browser build is a UMD script in an ES-module package: bundled, it would see this bundle's
 * `module` and replace its exports (the suite's `run`). Hidden from it, it sets the `mocha` global.
 */
const mochaGlobal = {
  name: "mocha-global",
  setup(build) {
    build.onLoad({ filter: /[\\/]mocha[\\/]mocha\.js$/ }, async (args) => ({
      contents: `(function (module, exports, define) {\n${await readFile(args.path, "utf8")}\n}).call(globalThis);`,
      loader: "js",
    }));
  },
};

const suite = join(root, "out", "test-web", "suite.js");
await esbuild.build({
  bundle: true,
  entryPoints: [join(root, "test", "web", "index.ts")],
  outfile: suite,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["vscode"],
  mainFields: ["browser", "module", "main"],
  plugins: [mochaGlobal],
  logLevel: "warning",
});

try {
  await runTests({
    browserType: "chromium",
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    folderPath: join(root, "test", "fixtures", "workspace"),
    quality: option("--quality", "stable"),
    port: Number(option("--port", "3117")),
    headless: true,
    testRunnerDataDir: join(root, ".vscode-test-web"),
  });
} catch (error) {
  console.error(`browser tests: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
