// Merges contrib/*.json fragments into package.json's `contributes` and `activationEvents`.
// Pure functions; scripts/manifest.mjs does the file IO.

/** A merge failure that names the fragments involved. */
export class ManifestError extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Deep-merge `source` into `target` (mutating `target`). Objects merge key by key, arrays concatenate,
 * and two different scalars at the same path are a conflict.
 */
export function deepMerge(target, source, path, origin, origins) {
  for (const [key, value] of Object.entries(source)) {
    const here = path ? `${path}.${key}` : key;
    if (!(key in target)) {
      target[key] = structuredClone(value);
      origins.set(here, origin);
      continue;
    }
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      existing.push(...structuredClone(value));
    } else if (isObject(existing) && isObject(value)) {
      deepMerge(existing, value, here, origin, origins);
    } else if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new ManifestError(
        `${origin} sets ${here} to ${JSON.stringify(value)}, but ${origins.get(here) ?? "another fragment"} already set it to ${JSON.stringify(existing)}`,
      );
    }
  }
  return target;
}

/** `contributes.configuration` may be one object or an array of them; always return an array. */
function configurationSections(contributes) {
  const configuration = contributes.configuration;
  if (configuration === undefined) return [];
  return Array.isArray(configuration) ? configuration : [configuration];
}

function checkUnique(kind, entries) {
  const seen = new Map();
  for (const { id, origin } of entries) {
    if (seen.has(id)) {
      throw new ManifestError(`duplicate ${kind} "${id}" in ${seen.get(id)} and ${origin}`);
    }
    seen.set(id, origin);
  }
}

/** Fail on ids that VS Code requires to be unique: commands, settings, views and view containers. */
export function checkDuplicates(fragments) {
  const commands = [];
  const settings = [];
  const views = [];
  const containers = [];
  const walkthroughs = [];
  for (const { name, fragment } of fragments) {
    const contributes = fragment.contributes ?? {};
    for (const command of contributes.commands ?? []) commands.push({ id: command.command, origin: name });
    for (const section of configurationSections(contributes)) {
      for (const key of Object.keys(section.properties ?? {})) settings.push({ id: key, origin: name });
    }
    for (const list of Object.values(contributes.views ?? {})) {
      for (const view of list) views.push({ id: view.id, origin: name });
    }
    for (const list of Object.values(contributes.viewsContainers ?? {})) {
      for (const container of list) containers.push({ id: container.id, origin: name });
    }
    for (const walkthrough of contributes.walkthroughs ?? [])
      walkthroughs.push({ id: walkthrough.id, origin: name });
  }
  checkUnique("command", commands);
  checkUnique("setting", settings);
  checkUnique("view", views);
  checkUnique("view container", containers);
  checkUnique("walkthrough", walkthroughs);
}

const ALLOWED_KEYS = new Set(["$comment", "activationEvents", "contributes"]);

/**
 * Merge fragments. `fragments` is `[{name, fragment}]`; `core.json` always merges first and the rest in
 * name order, so the output does not depend on the order files are listed in.
 */
export function mergeFragments(fragments) {
  const ordered = [...fragments].sort((a, b) => {
    if (a.name === "core.json") return -1;
    if (b.name === "core.json") return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const { name, fragment } of ordered) {
    if (!isObject(fragment)) throw new ManifestError(`${name} must be a JSON object`);
    for (const key of Object.keys(fragment)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new ManifestError(
          `${name}: unknown top-level key "${key}" (allowed: activationEvents, contributes)`,
        );
      }
    }
  }
  checkDuplicates(ordered);

  const contributes = {};
  const origins = new Map();
  const activationEvents = [];
  for (const { name, fragment } of ordered) {
    const own = structuredClone(fragment.contributes ?? {});
    // Normalise configuration to an array so sections from several fragments sit side by side.
    if (own.configuration !== undefined) own.configuration = configurationSections(own);
    deepMerge(contributes, own, "contributes", name, origins);
    for (const event of fragment.activationEvents ?? []) {
      if (!activationEvents.includes(event)) activationEvents.push(event);
    }
  }
  return { activationEvents, contributes };
}

/** Replace `activationEvents` and `contributes` in a package.json object, keeping its key order. */
export function applyToPackage(pkg, merged) {
  const out = {};
  let placed = false;
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "activationEvents") continue;
    if (key === "contributes") {
      out.activationEvents = merged.activationEvents;
      out.contributes = merged.contributes;
      placed = true;
      continue;
    }
    out[key] = value;
  }
  if (!placed) {
    out.activationEvents = merged.activationEvents;
    out.contributes = merged.contributes;
  }
  return out;
}

export function serialize(pkg) {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
