import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it, vi } from "vitest";
import { HarnessInputError } from "../errors.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import {
  attachSessionConnector,
  chatSdkEndpointId,
  detachSessionConnector,
  listSessionConnectors,
  selectSessionDeliveryTargets,
  setSessionConnectorDelivery,
  webRichEndpointId,
} from "./session-registry.js";

describe("session connector registry", () => {
  it("dedupes endpoints and demotes prior active endpoints to passive", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });

      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await attachSessionConnector(session, {
        connectorId: "web",
        kind: "web-rich",
        delivery: "active",
        endpoint: { id: "u1:chat1", platform: "web", threadId: "chat1", userId: "u1" },
      });

      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "slack", delivery: "passive" },
        { connectorId: "web", delivery: "active" },
      ]);
    });
  });

  it("updates existing endpoints without changing attachedAt", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });

      const first = await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "mirror",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1", label: "Old" },
      });
      const second = await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "mirror",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1", label: "New" },
      });

      expect(second.attachedAt).toBe(first.attachedAt);
      expect(second.updatedAt >= first.updatedAt).toBe(true);
      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "slack", endpoint: { label: "New" } },
      ]);
    });
  });

  it("selects mirror endpoints and skips the active endpoint", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      const active = await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "mirror",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      await attachSessionConnector(session, {
        connectorId: "web",
        kind: "web-rich",
        delivery: "passive",
        endpoint: { id: "u1:chat1", platform: "web", threadId: "chat1", userId: "u1" },
      });

      expect(await selectSessionDeliveryTargets(session, active)).toMatchObject([
        { connectorId: "discord", delivery: "mirror" },
      ]);
    });
  });

  it("returns an empty registry for sessions with no connectors", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });

      await expect(listSessionConnectors(session)).resolves.toEqual([]);
      await expect(selectSessionDeliveryTargets(session)).resolves.toEqual([]);
    });
  });

  it("recovers from a corrupt registry file without bricking the session", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await session.files.writeText("/session/.harness/connectors.json", "{");

      await expect(listSessionConnectors(session)).resolves.toEqual([]);
      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });

      const recovered = (await session.files.list("/session/.harness"))
        .map((entry) => entry.path)
        .filter((path) => path.includes("/connectors.recovered-"));
      expect(recovered).toHaveLength(1);
      expect((await session.files.read(recovered[0]!)).text()).toBe("{");
      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "slack", delivery: "active" },
      ]);
    });
  });

  it("preserves a wrong-shaped registry before replacing it with a recovered registry", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      const badRegistry = {
        version: 1,
        connectors: [{ connectorId: "slack", endpoint: { id: "T1:C1" } }],
      };
      await session.files.writeJSON("/session/.harness/connectors.json", badRegistry);

      await attachSessionConnector(session, {
        connectorId: "web",
        kind: "web-rich",
        delivery: "active",
        endpoint: { id: "u1:chat1", platform: "web", threadId: "chat1", userId: "u1" },
      });

      const recovered = (await session.files.list("/session/.harness"))
        .map((entry) => entry.path)
        .filter((path) => path.includes("/connectors.recovered-"));
      expect(recovered).toHaveLength(1);
      expect((await session.files.read(recovered[0]!)).json()).toEqual(badRegistry);
      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "web", delivery: "active" },
      ]);
    });
  });

  it("detaches a connector by ref and reports whether one was removed", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });

      await expect(
        detachSessionConnector(session, { connectorId: "slack", endpointId: "T1:C1" }),
      ).resolves.toBe(true);
      expect(await listSessionConnectors(session)).toEqual([]);

      await expect(
        detachSessionConnector(session, { connectorId: "slack", endpointId: "T1:C1" }),
      ).resolves.toBe(false);
    });
  });

  it("sets delivery on an existing attachment and clears restore stickiness", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "mirror",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      // Promote to active so a restoreDelivery is recorded, then explicitly override delivery.
      const promoted = await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      expect(promoted).toMatchObject({ delivery: "active", restoreDelivery: "mirror" });

      const updated = await setSessionConnectorDelivery(
        session,
        { connectorId: "discord", endpointId: "guild:channel" },
        "disabled",
      );

      expect(updated.delivery).toBe("disabled");
      expect(updated.restoreDelivery).toBeUndefined();
      const [record] = await listSessionConnectors(session);
      expect(record).toMatchObject({ connectorId: "discord", delivery: "disabled" });
      expect(record?.restoreDelivery).toBeUndefined();
    });
  });

  it("throws when setting delivery on a missing attachment", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await expect(
        setSessionConnectorDelivery(session, { connectorId: "ghost", endpointId: "nope" }, "active"),
      ).rejects.toThrow(HarnessInputError);
    });
  });

  it("demotes the prior active surface to mirror when previousActive is 'mirror'", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await attachSessionConnector(
        session,
        {
          connectorId: "web",
          kind: "web-rich",
          delivery: "active",
          endpoint: { id: "u1:chat1", platform: "web", threadId: "chat1", userId: "u1" },
        },
        { previousActive: "mirror" },
      );

      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "slack", delivery: "mirror" },
        { connectorId: "web", delivery: "active" },
      ]);
    });
  });

  it("keeps a mirror surface mirrored through an active re-attach cycle", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "mirror",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      // The mirrored surface itself replies: re-attached active for the run, but sticky to mirror.
      const promoted = await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      expect(promoted).toMatchObject({ delivery: "active", restoreDelivery: "mirror" });

      // Another surface takes over as active; discord returns to mirror (not passive).
      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });

      const connectors = await listSessionConnectors(session);
      expect(connectors).toMatchObject([
        { connectorId: "discord", delivery: "mirror" },
        { connectorId: "slack", delivery: "active" },
      ]);
      expect(connectors.find((item) => item.connectorId === "discord")?.restoreDelivery).toBeUndefined();
    });
  });

  it("never auto-modifies disabled attachments when another surface goes active", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await attachSessionConnector(session, {
        connectorId: "discord",
        kind: "chat-sdk",
        delivery: "disabled",
        endpoint: { id: "guild:channel", platform: "discord", threadId: "channel" },
      });
      await attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await attachSessionConnector(
        session,
        {
          connectorId: "web",
          kind: "web-rich",
          delivery: "active",
          endpoint: { id: "u1:chat1", platform: "web", threadId: "chat1", userId: "u1" },
        },
        { previousActive: "mirror" },
      );

      expect(await listSessionConnectors(session)).toMatchObject([
        { connectorId: "discord", delivery: "disabled" },
        { connectorId: "slack", delivery: "mirror" },
        { connectorId: "web", delivery: "active" },
      ]);
    });
  });

  it("builds chat-sdk and web-rich endpoint ids in the loader-owned formats", () => {
    expect(chatSdkEndpointId("slack", "T1")).toBe("slack:T1");
    expect(webRichEndpointId("u1", "chat_1")).toBe("u1:chat_1");
  });

  it("warns naming the registry and recovery paths when recovering a corrupt registry", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      await session.files.writeText("/session/.harness/connectors.json", "{");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await listSessionConnectors(session);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain("/session/.harness/connectors.json");
        expect(message).toContain("/session/.harness/connectors.recovered");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("serializes concurrent attachment writes for the same session", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });

      await Promise.all(
        Array.from({ length: 12 }, async (_, index) =>
          attachSessionConnector(session, {
            connectorId: `mirror-${index}`,
            kind: "chat-sdk",
            delivery: "mirror",
            endpoint: { id: `thread-${index}`, platform: "slack", threadId: `thread-${index}` },
          })
        ),
      );

      expect(await listSessionConnectors(session)).toHaveLength(12);
    });
  });

  it("serializes registry reads behind an in-flight attachment write", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });
      const writeJSON = session.files.writeJSON.bind(session.files);
      let releaseWrite!: () => void;
      let writeStarted!: () => void;
      const writeStartedPromise = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });
      const releaseWritePromise = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      session.files.writeJSON = async (...args: Parameters<typeof session.files.writeJSON>) => {
        writeStarted();
        await releaseWritePromise;
        return writeJSON(...args);
      };

      const attachPromise = attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await writeStartedPromise;

      let readSettled = false;
      const readPromise = listSessionConnectors(session).then((connectors) => {
        readSettled = true;
        return connectors;
      });
      await Promise.resolve();
      expect(readSettled).toBe(false);

      releaseWrite();
      await attachPromise;
      await expect(readPromise).resolves.toMatchObject([
        { connectorId: "slack", delivery: "active" },
      ]);
    });
  });

  it("shares the per-session lock map across jiti module graphs via globalThis", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "portable" });

      // A SECOND copy of this module through a fresh jiti instance — the separate module graph that
      // connector modules load through at runtime (see workspace/module-loader.ts). If the lock map
      // were a plain module-level Map, this copy would get its own and would NOT serialize with the
      // statically-imported one.
      const jiti = createJiti(pathToFileURL(join(process.cwd(), "_jiti_root_.js")).href, {
        interopDefault: false,
      });
      const fresh = (await jiti.import(
        resolve(import.meta.dirname, "session-registry.ts"),
      )) as typeof import("./session-registry.js");

      // Hold the lock in the STATIC graph by blocking its registry write.
      const writeJSON = session.files.writeJSON.bind(session.files);
      let releaseWrite!: () => void;
      let writeStarted!: () => void;
      const writeStartedPromise = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });
      const releaseWritePromise = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      session.files.writeJSON = async (...args: Parameters<typeof session.files.writeJSON>) => {
        writeStarted();
        await releaseWritePromise;
        return writeJSON(...args);
      };

      const staticAttach = attachSessionConnector(session, {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: { id: "T1:C1", platform: "slack", threadId: "C1" },
      });
      await writeStartedPromise;

      // An operation issued from the OTHER graph must wait behind the static graph's lock — proof
      // both graphs serialize through the SAME globalThis-backed map.
      let freshReadSettled = false;
      const freshRead = fresh.listSessionConnectors(session).then((connectors) => {
        freshReadSettled = true;
        return connectors;
      });
      await Promise.resolve();
      expect(freshReadSettled).toBe(false);

      releaseWrite();
      await staticAttach;
      await expect(freshRead).resolves.toMatchObject([{ connectorId: "slack", delivery: "active" }]);

      // The map is globalThis-backed under the well-known symbol both graphs resolve.
      expect(
        (globalThis as Record<symbol, unknown>)[
          Symbol.for("little-harness.connectors.sessionRegistryLocks")
        ],
      ).toBeInstanceOf(Map);
    });
  });
});
