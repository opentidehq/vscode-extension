// Mocha `--require`: resolve `import "vscode"` to the stub in test/stubs/vscode.ts, so modules that touch
// a little of the VS Code API load in plain node.
import Module = require("node:module");

import * as path from "node:path";

const stub = path.join(__dirname, "vscode.js");
const moduleWithResolve = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, ...rest: unknown[]): string;
};
const original = moduleWithResolve._resolveFilename;
moduleWithResolve._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]): string {
  if (request === "vscode") return stub;
  return original.call(this, request, parent, ...rest);
};
