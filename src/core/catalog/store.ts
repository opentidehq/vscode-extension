// One `info catalog` document per opentide folder, kept fresh in the background (SPEC §9 "Data").
// Refreshes are debounced (1 s) and single-flight per folder. Without `info catalog` in the active
// opentide, the store serves names and locations from `workspace/symbol` and says what is needed.
// vscode-free.
import { BackendError } from "../backend/types";
import { Emitter, type Event } from "../util/event";
import { folderSpelling } from "../util/paths";
import { type CatalogDocument, type CatalogSymbol, isCatalogDocument } from "./types";

export type CatalogStatus = "empty" | "loading" | "ready" | "unavailable" | "error";

export type UnavailableReason = "untrusted" | "no-runtime" | "editor-only" | "needs-command";

export interface CatalogUnavailable {
  readonly reason: UnavailableReason;
  readonly message: string;
  /** For `needs-command`: the command path the active opentide lacks. */
  readonly command?: string;
}

export interface CatalogState {
  readonly folder: string;
  readonly status: CatalogStatus;
  /** The last good document; kept while a refresh runs or after one fails. */
  readonly catalog?: CatalogDocument;
  /** Fallback names and locations (`workspace/symbol`), when there is no document. */
  readonly symbols?: readonly CatalogSymbol[];
  readonly unavailable?: CatalogUnavailable;
  readonly error?: string;
  /** A refresh is running. */
  readonly refreshing: boolean;
  readonly updatedAt?: number;
}

export interface CatalogStoreDeps {
  /** Why commands cannot run now, if they cannot. */
  availability():
    | { available: true }
    | { available: false; code: "no-runtime" | "untrusted" | "editor-only" };
  /** Whether the active opentide has `info catalog`; waits for the command tree. */
  hasInfoCatalog(): Promise<boolean>;
  /** `opentide --json info catalog` for the folder. */
  runCatalog(folder: string): Promise<{ document: unknown; exitCode: number }>;
  /** `workspace/symbol` results under the folder, when the language server runs. */
  symbols(folder: string): Promise<readonly CatalogSymbol[] | undefined>;
  log(level: "debug" | "warn", message: string): void;
  readonly debounceMs?: number;
  now?(): number;
}

export const INFO_CATALOG = "info catalog";

const UNAVAILABLE_MESSAGES: Record<Exclude<UnavailableReason, "needs-command">, string> = {
  untrusted: "Trust this folder to load the catalogue.",
  "no-runtime": "No opentide runtime: install opentide in the workspace or set opentide.path.",
  "editor-only": "opentide.path names opentide-lsp, which has no catalogue. Point it at opentide.",
};

interface Slot {
  state: CatalogState;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  /** Another refresh was asked for while one ran. */
  again: boolean;
  /** Callers waiting for the next refresh to finish. */
  waiters: (() => void)[];
}

export class CatalogStore {
  private readonly slots = new Map<string, Slot>();
  private readonly emitter = new Emitter<CatalogState>();
  private disposed = false;

  /** A folder's state changed. */
  readonly onDidChange: Event<CatalogState> = this.emitter.event;

  constructor(private readonly deps: CatalogStoreDeps) {}

  /** The folder's state. The first call starts loading it. */
  get(folder: string): CatalogState {
    const known = this.slots.has(folder);
    const slot = this.slot(folder);
    if (!known) void this.refresh(folder, { immediate: true });
    return slot.state;
  }

