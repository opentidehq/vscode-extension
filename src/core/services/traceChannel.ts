// The output channel of the language server's protocol trace. vscode-languageclient 10 takes a log channel for it and
// traces only while that channel's log level is Trace, ignoring `opentide.trace.server`: with a plain log channel the
// setting alone showed nothing (QA rerun 3). This channel's level follows the setting instead: Trace for `messages`
// and `verbose`, Info for `off`, and everything written goes to the channel whatever its level.
import * as vscode from "vscode";

import { traceLogLevel } from "./traceLevel";

export class TraceChannel implements vscode.LogOutputChannel {
  private readonly channel: vscode.OutputChannel;
  private readonly changed = new vscode.EventEmitter<vscode.LogLevel>();
  private readonly subscription: vscode.Disposable;
  private level: vscode.LogLevel;

  readonly onDidChangeLogLevel = this.changed.event;

  constructor(readonly name: string) {
    this.channel = vscode.window.createOutputChannel(name);
    this.level = this.read();
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opentide.trace.server")) return;
      const next = this.read();
      if (next === this.level) return;
      this.level = next;
      this.changed.fire(next);
    });
  }

  private read(): vscode.LogLevel {
    const setting = vscode.workspace.getConfiguration("opentide.trace").get<string>("server");
    return traceLogLevel(setting) === "trace" ? vscode.LogLevel.Trace : vscode.LogLevel.Info;
  }

  get logLevel(): vscode.LogLevel {
    return this.level;
  }

  private line(message: string, args: readonly unknown[]): void {
    this.channel.appendLine(args.length > 0 ? `${message} ${args.map(String).join(" ")}` : message);
  }

  trace(message: string, ...args: unknown[]): void {
    this.line(message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.line(message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.line(message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.line(message, args);
  }
  error(error: string | Error, ...args: unknown[]): void {
    this.line(typeof error === "string" ? error : error.message, args);
  }

  append(value: string): void {
    this.channel.append(value);
  }
  appendLine(value: string): void {
    this.channel.appendLine(value);
  }
  replace(value: string): void {
    this.channel.replace(value);
  }
  clear(): void {
    this.channel.clear();
  }
  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === "boolean") this.channel.show(columnOrPreserveFocus);
    else this.channel.show(columnOrPreserveFocus, preserveFocus);
  }
  hide(): void {
    this.channel.hide();
  }
  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    this.channel.dispose();
  }
}
