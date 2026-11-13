// Pure helpers for scripts/smoke.mjs: the checks on the engine (WASM) and the web extension a package
// carries (SPEC §3 "Smoke test").

export class SmokeError extends Error {}

/**
 * The engine (WASM) worker's `initialize`: the server is opentide-lsp at the version dist/engine/engine.json
 * records, hosted by nothing, and the worker ended after `exit`.
 */
export function checkEngineInitialize(response, version, exitCode) {
  const errors = [];
  const result = response?.result;
  if (!result)
    return [`engine initialize failed: ${JSON.stringify(response?.error ?? response).slice(0, 300)}`];
  if (result.serverInfo?.name !== "opentide-lsp")
    errors.push(`engine serverInfo.name is ${result.serverInfo?.name}`);
  const info = result.capabilities?.experimental?.opentide;
  if (info?.engine !== version) errors.push(`engine is ${info?.engine}, engine.json says ${version}`);
  if (info?.host !== null) errors.push(`engine host is ${JSON.stringify(info?.host)}, expected none`);
  if (exitCode !== 0) errors.push(`the engine worker exited with ${exitCode} after exit`);
  return errors;
}

/**
 * The web extension in an unpacked package: package.json's `browser` entry, the engine's Web Worker and
 * the module it fetches (`exists` takes a path relative to the extension folder). Without `browser`, the
 * Marketplace does not offer the package on the web.
 */
export function checkWebEntry(pkg, exists) {
  const errors = [];
  if (typeof pkg.browser !== "string") errors.push("package.json has no browser entry");
  else if (!exists(pkg.browser.replace(/^\.\//, "")))
    errors.push(`package.json browser names ${pkg.browser}, which the package lacks`);
  for (const file of ["dist/web/engine-worker.js", "dist/engine/opentide_wasm_bg.wasm"]) {
    if (!exists(file)) errors.push(`the package has no ${file}`);
  }
  if (pkg.capabilities?.virtualWorkspaces?.supported === false)
    errors.push("package.json says it does not support virtual workspaces");
  return errors;
}

/** The version `opentide --version` prints (`opentide 0.24.0`, or the bare version). */
export function versionOf(stdout) {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-.+][0-9A-Za-z.+-]+)?)\s*$/m.exec(stdout.trim());
  return match?.[1];
}

/**
 * A platform VSIX's dist/opentide/: opentide.json names an addon for `platform` and the files are there
 * (`exists` takes a path relative to the extension folder).
 */
export function checkPackageLayout(manifest, platform, exists) {
  const errors = [];
  if (!manifest) return ["the package has no dist/opentide/opentide.json"];
  if (manifest.name !== "@opentide/opentide") errors.push(`dist/opentide is ${manifest.name}`);
  if (manifest.platform !== platform)
    errors.push(`dist/opentide is for ${manifest.platform}, expected ${platform}`);
  for (const file of [manifest.cli, manifest.native, "index.js", "LICENSE"]) {
    if (typeof file !== "string" || !exists(`dist/opentide/${file}`))
      errors.push(`dist/opentide has no ${file}`);
  }
  return errors;
}

/**
 * The commands the extension needs from the package's command tree (`opentide --json commands`): the
 * backend (`serve`), the language server, MCP and the catalogue.
 */
export const REQUIRED_COMMANDS = ["serve", "lsp start", "mcp start", "info catalog", "validate"];

/**
 * The command paths of a `--json commands` document (its `commands`, each with a `path`), and each
 * command with a value of its first positional argument's choices (`info catalog`), as the extension's
 * `hasCommand` reads them.
 */
export function commandPaths(document) {
  const found = new Set();
  for (const command of Array.isArray(document?.commands) ? document.commands : []) {
    if (typeof command?.path !== "string") continue;
    found.add(command.path);
    const first = Array.isArray(command.arguments) ? command.arguments[0] : undefined;
    for (const choice of Array.isArray(first?.choices) ? first.choices : [])
      found.add(`${command.path} ${choice}`);
  }
  return found;
}

/** The package's command tree has every command the extension needs. */
export function checkPackageCommands(document) {
  const paths = commandPaths(document);
  return REQUIRED_COMMANDS.filter((command) => !paths.has(command)).map(
    (command) => `the bundled opentide has no \`${command}\``,
  );
}

/** `opentide lsp start`'s `initialize`: the language server answers with a name and its capabilities. */
export function checkPackageInitialize(response) {
  const result = response?.result;
  if (!result)
    return [
      `bundled opentide lsp start: initialize failed: ${JSON.stringify(response?.error ?? response).slice(0, 300)}`,
    ];
  if (!result.capabilities?.textDocumentSync && result.capabilities?.textDocumentSync !== 0)
    return ["bundled opentide lsp start: initialize has no textDocumentSync"];
  return [];
}
