// The language server's `opentide/catalog` index on the desktop: a folder's root found by path, and the
// catalogue document built from it, on a runtime without `info catalog` (src/engine/catalog.ts parses
// it and turns its references into relations). vscode-free.
import * as path from "node:path";
import { SERVER_CATALOG, type ServerCatalog, type ServerRoot, serverRelations } from "../../engine/catalog";
import { fileUriPath, pathInside } from "./symbols";
import type { CatalogDocument, CatalogObject } from "./types";

export * from "../../engine/catalog";

/** The root of `folder` (a path), compared as paths: the server's URIs are not VS Code's spelling. */
export function rootOf(
  catalog: ServerCatalog,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): ServerRoot | undefined {
  const lib = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) => {
    const resolved = lib.resolve(value);
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  const wanted = fold(folder);
  return catalog.roots.find((root) => {
    const file = root.root ? fileUriPath(root.root, platform) : undefined;
    return file !== undefined && fold(file) === wanted;
  });
}

/**
 * A folder's catalogue document built from its root in the server's index, for a runtime without
 * `info catalog` that runs the language server (the engine, or `opentide-lsp`): every object with its
 * name, type, schema and file, and the edges and signals of its references. What only opentide knows is
 * empty: platforms, deployment, techniques, tactics, actors, log sources and the ATT&CK skeleton.
 * Objects outside the folder (a host-supplied stub, another root) are left out.
 */
export function serverCatalogDocument(
  root: ServerRoot,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): CatalogDocument {
  const lib = platform === "win32" ? path.win32 : path.posix;
  const inFolder = root.objects.filter((object) => {
    const file = fileUriPath(object.uri, platform);
    return file !== undefined && pathInside(folder, file, platform);
  });
  const objects: CatalogObject[] = inFolder.map((object) => {
    const file = fileUriPath(object.uri, platform) ?? object.uri;
    return {
      uuid: object.uuid,
      type: object.object_type,
      schema: object.schema,
      name: object.name,
      path: lib.relative(folder, file).replaceAll("\\", "/"),
      file_path: file,
      line: object.range.start.line + 1,
      platforms: [],
      deployment: [],
      techniques: { own: [], inherited: [] },
      tactics: [],
      actors: [],
      load_error: null,
    };
  });
  const { edges, signals } = serverRelations(inFolder);
  const count = (type: string) => objects.filter((object) => object.type === type).length;
  return {
    ok: true,
    status: "ok",
    message: "From the language server's index (opentide/catalog)",
    schema_version: 1,
    command: SERVER_CATALOG,
    duration_ms: 0,
    exit_code: 0,
    next_actions: [],
    failure: null,
    objects,
    edges,
    signals: signals.map(({ line: _line, ...signal }) => signal),
    attack: { tactics: [], techniques: {} },
    summary: {
      objects: objects.length,
      threats: count("threat"),
      objectives: count("objective"),
      rules: count("rule"),
      signals: signals.length,
      edges: edges.length,
      load_errors: 0,
    },
  };
}
