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
  return ["-I", "-X", `pycache_prefix=${pycachePrefix}`, "-m", "opentide", ...argv];
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
