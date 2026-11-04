// Capabilities of the active opentide: its command tree, read once per opentide version and cached.
// vscode-free; the fetch and the cache are injected.
import { hasCli, type Runtime } from "../runtime/types";
import { type Disposable, Emitter, type Event, toDisposable } from "../util/event";
import { type Classification, type Classifier, classify } from "./classification";
import { type CommandInfo, type CommandPath, CommandTree } from "./tree";

export interface CommandsCache {
  read(version: string): Promise<unknown | undefined>;
  write(version: string, document: unknown): Promise<void>;
}

export interface CapabilitiesDeps {
  /** Run `opentide --json commands` with this runtime and return the parsed document. */
  fetch(runtime: Runtime): Promise<unknown>;
  readonly cache: CommandsCache;
  log(level: "info" | "warn", message: string): void;
}

/** A version whose tree can change without a version bump is not cached on disk. */
export function cacheable(version: string): boolean {
  return /^\d+(\.\d+)*$/.test(version);
}

export class Capabilities implements Disposable {
  private tree: CommandTree | undefined;
  private loading: Promise<CommandTree | undefined> | undefined;
  private runtime: Runtime | undefined;
  private readonly classifiers: Classifier[] = [];
  private readonly emitter = new Emitter<CommandTree | undefined>();

  /** The tree changed (a new runtime, or none). */
  readonly onDidChange: Event<CommandTree | undefined> = this.emitter.event;

  constructor(private readonly deps: CapabilitiesDeps) {}

  /** The loaded tree, or undefined before it loads and when the runtime has no CLI. */
  get current(): CommandTree | undefined {
    return this.tree;
  }

  /** Wait for the tree of the current runtime. */
  ready(): Promise<CommandTree | undefined> {
    return this.loading ?? Promise.resolve(this.tree);
  }

  /** Load the tree for `runtime` (from the cache when its version was seen before). */
  load(runtime: Runtime | undefined): Promise<CommandTree | undefined> {
    this.runtime = runtime;
    const loading = this.doLoad(runtime);
    this.loading = loading;
    void loading.finally(() => {
      if (this.loading === loading) this.loading = undefined;
    });
    return loading;
  }

  /** Drop the cached tree of the current version and read it again (serve's digest changed). */
  async refresh(): Promise<CommandTree | undefined> {
    const runtime = this.runtime;
    if (!hasCli(runtime)) return undefined;
    const fresh = await this.fetchTree(runtime);
    if (fresh && this.runtime === runtime) this.set(fresh);
    return fresh;
  }

  private async doLoad(runtime: Runtime | undefined): Promise<CommandTree | undefined> {
    if (!hasCli(runtime)) {
      this.set(undefined);
      return undefined;
    }
    let tree: CommandTree | undefined;
    if (cacheable(runtime.version)) {
      try {
        const cached = await this.deps.cache.read(runtime.version);
        if (cached !== undefined) tree = CommandTree.parse(cached);
      } catch {
        tree = undefined;
      }
    }
    tree ??= await this.fetchTree(runtime);
    if (this.runtime === runtime) this.set(tree);
    return tree;
  }

  private async fetchTree(runtime: Runtime): Promise<CommandTree | undefined> {
    try {
      const document = await this.deps.fetch(runtime);
      const tree = CommandTree.parse(document);
      if (cacheable(tree.version)) await this.deps.cache.write(tree.version, document).catch(() => undefined);
      this.deps.log("info", `opentide ${tree.version}: ${tree.commands.length} commands`);
      return tree;
    } catch (error) {
      this.deps.log("warn", `could not read \`opentide --json commands\`: ${String(error)}`);
      return undefined;
    }
  }

  private set(tree: CommandTree | undefined): void {
    if (this.tree === tree) return;
    this.tree = tree;
    this.emitter.fire(tree);
  }

  hasCommand(path: CommandPath): boolean {
    return this.tree?.hasCommand(path) ?? false;
  }

  hasOption(path: CommandPath, flag: string): boolean {
    return this.tree?.hasOption(path, flag) ?? false;
  }

  /** Every command of the active opentide, or none before the tree loads. */
  commands(): readonly CommandInfo[] {
    return this.tree?.commands ?? [];
  }

  /** What `argv` does: feature classifiers first, then the built-in table. */
  classify(argv: readonly string[]): Classification & { readonly unclassified?: true } {
    return classify(argv, this.classifiers);
  }

  /** Add a classifier that answers before the built-in table (for commands newer than the table). */
  registerClassifier(classifier: Classifier): Disposable {
    this.classifiers.unshift(classifier);
    return toDisposable(() => {
      const index = this.classifiers.indexOf(classifier);
      if (index >= 0) this.classifiers.splice(index, 1);
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
