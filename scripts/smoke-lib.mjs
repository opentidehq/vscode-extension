// Pure helpers for scripts/smoke.mjs: the bundled interpreter's path, LSP framing, and the checks on what
// the bundled opentide answers (SPEC §3 "Smoke test").

export class SmokeError extends Error {}

/** The bundled interpreter inside an unpacked VSIX's `extension/` folder (as src/core/runtime/resolve.ts). */
export function bundledPython(extensionDir, platform, join) {
  return platform === "win32"
    ? join(extensionDir, "runtime", "python.exe")
    : join(extensionDir, "runtime", "bin", "python3");
}

/** The arguments the extension runs the bundled opentide with. */
export function opentideArgs(pycachePrefix, argv) {
  return ["-I", "-X", "utf8", "-X", `pycache_prefix=${pycachePrefix}`, "-m", "opentide", ...argv];
}

/** One LSP message on the wire. */
export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Splits an LSP byte stream into messages. */
export class FrameReader {
  buffer = Buffer.alloc(0);

  /** Add bytes; returns the messages they complete. */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) break;
      const header = this.buffer.subarray(0, end).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) throw new SmokeError(`LSP header without Content-Length: ${header}`);
      const length = Number(match[1]);
      if (this.buffer.length < end + 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8")));
      this.buffer = this.buffer.subarray(end + 4 + length);
    }
    return messages;
  }
}

/** `opentide --version` printed the expected version. */
export function checkVersion(stdout, expected) {
  const match = /opentide\s+v?(\S+)/i.exec(stdout.trim());
  if (!match) return [`--version printed ${JSON.stringify(stdout.trim())}`];
  return match[1] === expected
    ? []
    : [`--version is ${match[1]}, the package was built with opentide ${expected}`];
}

/** Doctor checks that are about the machine, not the package (a container may have no git). */
export const HOST_CHECKS = new Set(["git", "git_repository", "proxy", "opentide_latest"]);

/** `opentide --json doctor --offline`: a JSON document whose failed checks are only host checks. */
export function checkDoctor(stdout) {
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    return [`doctor printed no JSON document: ${stdout.slice(0, 200)}`];
  }
  const checks = Array.isArray(document.checks) ? document.checks : [];
  if (checks.length === 0) return ["doctor reported no checks"];
  const errors = checks
    .filter((check) => check.status === "fail" && !HOST_CHECKS.has(check.code))
    .map((check) => `doctor check ${check.code} failed: ${check.message}`);
  const engine = checks.find((check) => check.code === "analysis_engine");
  if (engine && engine.status !== "pass")
    errors.push(`doctor: the analysis engine does not load: ${engine.message}`);
  return errors;
}

/**
 * The `initialize` result: `capabilities.experimental.opentide.host.name` is `opentide`, and its host
 * version and engine are the ones the package was built with (when the server reports them).
 */
export function checkInitialize(response, expected) {
  if (response?.error)
    return [`initialize failed: ${response.error.message ?? JSON.stringify(response.error)}`];
  const info = response?.result?.capabilities?.experimental?.opentide;
  if (!info) return ["initialize has no capabilities.experimental.opentide"];
  const errors = [];
  if (info.host?.name !== "opentide")
    errors.push(`host.name is ${JSON.stringify(info.host?.name)}, not "opentide"`);
  if (info.host?.version && expected.opentide && info.host.version !== expected.opentide)
    errors.push(`host.version is ${info.host.version}, the package was built with ${expected.opentide}`);
  if (info.engine && expected.engine && info.engine !== expected.engine)
    errors.push(`engine is ${info.engine}, pins.json derives ${expected.engine}`);
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
  if (info?.engine !== version) errors.push(`engine is ${info?.engine}, engine.json says ${version}`);
  if (info?.host !== null) errors.push(`engine host is ${JSON.stringify(info?.host)}, expected none`);
  if (exitCode !== 0) errors.push(`the engine worker exited with ${exitCode} after exit`);
  return errors;
}

/**
 * The interpreter is of its runtime's architecture: `sysconfig.get_platform()` (`win-amd64`,
 * `linux-aarch64`, `macosx-11.0-arm64`) against the CPU of BUILD-INFO's `runtime` (else `target`).
 * An emulated target's interpreter is its runtime's, not the machine's: win32-arm64 runs `win-amd64`.
 */
export function checkInterpreterPlatform(stdout, info) {
  const runtime = info.runtime ?? info.target ?? "";
  const cpu = /-(x64|arm64)$/.exec(runtime)?.[1];
  const platform = stdout.trim();
  if (!cpu) return [`BUILD-INFO names no runtime target with a CPU: ${JSON.stringify(runtime)}`];
  const pattern = cpu === "x64" ? /(?:amd64|x86_64)$/i : /(?:arm64|aarch64)$/i;
  return pattern.test(platform)
    ? []
    : [`the bundled interpreter is ${JSON.stringify(platform)}, not the ${runtime} runtime's ${cpu}`];
}

/** The median of some durations, in milliseconds. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The fixture's catalogue (test/fixtures/workspace/objects, copied into the smoke workspace): `opentide
 * --json info catalog` lists its objective and its rule, both loaded, with the rule's edge to the
 * objective.
 */
export function checkCatalog(stdout, fixture) {
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    return [`info catalog printed no JSON document: ${stdout.slice(0, 200)}`];
  }
  const objects = Array.isArray(document.objects) ? document.objects : undefined;
  if (!objects || !Array.isArray(document.edges)) return ["info catalog has no objects and edges"];
  const errors = [];
  for (const { uuid, type } of [fixture.objective, fixture.rule]) {
    const found = objects.find((object) => object.uuid === uuid);
    if (!found) errors.push(`info catalog has no ${type} ${uuid}`);
    else if (found.type !== type) errors.push(`info catalog lists ${uuid} as ${found.type}, not ${type}`);
    else if (found.load_error)
      errors.push(`info catalog: ${uuid} failed to load: ${JSON.stringify(found.load_error)}`);
  }
  if (!document.edges.some((edge) => edge.from === fixture.rule.uuid && edge.to === fixture.objective.uuid))
    errors.push(
      `info catalog has no edge from the rule ${fixture.rule.uuid} to the objective ${fixture.objective.uuid}`,
    );
  if (document.summary?.load_errors)
    errors.push(`info catalog reports ${document.summary.load_errors} load errors`);
  return errors;
}
