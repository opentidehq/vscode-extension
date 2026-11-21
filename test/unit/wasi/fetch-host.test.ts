// The real @opentide/wasi-host's FetchHost behind the wire, against a local HTTP server: a tenant request
// the (fake) opentide serve asks the client for is made by Node's HTTP stack in this process. Nothing
// leaves the machine.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { fromChildProcess } from "../../../src/core/backend/process";
import { ServeClient } from "../../../src/core/backend/serve";
import { WASI_INITIALIZE_PARAMS } from "../../../src/core/services/wasi";
import { GuestPaths } from "../../../src/core/wasi/paths";
import { wasiServeWire } from "../../../src/core/wasi/wire";
import { FAKE_OPENTIDE } from "../helpers";

describe("tenant requests through @opentide/wasi-host (the real FetchHost)", () => {
  let server: http.Server;
  let url: string;
  const seen: { method?: string | undefined; accept?: string | undefined }[] = [];
  let client: ServeClient | undefined;

  before(async () => {
    server = http.createServer((request, response) => {
      seen.push({ method: request.method, accept: request.headers.accept });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"value":[1,2,3]}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(async () => {
    await client?.stop();
    client = undefined;
  });

  it("asks for opentide/fetch with the capability the package defines", async () => {
    const { FETCH_CAPABILITY } = await import("@opentide/wasi-host");
    assert.deepEqual(WASI_INITIALIZE_PARAMS, FETCH_CAPABILITY);
  });

  it("makes the request the server sends and gives the answer back to the run", async () => {
    const { FetchHost } = await import("@opentide/wasi-host");
    const paths = new GuestPaths([], "linux");
    client = new ServeClient({
      start: () => {
        const child = cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], {
          env: { ...process.env, FAKE_FETCH_URL: url },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return wasiServeWire(fromChildProcess(child), paths, (send) => new FetchHost(send));
      },
      initializeParams: WASI_INITIALIZE_PARAMS,
    });
    const result = await client.run({ argv: ["fetch-tenant"] });
    assert.equal(result.exit_code, 0);
    const answer = result.document.fetch as { status: number; body: string; headers: [string, string][] };
    assert.equal(answer.status, 200);
    assert.equal(Buffer.from(answer.body, "base64").toString(), '{"value":[1,2,3]}');
    assert.ok(
      answer.headers.some(([name, value]) => name === "content-type" && value === "application/json"),
    );
    assert.deepEqual(seen, [{ method: "GET", accept: "application/json" }]);
  });

  it("answers a tenant that cannot be reached with the failure kind the server maps", async () => {
    const { FetchHost } = await import("@opentide/wasi-host");
    client = new ServeClient({
      start: () => {
        const child = cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], {
          // Nothing listens on port 9 of the loopback.
          env: { ...process.env, FAKE_FETCH_URL: "http://127.0.0.1:9/api" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return wasiServeWire(
          fromChildProcess(child),
          new GuestPaths([], "linux"),
          (send) => new FetchHost(send),
        );
      },
      initializeParams: WASI_INITIALIZE_PARAMS,
    });
    const result = await client.run({ argv: ["fetch-tenant"] });
    assert.equal(result.exit_code, 1);
    const error = result.document.fetch_error as { data?: { kind?: string } };
    assert.equal(error.data?.kind, "connect");
  });
});
