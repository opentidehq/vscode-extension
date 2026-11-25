// The entry of dist/lsp.js: vscode-languageclient, vscode-jsonrpc with the transports built on it, and
// @vscode/wasm-wasi, which the WASI host loads when it runs a module under it (and which shares semver with the client). The extension loads it with `loadLsp`
// (load.ts) when the first language client starts, so a window that never starts one (a dormant one, which
// onStartupFinished activates too) does not pay for the package: it was about 53 ms of the 77 ms that
// `require(dist/extension.js)` took. Types come from the packages with `import type`, which costs nothing; the
// extension's bundle imports no value from either package, so there is one copy of vscode-jsonrpc in the package.
export {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  State,
} from "vscode-languageclient/node";
export { Emitter, ReadableStreamMessageReader, WriteableStreamMessageWriter } from "vscode-jsonrpc";
export { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

export { engineTransports } from "../../engine/transport";

export { Wasm as WasmApi } from "@vscode/wasm-wasi/v1";
