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
  reset(): void {
    this.trusted = true;
    this.config = {};
    this.readKeys = [];
    this.executed = [];
  },
};

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