  /** Folders something has asked about. */
  folders(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Ask for a refresh. Calls within the debounce window collapse into one run, and a call during a run
   * queues exactly one more. Resolves when a refresh that started after this call has finished.
   */
  refresh(folder: string, options: { immediate?: boolean } = {}): Promise<CatalogState> {
    const slot = this.slot(folder);
    const done = new Promise<CatalogState>((resolve) => slot.waiters.push(() => resolve(slot.state)));
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(
      () => {
        slot.timer = undefined;
        this.kick(folder, slot);
      },
      options.immediate ? 0 : (this.deps.debounceMs ?? 1000),
    );
    return done;
  }

  /** Refresh every folder already asked about (after a runtime change). */
  refreshAll(options: { immediate?: boolean } = {}): void {
    for (const folder of this.slots.keys()) void this.refresh(folder, options);
  }

  /** Forget a folder (removed from the workspace). */
  delete(folder: string): void {
    const slot = this.slots.get(folder);
    if (slot?.timer) clearTimeout(slot.timer);
    this.slots.delete(folder);
  }

  private slot(folder: string): Slot {
    let slot = this.slots.get(folder);
    if (!slot) {
      slot = {
        state: { folder, status: "empty", refreshing: false },
        timer: undefined,
        running: undefined,
        again: false,
        waiters: [],
      };
      this.slots.set(folder, slot);
    }
    return slot;
  }

  private kick(folder: string, slot: Slot): void {
    if (this.disposed || this.slots.get(folder) !== slot) return;
    if (slot.running) {
      slot.again = true;
      return;
    }
    const waiters = slot.waiters.splice(0);
    slot.running = this.load(folder, slot).finally(() => {
      slot.running = undefined;
      for (const resolve of waiters) resolve();
      if (slot.again) {
        slot.again = false;
        this.kick(folder, slot);
      }
    });
  }

  private update(slot: Slot, patch: Partial<CatalogState>): void {
    this.replace(slot, { ...slot.state, ...patch });
  }

  private replace(slot: Slot, state: CatalogState): void {
    slot.state = state;
    if (!this.disposed) this.emitter.fire(state);
  }

  private async load(folder: string, slot: Slot): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const first = slot.state.status === "empty";
    this.update(slot, { refreshing: true, ...(first ? { status: "loading" as const } : {}) });

    const availability = this.deps.availability();
    if (!availability.available) {
      const symbols = await this.safeSymbols(folder);
      this.replace(slot, {
        folder,
        status: "unavailable",
        refreshing: false,
        unavailable: { reason: availability.code, message: UNAVAILABLE_MESSAGES[availability.code] },
        ...(symbols ? { symbols } : {}),
        updatedAt: now(),
      });
      return;
    }
    if (!(await this.deps.hasInfoCatalog())) {
      const symbols = await this.safeSymbols(folder);
      this.replace(slot, {
        folder,
        status: "unavailable",
        refreshing: false,
        unavailable: {
          reason: "needs-command",
          command: INFO_CATALOG,
          message: "The catalogue needs a newer opentide: one whose command tree has `info catalog`.",
        },
        ...(symbols ? { symbols } : {}),
        updatedAt: now(),
      });
      return;
    }
    try {
      const { document, exitCode } = await this.deps.runCatalog(folder);
      if (!isCatalogDocument(document)) {
        const failure = (document as { failure?: { message?: string } } | undefined)?.failure;
        throw new Error(failure?.message ?? `info catalog printed no catalogue (exit ${exitCode})`);
      }
      this.replace(slot, {
        folder,
        status: "ready",
        catalog: inFolderSpelling(document, folder),
        refreshing: false,
        updatedAt: now(),
      });
    } catch (error) {
      const message = error instanceof BackendError || error instanceof Error ? error.message : String(error);
      this.deps.log("warn", `catalogue of ${folder}: ${message}`);
      const catalog = slot.state.catalog;
      const symbols = catalog ? undefined : await this.safeSymbols(folder);
      this.replace(slot, {
        folder,
        ...(catalog ? { catalog } : {}),
        status: "error",
        error: message,
        refreshing: false,
        ...(symbols ? { symbols } : {}),
        updatedAt: now(),
      });
    }
  }

  private async safeSymbols(folder: string): Promise<readonly CatalogSymbol[] | undefined> {
    try {
      return await this.deps.symbols(folder);
    } catch (error) {
      this.deps.log("debug", `workspace/symbol for ${folder}: ${String(error)}`);
      return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.emitter.dispose();
  }
}

/** The document with each object's `file_path` in the folder's spelling (opentide reports real paths). */
export function inFolderSpelling(
  document: CatalogDocument,
  folder: string,
  spell: (file: string) => string = folderSpelling(folder),
): CatalogDocument {
  let changed = false;
  const objects = document.objects.map((object) => {
    const file_path = spell(object.file_path);
    if (file_path === object.file_path) return object;
    changed = true;
    return { ...object, file_path };
  });
  return changed ? { ...document, objects } : document;
}
