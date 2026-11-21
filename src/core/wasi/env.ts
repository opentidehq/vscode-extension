// The environment of the WASI module (SPEC §4): it sees only what it is given. vscode-free.

/** Variables of the extension host the module is given: opentide's own settings, and the proxy `serve`
 * reads (`--proxy`, `OPENTIDE_PROXY`, the proxy variables and `no_proxy`) to say which proxy a tenant
 * request goes through. A path variable (`SSL_CERT_FILE`, `PATH`, `HOME`) would name a host path the module
 * cannot open, so none is passed. */
const FORWARDED = /^(OPENTIDE_[A-Z0-9_]+|NO_COLOR|(HTTPS?|ALL|NO)_PROXY|TZ)$/i;

/** Where the extension's global storage is mounted, for crash logs and state kept between sessions. */
export const GUEST_HOME = "/home/opentide";

export interface WasiEnvOptions {
  /** The guest working directory: the folder the process serves. */
  readonly pwd: string;
  /** Give the module a home and a state folder under `GUEST_HOME` (the global storage is mounted there). */
  readonly home?: boolean;
}

/** The module's environment from the host's (`base`, after the runtime's and the extension's own). */
export function wasiEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: WasiEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && FORWARDED.test(name)) env[name] = value;
  }
  env.NO_COLOR = "1";
  env.PWD = options.pwd;
  if (options.home) {
    env.HOME = GUEST_HOME;
    env.XDG_STATE_HOME = `${GUEST_HOME}/state`;
  }
  return env;
}
