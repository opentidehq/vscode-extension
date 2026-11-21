import * as assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { requestArguments } from "../../../src/features/query/targets";

/** What goes out on the wire: the `params` of each request message, as a server that does not spread arrays sees it. */
async function wireParams(send: (client: ReturnType<typeof createMessageConnection>) => Promise<unknown>) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const client = createMessageConnection(
    new StreamMessageReader(toClient),
    new StreamMessageWriter(toServer),
  );
  const server = createMessageConnection(
    new StreamMessageReader(toServer),
    new StreamMessageWriter(toClient),
  );
  let wire = "";
  toServer.on("data", (chunk: Buffer) => {
    wire += chunk.toString("utf8");
  });
  server.onRequest("textDocument/documentSymbol", () => []);
  server.listen();
  client.listen();
  await send(client);
  client.dispose();
  server.dispose();
  const body = wire.slice(wire.indexOf("{"));
  return (JSON.parse(body) as { params: unknown }).params;
}

describe("a language-client request with an optional cancellation token (#87)", () => {
  const params = { textDocument: { uri: "file:///rule.yaml" } };

  it("an explicit undefined token sends the params as a positional array: the palette's failure", async () => {
    const sent = await wireParams((c) => c.sendRequest("textDocument/documentSymbol", params, undefined));
    assert.deepEqual(sent, [params, null]);
  });

  it("without a token, the request goes out by name: the params are the object", async () => {
    const sent = await wireParams((c) =>
      c.sendRequest("textDocument/documentSymbol", ...requestArguments(params, undefined)),
    );
    assert.deepEqual(sent, params);
  });

  it("with a token (the CodeLens path), too", async () => {
    const source = new CancellationTokenSource();
    const sent = await wireParams((c) =>
      c.sendRequest("textDocument/documentSymbol", ...requestArguments(params, source.token)),
    );
    assert.deepEqual(sent, params);
  });

  it("the argument list has no trailing undefined", () => {
    assert.deepEqual(requestArguments(params, undefined), [params]);
    const token = { isCancellationRequested: false };
    assert.deepEqual(requestArguments(params, token), [params, token]);
  });
});
