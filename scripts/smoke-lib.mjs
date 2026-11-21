// Pure helpers for scripts/smoke.mjs: the checks on the engine (WASM) and the web extension a package
// carries (SPEC §3 "Smoke test").

export class SmokeError extends Error {}

/** A version without its pre-release and build suffixes: `1.0.0-rc.3-dev+abc` is `1.0.0`. */
export function releaseOf(version) {
  return typeof version === "string" ? version.replace(/[-+].*$/, "") : version;
}

/**
 * The WASI module's `opentide serve`, as the extension's launcher runs it: `initialize` answers protocol 1
 * with `capabilities.fetch` (tenant requests are the client's), a version that agrees with wasi.json's, and
 * a `run` of `commands` answers its document; the process ends 0 after `exit`.
 */
export function checkWasiServe(initialize, run, manifest, exitCode) {
  const errors = [];
  const result = initialize?.result;
  if (!result)
    return [`WASI serve initialize failed: ${JSON.stringify(initialize?.error ?? initialize).slice(0, 300)}`];
  if (result.protocol !== 1) errors.push(`WASI serve speaks protocol ${result.protocol}, not 1`);
  if (result.capabilities?.fetch !== true)
    errors.push("WASI serve does not offer opentide/fetch: no tenant request could be made");
  if (typeof result.version !== "string" || releaseOf(result.version) !== releaseOf(manifest.version))
    errors.push(`WASI serve is ${result.version}, wasi.json says ${manifest.version}`);
  if (!/^[0-9a-f]{64}$/.test(result.commands_digest ?? "")) errors.push("WASI serve gave no commands_digest");
  const document = run?.result?.document;
  if (document?.command !== "commands" || run?.result?.exit_code !== 0)
    errors.push(`WASI serve did not run \`commands\`: ${JSON.stringify(run).slice(0, 300)}`);
  if (exitCode !== 0) errors.push(`the WASI process exited with ${exitCode} after exit`);
  return errors;
}

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
  // The browser build reports the crate's version, without a release candidate's suffix (1.0.0 for 1.0.0-rc.2).
  if (releaseOf(info?.engine) !== releaseOf(version))
    errors.push(`engine is ${info?.engine}, engine.json says ${version}`);
  if (info?.host !== null) errors.push(`engine host is ${JSON.stringify(info?.host)}, expected none`);
  if (exitCode !== 0) errors.push(`the engine worker exited with ${exitCode} after exit`);
  return errors;
}

/**
 * The MCP bridge (dist/mcp-wasi.js) answers a client as the module's `mcp start` does: `initialize` as opentide,
 * `tools/list` with its tools, and not one line on stdout that is no JSON-RPC message of the server's
 * (`lines`, as written; the private link's `opentide/fetch` never reaches the editor).
 */
export function checkMcpBridge(lines, exitCode) {
  const errors = [];
  const messages = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      errors.push(`the MCP bridge wrote a line that is no JSON: ${line.slice(0, 120)}`);
    }
  }
  for (const message of messages) {
    if (message?.jsonrpc !== "2.0" || String(message?.method ?? "").startsWith("opentide/"))
      errors.push(
        `the MCP bridge wrote ${JSON.stringify(message).slice(0, 120)}, no message of an MCP server`,
      );
  }
  const initialize = messages.find((message) => message?.id === 1);
  if (initialize?.result?.serverInfo?.name !== "opentide")
    errors.push(
      `MCP initialize did not answer as opentide: ${String(JSON.stringify(initialize)).slice(0, 200)}`,
    );
  const tools = messages.find((message) => message?.id === 2)?.result?.tools;
  if (!Array.isArray(tools) || !tools.some((tool) => tool?.name === "search"))
    errors.push("MCP tools/list has no `search` tool");
  if (exitCode !== 0) errors.push(`the MCP bridge exited with ${exitCode} after its input ended`);
  return errors;
}

/** The WASI module's files in an unpacked package (`exists` takes a path relative to the extension folder). */
export function checkWasiPackage(exists) {
  // The licence set ships with the module it belongs to (pins.json wasi.licences).
  return [
    "dist/wasi/opentide.wasm",
    "dist/wasi/launcher.cjs",
    "dist/wasi/wasi.json",
    "dist/wasi/THIRD-PARTY-LICENSES.html",
    "dist/wasi/WASI-LIBC-LICENSES.txt",
    "dist/wasi/LICENSE",
    "dist/wasi/NOTICE",
    "dist/mcp-wasi.js",
    "dist/mcp-launcher.js",
  ]
    .filter((file) => !exists(file))
    .map((file) => `the package has no ${file}`);
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
