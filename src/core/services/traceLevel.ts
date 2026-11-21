// The log level of the language server trace channel for a value of `opentide.trace.server`. vscode-free.

export function traceLogLevel(setting: unknown): "trace" | "info" {
  return setting === "messages" || setting === "verbose" ? "trace" : "info";
}
