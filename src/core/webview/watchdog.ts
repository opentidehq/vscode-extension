// A workaround for a VS Code webview behaviour seen in CI: when the first page of a view type is closed while it
// loads, the next panel of that type can stay blank, its page never running (it sends nothing at all), and setting
// its HTML again does not wake it. The core replaces such a panel with a new one, once, if its page has said nothing
// for a while it was visible. vscode-free.

export interface WatchdogDeps {
  /** Whether the panel is visible now: a hidden panel may not load until it is shown. */
  visible(): boolean;
  /** Open the page again in a new panel, in the same place, and close the silent one. */
  replace(): void;
  /** Said once a panel is replaced, and once its replacement says nothing either. */
  log(level: "info" | "warn", message: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** How long a visible page may say nothing before its panel is replaced: a 1.2 MB page on a loaded machine is slow. */
export const SILENT_PAGE_MS = 10_000;

export class LoadWatchdog {
  private timer: unknown;
  private heardFrom = false;
  private replaced = false;
  private done = false;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(
    private readonly what: string,
    private readonly deps: WatchdogDeps,
    private readonly silentMs = SILENT_PAGE_MS,
  ) {
    this.setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.visibilityChanged();
  }

  /** The page sent a message, any message: it runs. The watchdog stops for good. */
  heard(): void {
    this.heardFrom = true;
    this.stop();
  }

  /** The panel was shown or hidden: the wait runs only while it is visible, and starts over when it is shown. */
  visibilityChanged(): void {
    if (this.done || this.heardFrom) return;
    if (!this.deps.visible()) {
      this.disarm();
      return;
    }
    if (this.timer === undefined) this.timer = this.setTimer(() => this.fire(), this.silentMs);
  }

  dispose(): void {
    this.stop();
  }

  private fire(): void {
    this.timer = undefined;
    if (this.done || this.heardFrom) return;
    const seconds = Math.round(this.silentMs / 1000);
    if (this.replaced) {
      // Once: a replacement that says nothing either is left as it is, and said so.
      this.deps.log(
        "warn",
        `the page of ${this.what} still sent nothing ${seconds} s after its panel was replaced`,
      );
      this.stop();
      return;
    }
    this.replaced = true;
    this.deps.log(
      "info",
      `the page of ${this.what} sent nothing in ${seconds} s: opening it again in a new panel`,
    );
    this.deps.replace();
    this.visibilityChanged();
  }

  private disarm(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private stop(): void {
    this.disarm();
    this.done = true;
  }
}
