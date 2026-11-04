import * as assert from "node:assert/strict";
import {
  explicitTarget,
  FollowGuard,
  RenderTurns,
  ServerCatalogCache,
  type ServerFetch,
} from "../../../src/features/sidebar/relationsFlow";

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Relations view bookkeeping", () => {
  describe("the language server's index cache", () => {
    it("keeps an answer per client, and asks again for another client or after a drop", async () => {
      const cache = new ServerCatalogCache<string>();
      let asked = 0;
      const ok = (): Promise<ServerFetch> => {
        asked += 1;
        return Promise.resolve({ kind: "ok", catalog: { roots: [] } });
      };
      await cache.get("a", ok);
      await cache.get("a", ok);
      assert.equal(asked, 1);
      await cache.get("b", ok);
      assert.equal(asked, 2);
      cache.drop();
      assert.equal(cache.held, false);
      await cache.get("b", ok);
      assert.equal(asked, 3);
    });

    it("keeps no failure, so Retry asks the server again", async () => {
      const cache = new ServerCatalogCache<string>();
      let asked = 0;
      const failing = (): Promise<ServerFetch> => {
        asked += 1;
        return Promise.resolve({ kind: "failed", message: "timed out" });
      };
      assert.equal((await cache.get("a", failing)).kind, "failed");
      await settle();
      assert.equal(cache.held, false);
      await cache.get("a", failing);
      assert.equal(asked, 2);
    });

    it("keeps an unsupported answer: the server will not grow the request", async () => {
      const cache = new ServerCatalogCache<string>();
      let asked = 0;
      const unsupported = (): Promise<ServerFetch> => {
        asked += 1;
        return Promise.resolve({ kind: "unsupported" });
      };
      await cache.get("a", unsupported);
      await settle();
      await cache.get("a", unsupported);
      assert.equal(asked, 1);
    });
  });

  describe("following the editor", () => {
    it("skips the editor a row opened, once", () => {
      const guard = new FollowGuard();
      const token = guard.open("/ws/o.yaml");
      guard.editorChanged();
      guard.opened(token);
      assert.equal(guard.shouldFollow("/ws/o.yaml"), false);
      assert.equal(guard.shouldFollow("/ws/o.yaml"), true);
    });

    it("skips nothing after a row opened a file that was already active there", () => {
      const guard = new FollowGuard();
      guard.opened(guard.open("/ws/o.yaml"));
      // Later the user really switches to that file: the view follows.
      guard.editorChanged();
      assert.equal(guard.shouldFollow("/ws/o.yaml"), true);
    });

    it("follows another editor at once, and forgets the opened one", () => {
      const guard = new FollowGuard();
      const token = guard.open("/ws/o.yaml");
      guard.editorChanged();
      guard.opened(token);
      assert.equal(guard.shouldFollow("/ws/other.yaml"), true);
      assert.equal(guard.shouldFollow("/ws/o.yaml"), true);
    });
  });

  describe("renders", () => {
    it("draws nothing once the view is disposed", () => {
      const turns = new RenderTurns();
      const pending = turns.begin();
      turns.dispose();
      assert.equal(turns.current(pending.turn), false);
    });

    it("lets the latest render win", () => {
      const turns = new RenderTurns();
      const first = turns.begin();
      const second = turns.begin();
      assert.equal(turns.current(first.turn), false);
      assert.equal(turns.current(second.turn), true);
    });

    it("leaves no Back or Forward behind when a later render supersedes it", () => {
      const turns = new RenderTurns();
      turns.navigate();
      const back = turns.begin();
      assert.equal(back.navigating, true);
      // A catalogue change renders again before Back's render finished; Back's render is dropped.
      const refresh = turns.begin();
      assert.equal(turns.current(back.turn), false);
      assert.equal(refresh.navigating, false);
      // The next object the editor shows goes onto the history.
      assert.equal(turns.begin().navigating, false);
    });
  });

  describe("Show Relations on a file", () => {
    it("shows an object file's object", () => {
      assert.deepEqual(
        explicitTarget({ path: "/ws/objects/rules/r.yaml", scheme: "file", folder: "/ws", isObject: true }),
        { kind: "file", folder: "/ws", file: "/ws/objects/rules/r.yaml" },
      );
    });

    it("leaves the view on its object for a file that holds none, and says why", () => {
      for (const file of [
        { path: "/ws/README.md", scheme: "file", folder: "/ws", isObject: false },
        { path: "/elsewhere/r.yaml", scheme: "file", folder: undefined, isObject: true },
        { path: "/ws/objects/rules/r.yaml", scheme: "git", folder: "/ws", isObject: true },
      ]) {
        const target = explicitTarget(file);
        assert.equal(target.kind, "not-object", file.path);
      }
      const readme = explicitTarget({
        path: "/ws/README.md",
        scheme: "file",
        folder: "/ws",
        isObject: false,
      });
      assert.match(
        readme.kind === "not-object" ? readme.message : "",
        /^README\.md is not an opentide object/,
      );
    });
  });
});
