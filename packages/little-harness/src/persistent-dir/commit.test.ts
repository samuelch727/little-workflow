import { describe, expect, it } from "vitest";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { withTempDir } from "../test/temp.js";
import { preparePersistentDirs } from "./commit.js";

describe("persistent dir commit", () => {
  it("loads files into harnessDir and commits changes after turn", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const stores: unknown[] = [];
      const prepared = await preparePersistentDirs({
        hostPaths,
        session,
        extraBody: { userId: "u1" },
        persistentDirs: [
          {
            harnessDir: "/persistent/user",
            load: async () => ({ "prefs.md": "hello" }),
            store: async (input) => {
              stores.push(input);
            },
          },
        ],
      });

      await prepared.load();
      expect((await session.files.read("/persistent/user/prefs.md")).text()).toBe("hello");
      await session.files.writeText("/persistent/user/prefs.md", "updated");
      await session.files.writeText("/persistent/user/new.md", "new");

      const status = await prepared.commit();
      expect(status.status).toBe("succeeded");
      expect(stores).toHaveLength(1);
      expect(Object.keys((stores[0] as any).changes.updated)).toEqual(["prefs.md"]);
      expect(Object.keys((stores[0] as any).changes.created)).toEqual(["new.md"]);
      expect(Object.keys((stores[0] as any).snapshot)).toEqual(["new.md", "prefs.md"]);
    });
  });

  it("emits Persistent Dir load and commit metadata for trace inspection", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const events: any[] = [];
      const prepared = await preparePersistentDirs({
        hostPaths,
        session,
        persistentDirs: [
          {
            harnessDir: "/persistent/user",
            load: async () => ({
              "notes/a.md": "before",
              "delete.md": "delete me",
            }),
            store: async () => {},
          },
        ],
      });

      await prepared.load({
        emit: async (event) => {
          events.push(event);
        },
      });
      await session.files.writeText("/persistent/user/notes/a.md", "after");
      await session.files.writeText("/persistent/user/new.md", "new");
      await session.files.remove("/persistent/user/delete.md");
      await prepared.commit({
        emit: async (event) => {
          events.push(event);
        },
      });

      expect(events.find((event) => event.type === "harness.persistent_dir.loaded")).toMatchObject({
        metadata: {
          harnessDir: "/persistent/user",
          commit: "after-turn",
          durationMs: expect.any(Number),
          fileCount: 2,
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "/persistent/user/notes/a.md",
              bytes: 6,
              sha256: expect.any(String),
            }),
            expect.objectContaining({
              path: "/persistent/user/delete.md",
              bytes: 9,
              sha256: expect.any(String),
            }),
          ]),
        },
      });
      expect(events.find((event) => event.type === "harness.persistent_dir.commit.started")).toMatchObject({
        metadata: {
          harnessDir: "/persistent/user",
          commit: "after-turn",
          changeCounts: { created: 1, updated: 1, deleted: 1 },
        },
      });
      expect(events.find((event) => event.type === "harness.persistent_dir.commit.succeeded")).toMatchObject({
        metadata: {
          harnessDir: "/persistent/user",
          commit: "after-turn",
          changeCounts: { created: 1, updated: 1, deleted: 1 },
          changes: {
            created: [
              expect.objectContaining({ path: "/persistent/user/new.md", bytes: 3 }),
            ],
            updated: [
              expect.objectContaining({ path: "/persistent/user/notes/a.md", bytes: 5 }),
            ],
            deleted: [
              expect.objectContaining({ path: "/persistent/user/delete.md" }),
            ],
          },
        },
      });
    });
  });

  it("rejects writes to read-only persistent dirs and skips store", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      let called = false;
      const prepared = await preparePersistentDirs({
        hostPaths,
        session,
        persistentDirs: [
          {
            harnessDir: "/persistent/company/",
            commit: "read-only",
            load: async () => ({ "handbook.md": "read this" }),
            store: async () => {
              called = true;
            },
          },
        ],
      });

      await prepared.load();
      await expect(
        session.files.writeText("/persistent/company/handbook.md", "changed"),
      ).rejects.toThrow(/read-only/);
      const status = await prepared.commit();
      if (status.status !== "succeeded") {
        throw new Error(`Expected succeeded status, got ${status.status}`);
      }
      expect(status.commits[0]?.status).toBe("skipped");
      expect(called).toBe(false);
    });
  });

  it("reports commit failures without deleting checkout files", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const prepared = await preparePersistentDirs({
        hostPaths,
        session,
        persistentDirs: [
          {
            harnessDir: "/persistent/user",
            load: async () => ({}),
            store: async () => {
              throw new Error("storage down");
            },
          },
        ],
      });

      await prepared.load();
      await session.files.writeText("/persistent/user/recover.md", "still here");
      const events: any[] = [];
      const status = await prepared.commit({
        emit: async (event) => {
          events.push(event);
        },
      });
      expect(status.status).toBe("failed");
      expect((await session.files.read("/persistent/user/recover.md")).text()).toBe("still here");
      expect(events.find((event) => event.type === "harness.persistent_dir.commit.failed")).toMatchObject({
        metadata: {
          harnessDir: "/persistent/user",
          commit: "after-turn",
          durationMs: expect.any(Number),
          error: { name: "Error", message: "storage down" },
          changeCounts: { created: 1, updated: 0, deleted: 0 },
        },
      });
    });
  });
});
