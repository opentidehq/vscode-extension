// Process environments for opentide processes. vscode-free.
import * as path from "node:path";

/** Variables a Restricted Mode process keeps from the extension host: enough to start, nothing to configure. */
export const RESTRICTED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export interface EnvRuntime {
  readonly env: Readonly<Record<string, string>>;
  readonly restricted: boolean;
  readonly binDirs: readonly string[];
}

function setPath(env: Record<string, string>, value: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = value;
}

/**
 * The environment of a process of `runtime`. In Restricted Mode it keeps only `RESTRICTED_ENV_KEYS` and
 * sets PATH to the runtime's own bin folders, so a subprocess such as git fails rather than running
 * workspace-controlled configuration.
 */
export function processEnv(
  base: Readonly<Record<string, string | undefined>>,
  runtime: EnvRuntime,
  platform: NodeJS.Platform,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  if (runtime.restricted) {
    const wanted = new Set<string>(RESTRICTED_ENV_KEYS);
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined && wanted.has(platform === "win32" ? key.toUpperCase() : key)) env[key] = value;
    }
    for (const [key, value] of Object.entries({ ...runtime.env, ...extra })) {
      if (key.toUpperCase() !== "PATH" && !key.toUpperCase().startsWith("PYTHON")) env[key] = value;
    }
    setPath(env, runtime.binDirs.join(path.delimiter), platform);
    return env;
  }
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries({ ...runtime.env, ...extra })) {
    if (key.toUpperCase() === "PATH") setPath(env, value, platform);
    else env[key] = value;
  }
  return env;
}

/** POSIX-shell quoting for a command line people copy into a terminal or CI. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Replace every occurrence of each secret (at least 4 characters) with `***`. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

/** Flags whose value is never shown. */
const SECRET_FLAGS = /^--?(?:[a-z-]*(?:token|secret|password|passwd|api-key|apikey|credential)[a-z-]*)$/i;

/** `opentide --json <argv>`, quoted, with secret flag values and known secrets redacted. */
export function displayArgv(argv: readonly string[], secrets: Iterable<string> = []): string {
  const shown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    if (arg.startsWith("-") && eq > 0 && SECRET_FLAGS.test(arg.slice(0, eq))) {
      shown.push(`${arg.slice(0, eq)}=***`);
    } else if (SECRET_FLAGS.test(arg) && i + 1 < argv.length) {
      shown.push(arg, "***");
      i++;
    } else {
      shown.push(shellQuote(arg));
    }
  }
  return redact(["opentide", "--json", ...shown].join(" "), secrets);
}
