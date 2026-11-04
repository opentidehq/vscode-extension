// A small stand-in for the `vscode` module, for unit tests in plain node (see register.ts). It covers
// what the core's unit-tested modules touch; extend it when a test needs more, and keep it honest: no
// behaviour VS Code does not have.

/** Test knobs. Reset them in `beforeEach`. */
export const stubState = {
  trusted: true,
  config: {} as Record<string, unknown>,
  /** Every `section.key` a test's code read through getConfiguration().get. */
  readKeys: [] as string[],
  executed: [] as { command: string; args: unknown[] }[],
  /** Every file system watcher created, with its pattern, until disposed. */
  watchers: [] as StubWatcher[],
  reset(): void {
    this.trusted = true;
    this.config = {};
    this.readKeys = [];
    this.executed = [];
    this.watchers = [];
  },
  /**
   * A file was created (or deleted) at the absolute `fsPath`: fire the watchers whose pattern matches it
   * as VS Code matches them. A string glob is matched against the absolute path; a RelativePattern
   * against the path relative to its base.
   */
  fileEvent(kind: "create" | "delete", fsPath: string): void {
    const file = fsPath.replaceAll("\\", "/");
    for (const watcher of [...this.watchers]) {
      if (kind === "create" ? watcher.ignoreCreate : watcher.ignoreDelete) continue;
      const pattern = watcher.pattern;
      let subject = file;
      let glob: string;
      if (typeof pattern === "string") glob = pattern;
      else {
        const base = (typeof pattern.base === "string" ? pattern.base : pattern.base.fsPath).replace(
          /\/$/,
          "",
        );
        if (!file.startsWith(`${base}/`)) continue;
        subject = file.slice(base.length + 1);
        glob = pattern.pattern;
      }
      if (globRegExp(glob).test(subject)) watcher.fire(kind, Uri.file(fsPath));
    }
  },
};

/** A glob as VS Code reads it: `**`, `*`, `?` and `{a,b}`. */
function globRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export class Disposable {
  private fn: (() => void) | undefined;
  constructor(fn: () => void) {
    this.fn = fn;
  }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) d.dispose();
    });
  }
  dispose(): void {
    this.fn?.();
    this.fn = undefined;
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  private readonly cancelled = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.cancelled.event,
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.cancelled.fire();
  }
  dispose(): void {
    this.cancelled.dispose();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri("file", fsPath.replaceAll("\\", "/"));
  }
  static parse(value: string): Uri {
    const match = /^([a-z][a-z0-9+.-]*):\/\/[^/]*(.*)$/i.exec(value);
    return match ? new Uri(match[1] ?? "file", decodeURIComponent(match[2] ?? "")) : new Uri("file", value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ""), ...segments].join("/"));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${encodeURI(this.path)}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number" && typeof b === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
}

export class RelativePattern {
  constructor(
    readonly base: { readonly uri: Uri } | Uri | string,
    readonly pattern: string,
  ) {}
}

type StubPattern = string | { readonly base: Uri | string; readonly pattern: string };

class StubWatcher {
  private readonly created = new EventEmitter<Uri>();
  private readonly deleted = new EventEmitter<Uri>();
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidDelete = this.deleted.event;
  readonly onDidChange = this.changed.event;
  constructor(
    readonly pattern: StubPattern,
    readonly ignoreCreate: boolean,
    readonly ignoreDelete: boolean,
  ) {}
  fire(kind: "create" | "delete", uri: Uri): void {
    (kind === "create" ? this.created : this.deleted).fire(uri);
  }
  dispose(): void {
    stubState.watchers = stubState.watchers.filter((w) => w !== this);
  }
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range | Position,
  ) {}
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

export const workspace = {
  get isTrusted(): boolean {
    return stubState.trusted;
  },
  workspaceFolders: [] as unknown[],
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  createFileSystemWatcher(
    pattern: string | RelativePattern,
    ignoreCreate = false,
    _ignoreChange = false,
    ignoreDelete = false,
  ): StubWatcher {
    const base = typeof pattern === "string" ? undefined : pattern.base;
    const normalized: StubPattern =
      typeof pattern === "string"
        ? pattern
        : {
            base:
              base instanceof Uri || typeof base === "string"
                ? (base as Uri | string)
                : (base as { uri: Uri }).uri,
            pattern: pattern.pattern,
          };
    const watcher = new StubWatcher(normalized, ignoreCreate, ignoreDelete);
    stubState.watchers.push(watcher);
    return watcher;
  },
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = section ? `${section}.${key}` : key;
        stubState.readKeys.push(full);
        return (full in stubState.config ? stubState.config[full] : defaultValue) as T | undefined;
      },
    };
  },
};

export const commands = {
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    stubState.executed.push({ command, args });
    return undefined;
  },
};

export const window = {
  createOutputChannel(name: string) {
    const lines: string[] = [];
    const log = (message: unknown) => lines.push(String(message));
    return {
      name,
      lines,
      trace: log,
      debug: log,
      info: log,
      warn: log,
      error: log,
      appendLine: log,
      show() {},
      dispose() {},
    };
  },
};
