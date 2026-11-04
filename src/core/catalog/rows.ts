// Telling the catalogue's object rows apart: loaded objects, and files that did not load. vscode-free.
import type { CatalogObject, ObjectType } from "./types";

/** An object row that loaded: it has a UUID, a type and a file, and no `load_error`. */
export type LoadedObject = Omit<CatalogObject, "uuid" | "type" | "path" | "file_path" | "load_error"> & {
  readonly uuid: string;
  readonly type: ObjectType;
  readonly path: string;
  readonly file_path: string;
  readonly load_error: null;
};

/**
 * Whether `row` is a loaded object. A file that did not load is not, even when it carries a UUID: that
 * UUID may be a loaded object's (a copy that no longer parses). A row without a file has nothing to open
 * and is not one either.
 */
export function isLoaded(row: CatalogObject): row is LoadedObject {
  return (
    !row.load_error &&
    typeof row.uuid === "string" &&
    row.uuid !== "" &&
    typeof row.type === "string" &&
    row.type !== "" &&
    typeof row.path === "string" &&
    typeof row.file_path === "string"
  );
}

/** The loaded objects of `rows`. */
export function loadedObjects(rows: readonly CatalogObject[]): LoadedObject[] {
  return rows.filter(isLoaded);
}

/**
 * The key of a row in a map of rows: a loaded object's UUID, else `file:<path>`. A file that did not
 * load never takes a UUID key, so it cannot replace the loaded object that shares its UUID.
 */
export function rowKey(row: CatalogObject): string {
  return isLoaded(row) ? row.uuid : `file:${row.path ?? row.file_path ?? ""}`;
}

/**
 * The row with `uuid`, compared without case: the loaded object, else a file that did not load and
 * carries that UUID (so a link to it still opens the file).
 */
export function findByUuid(rows: readonly CatalogObject[], uuid: string): CatalogObject | undefined {
  const wanted = uuid.toLowerCase();
  let failed: CatalogObject | undefined;
  for (const row of rows) {
    if (row.uuid?.toLowerCase() !== wanted) continue;
    if (isLoaded(row)) return row;
    failed ??= row;
  }
  return failed;
}
