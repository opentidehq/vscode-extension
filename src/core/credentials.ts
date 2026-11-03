// Tenant credentials in SecretStorage, per workspace folder, keyed by the variable name the platform
// TOML names (`$AZURE_CLIENT_SECRET`). Never written to a file and never synced; injected into the
// environment only of runs that contact a tenant (backend RunOptions.credentials). vscode-free: the
// SecretStorage is injected (a `vscode.SecretStorage` qualifies).
import { createHash } from "node:crypto";
import { Emitter, type Event } from "./util/event";

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CredentialStore {
  private readonly emitter = new Emitter<{ folder: string; name: string }>();

  /** A credential of a folder was set or deleted. */
  readonly onDidChange: Event<{ folder: string; name: string }> = this.emitter.event;

  constructor(private readonly secrets: SecretStorageLike) {}

  private prefix(folder: string): string {
    const id = createHash("sha256").update(folder).digest("hex").slice(0, 16);
    return `opentide.credential.${id}`;
  }

  private async index(folder: string): Promise<string[]> {
    const raw = await this.secrets.get(`${this.prefix(folder)}.index`);
    if (!raw) return [];
    try {
      const names: unknown = JSON.parse(raw);
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(folder: string, names: readonly string[]): Promise<void> {
    await this.secrets.store(`${this.prefix(folder)}.index`, JSON.stringify([...new Set(names)].sort()));
  }

  /** The variable names stored for a folder (never their values). */
  names(folder: string): Promise<string[]> {
    return this.index(folder);
  }

  async has(folder: string, name: string): Promise<boolean> {
    return (await this.secrets.get(`${this.prefix(folder)}.${name}`)) !== undefined;
  }

  async get(folder: string, name: string): Promise<string | undefined> {
    return this.secrets.get(`${this.prefix(folder)}.${name}`);
  }

  async set(folder: string, name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new Error(`not an environment variable name: ${name}`);
    await this.secrets.store(`${this.prefix(folder)}.${name}`, value);
    await this.writeIndex(folder, [...(await this.index(folder)), name]);
    this.emitter.fire({ folder, name });
  }

  async delete(folder: string, name: string): Promise<void> {
    await this.secrets.delete(`${this.prefix(folder)}.${name}`);
    await this.writeIndex(
      folder,
      (await this.index(folder)).filter((existing) => existing !== name),
    );
    this.emitter.fire({ folder, name });
  }

  /** Every stored credential of a folder, as environment variables. */
  async env(folder: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of await this.index(folder)) {
      const value = await this.get(folder, name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
