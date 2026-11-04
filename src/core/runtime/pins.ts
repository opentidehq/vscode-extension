// Detect the opentide version a repository pins: uv.lock (resolved), requirements*.txt, pyproject.toml.
// Only exact pins (`==`) count; a range is not a pin. vscode-free.

export interface RepoPin {
  version: string;
  /** Workspace-relative file the pin came from. */
  source: string;
}

export interface PinFiles {
  /** Workspace-relative path to text, for the files that exist. */
  readonly [relativePath: string]: string;
}

const NAME = /^opentide(?:\[[^\]]*\])?$/i;

/** `opentide==0.20.1` (with optional extras and markers) in a requirement string. */
export function pinFromRequirement(requirement: string): string | undefined {
  const match = /^\s*([A-Za-z0-9_.-]+(?:\[[^\]]*\])?)\s*===?\s*([A-Za-z0-9_.+!-]+)\s*(?:[;#].*)?$/.exec(
    requirement,
  );
  if (!match?.[1] || !match[2] || !NAME.test(match[1])) return undefined;
  if (match[2].includes("*")) return undefined;
  return match[2];
}

export function pinFromRequirements(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const pin = pinFromRequirement(line);
    if (pin) return pin;
  }
  return undefined;
}

/** Every quoted requirement string in pyproject.toml that pins opentide exactly. */
export function pinFromPyproject(text: string): string | undefined {
  const strings = text.matchAll(/(["'])((?:(?!\1).)*)\1/g);
  for (const match of strings) {
    const value = match[2];
    if (value === undefined) continue;
    const pin = pinFromRequirement(value);
    if (pin) return pin;
  }
  return undefined;
}

/** The resolved `opentide` version in uv.lock (`[[package]] name = "opentide" version = "…"`). */
export function pinFromUvLock(text: string): string | undefined {
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\[/m)[0] ?? "";
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (name?.toLowerCase() === "opentide" && version) return version;
  }
  return undefined;
}

/** The files to read, relative to the folder: uv.lock, requirements*.txt (sorted), pyproject.toml. */
export function pinFileOrder(names: readonly string[]): string[] {
  const requirements = names.filter((name) => /^requirements[^/\\]*\.txt$/i.test(name)).sort();
  return [
    ...(names.includes("uv.lock") ? ["uv.lock"] : []),
    ...requirements,
    ...(names.includes("pyproject.toml") ? ["pyproject.toml"] : []),
  ];
}

/** The repository's pin, from the first file that has one, in `pinFileOrder` order. */
export function detectPin(files: PinFiles): RepoPin | undefined {
  for (const source of pinFileOrder(Object.keys(files))) {
    const text = files[source];
    if (text === undefined) continue;
    const version =
      source === "uv.lock"
        ? pinFromUvLock(text)
        : source === "pyproject.toml"
          ? pinFromPyproject(text)
          : pinFromRequirements(text);
    if (version) return { version, source };
  }
  return undefined;
}
