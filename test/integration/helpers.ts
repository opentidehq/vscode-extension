import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension";

/**
 * The id of the extension under test, from the repository's package.json (out/test/integration/ is three levels
 * down): the publisher differs between the stores' packages (docs/RELEASING.md), so it is not a literal.
 */
const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8")) as {
  publisher: string;
  name: string;
};
export const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

/** Activate the extension and return its test API (the FeatureContext). */
export async function activated(): Promise<Required<ExtensionApi>> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is installed`);
  const api = await extension.activate();
  assert.ok(api.ctx, "the test API exposes the feature context");
  await api.started;
  return api as Required<ExtensionApi>;
}

export function fixture(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the fixture workspace is open");
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
