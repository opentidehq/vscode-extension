// The read-only documents the runner opens (`opentide-result:`): results as JSON, explanations and
// vocabularies as Markdown. Kept in memory, the newest RESULT_LIMIT. vscode-free.
import { Emitter, type Event } from "../../core/util/event";

export const RESULT_SCHEME = "opentide-result";
export const RESULT_LIMIT = 30;

export class ResultStore {
  private readonly texts = new Map<string, string>();
  private nextId = 1;
  private readonly emitter = new Emitter<string>();
  private last: string | undefined;

  /** A document's text changed (its path). */
  readonly onDidChange: Event<string> = this.emitter.event;

  constructor(private readonly limit = RESULT_LIMIT) {}

  /** A fresh id for a document's path. */
  id(): number {
    return this.nextId++;
  }

  /** Store a document under `path` (`/<id>/<name>.json`); the oldest go first past the limit. */
  set(path: string, text: string, isResult = true): void {
    this.texts.delete(path);
    this.texts.set(path, text);
    while (this.texts.size > this.limit) {
      const oldest = this.texts.keys().next().value;
      if (oldest === undefined) break;
      this.texts.delete(oldest);
    }
    if (isResult) this.last = path;
    this.emitter.fire(path);
  }

  get(path: string): string | undefined {
    return this.texts.get(path);
  }

  /** The path of the newest run result still kept. */
  get lastResult(): string | undefined {
    return this.last && this.texts.has(this.last) ? this.last : undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
