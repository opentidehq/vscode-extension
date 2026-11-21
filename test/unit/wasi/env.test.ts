import * as assert from "node:assert/strict";
import { GUEST_HOME, wasiEnv } from "../../../src/core/wasi/env";

describe("the WASI module's environment (src/core/wasi/env.ts)", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    OPENTIDE_PROXY: "http://proxy:3128",
    OPENTIDE_TERMINAL_WIDTH: "120",
    https_proxy: "http://p:1",
    NO_PROXY: "localhost",
    AZURE_CLIENT_SECRET: "s3cr3t",
    UNSET: undefined,
  };

  it("gives it opentide's settings and the proxy variables, and nothing else of the host's", () => {
    assert.deepEqual(wasiEnv(base, { pwd: "/workspace" }), {
      OPENTIDE_PROXY: "http://proxy:3128",
      OPENTIDE_TERMINAL_WIDTH: "120",
      https_proxy: "http://p:1",
      NO_PROXY: "localhost",
      NO_COLOR: "1",
      PWD: "/workspace",
    });
  });

  it("gives it a home under the mounted global storage when asked", () => {
    const env = wasiEnv({}, { pwd: "/workspaces/a", home: true });
    assert.equal(env.HOME, GUEST_HOME);
    assert.equal(env.XDG_STATE_HOME, `${GUEST_HOME}/state`);
    assert.equal(env.PWD, "/workspaces/a");
  });
});
