// A stand-in for the `vscode` module, so a bundle that needs it can be required in plain node: the bench of the
// extension's start-up (bench-require.mjs) and the smoke test of dist/lsp.js (smoke.mjs). It answers any property
// with something callable and constructible, and lists the API's names as own properties, because a bundle
// copies the properties of what `require("vscode")` returns.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The runtime names of the `vscode` API (classes, enums, namespaces, functions), from @types/vscode. */
export function vscodeNames() {
  const text = readFileSync(join(root, "node_modules", "@types", "vscode", "index.d.ts"), "utf8");
  const names = new Set();
  for (const match of text.matchAll(
    /^\texport (?:abstract )?(?:class|enum|namespace|function|const) (\w+)/gm,
  ))
    names.add(match[1]);
  return [...names];
}

/** Installed first in the child: `require("vscode")` answers the stand-in. */
const PRELUDE = `
const Module = require("node:module");
const stand = (name) => {
  const children = new Map();
  const self = new Proxy(function () {}, {
    get: (target, key) => {
      if (key === "prototype") return target.prototype;
      if (key === Symbol.toPrimitive) return undefined;
      if (!children.has(key)) children.set(key, stand(String(key)));
      return children.get(key);
    },
    apply: () => self,
    construct: () => self,
    has: () => true,
  });
  return self;
};
const vscode = Object.fromEntries(JSON.parse(process.env.VSCODE_NAMES).map((name) => [name, stand(name)]));
const original = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : original.call(this, request, ...rest); };
`;

/**
 * Runs `body` (JavaScript, CommonJS) in a fresh node process with the stand-in installed; `process.argv[1]` is `arg`.
 * Returns the spawn result: `stdout` is what the body printed.
 */
export function runWithStandIn(body, arg) {
  return spawnSync(process.execPath, ["-e", PRELUDE + body, arg], {
    encoding: "utf8",
    env: { ...process.env, VSCODE_NAMES: JSON.stringify(vscodeNames()) },
  });
}

/** The first line of a failed child's stderr that names an error (the rest is a code frame). */
export function failure(result) {
  return (result.stderr.match(/^\w*Error.*$/m) ?? [result.stderr.slice(-300)])[0];
}
