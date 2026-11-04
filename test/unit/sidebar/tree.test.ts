// NodeTree against the vscode stub: which elements a refresh names.
import * as assert from "node:assert/strict";
import type { TreeNode } from "../../../src/features/sidebar/node";
import { NodeTree } from "../../../src/features/sidebar/tree";

const node = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, label: id, ...extra });
const model = (child: Partial<TreeNode> = {}) => ({
  nodes: [node("a", { collapsed: "expanded", children: [node("a/1", child), node("a/2")] }), node("b")],
});

describe("NodeTree refreshes", () => {
  let tree: NodeTree;
  let fired: (TreeNode | TreeNode[] | undefined)[];

  beforeEach(() => {
    tree = new NodeTree("test.view");
    fired = [];
    tree.onDidChangeTreeData((e) => fired.push(e));
  });
  afterEach(() => tree.dispose());

  it("names a changed row as the object VS Code was handed, though the model was rebuilt since", () => {
    tree.set(model());
    const [a] = tree.getChildren();
    assert.ok(a);
    const handed = tree.getChildren(a)[0];
    // A rebuild with nothing changed: new objects VS Code never saw, and no refresh.
    tree.set(model());
    assert.equal(fired.length, 1);
    assert.equal(fired[0], undefined);
    tree.set(model({ description: "2 errors" }));
    assert.equal(fired.length, 2);
    const refreshed = fired[1];
    assert.ok(Array.isArray(refreshed));
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0], handed);
    // VS Code then reads that element's row: the latest one, by id.
    assert.ok(handed);
    assert.equal(tree.getTreeItem(handed).description, "2 errors");
  });

  it("refreshes a row whose decorations change", () => {
    tree.set(model());
    const [a] = tree.getChildren();
    assert.ok(a);
    tree.getChildren(a);
    tree.set(model({ open: { path: "/ws/r.yaml", line: 0 } }));
    tree.set(model({ open: { path: "/ws/r.yaml", line: 0 }, decorate: false }));
    assert.equal(fired.length, 3);
    assert.ok(tree.getTreeItem(tree.getChildren(a)[0] ?? a).resourceUri === undefined);
  });

  it("refreshes the whole tree when its top level changes", () => {
    tree.set(model());
    tree.set({ nodes: [node("b")] });
    assert.deepEqual(fired, [undefined, undefined]);
  });
});
