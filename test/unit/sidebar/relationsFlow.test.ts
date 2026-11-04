import * as assert from "node:assert/strict";
import {
  FollowGuard,
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
});
