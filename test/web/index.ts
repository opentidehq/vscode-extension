// The browser test suite's entry: @vscode/test-web loads this bundle (scripts/test-web.mjs builds it) in
// the web extension host and calls run(). Mocha's browser build, bdd UI.
// `require`, not `import`: imported, mocha's UMD wrapper takes over this bundle's `module.exports`.
require("mocha/mocha");

declare const mocha: {
  setup(options: { ui: string; reporter?: unknown; timeout?: number }): void;
  run(done: (failures: number) => void): void;
};

export function run(): Promise<void> {
  try {
    return start();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    throw error;
  }
}

function start(): Promise<void> {
  // The spec reporter: the browser default (HTML) needs a document, which the web extension host has not.
  mocha.setup({ ui: "bdd", reporter: "spec", timeout: 60_000 });
  // Registered after setup: the suite's describe/it are mocha's globals.
  require("./engine.test");
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
  });
}
