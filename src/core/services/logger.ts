import * as vscode from "vscode";
import type { Logger } from "../context";

export function createLogger(): Logger & vscode.Disposable {
  const channel = vscode.window.createOutputChannel("opentide", { log: true });
  return {
    channel,
    trace: (message) => channel.trace(message),
    debug: (message) => channel.debug(message),
    info: (message) => channel.info(message),
    warn: (message) => channel.warn(message),
    error: (message) => channel.error(message),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
