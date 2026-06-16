import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test/temp.js";
import { resolveLocalHostPaths } from "./paths.js";
import { LocalSessionStore } from "./session-store.js";

describe("LocalSessionStore", () => {
  it("creates the documented local session folders", async () => {
    await withTempDir(async (dir) => {
      const store = new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir));
      const session = await store.getOrCreate({ id: "chat_123" });

      expect(session.id).toBe("chat_123");
      expect(existsSync(session.paths.sessionDir)).toBe(true);
      expect(existsSync(session.paths.artifactsDir)).toBe(true);
      expect(existsSync(session.paths.turnsDir)).toBe(true);
      expect((await session.status()).state).toBe("idle");
    });
  });

  it("resumes a stable session key across store instances", async () => {
    await withTempDir(async (dir) => {
      const paths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const first = await new LocalSessionStore(paths).getOrCreate({ id: "chat_123" });
      await first.files.writeText("/session/note.md", "hello");

      const second = await new LocalSessionStore(paths).getOrCreate({ id: "chat_123" });
      expect((await second.files.read("/session/note.md")).text()).toBe("hello");
    });
  });

  it("tracks staged message ids idempotently", async () => {
    await withTempDir(async (dir) => {
      const store = new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir));
      const session = await store.getOrCreate({ id: "chat_123" });

      await session.markMessageStaged("msg_1");
      await session.markMessageStaged("msg_1");

      expect((await session.status()).stagedMessageIds).toEqual(["msg_1"]);
      expect(await store.get("missing")).toBeUndefined();
    });
  });
});

describe("LocalTrace", () => {
  it("appends events as newline-delimited JSON", async () => {
    await withTempDir(async (dir) => {
      const { LocalTrace } = await import("./trace.js");
      const trace = new LocalTrace(`${dir}/trace.ndjson`);

      await trace.append({
        type: "harness.session.started",
        sessionId: "chat_123",
        timestamp: "2026-06-03T00:00:00.000Z",
      });

      const lines = (await readFile(`${dir}/trace.ndjson`, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: "harness.session.started",
        sessionId: "chat_123",
      });
      expect(trace.ref.path).toBe(`${dir}/trace.ndjson`);
    });
  });

  it("persists nested binary metadata as summaries", async () => {
    await withTempDir(async (dir) => {
      const { LocalTrace } = await import("./trace.js");
      const trace = new LocalTrace(`${dir}/trace.ndjson`);
      const arrayBuffer = new Uint8Array([4, 5, 6]).buffer;
      const dataViewBuffer = new Uint8Array([7, 8, 9, 10]).buffer;

      await trace.append({
        type: "harness.session.started",
        sessionId: "chat_123",
        timestamp: "2026-06-03T00:00:00.000Z",
        metadata: {
          apiKey: "secret-api-key",
          payload: {
            buffer: Buffer.from([1, 2, 3]),
            arrayBuffer,
            nested: [
              { uint8: new Uint8Array([11, 12]) },
              { view: new DataView(dataViewBuffer, 1, 2) },
            ],
          },
        },
      });

      const persisted = JSON.parse(await readFile(`${dir}/trace.ndjson`, "utf8")) as {
        metadata: {
          payload: {
            buffer: unknown;
            arrayBuffer: unknown;
            nested: [{ uint8: unknown }, { view: unknown }];
          };
        };
      };

      expect(persisted.metadata.payload.buffer).toEqual(binarySummary([1, 2, 3]));
      expect(persisted.metadata.payload.arrayBuffer).toEqual(binarySummary([4, 5, 6]));
      expect(persisted.metadata.payload.nested[0].uint8).toEqual(binarySummary([11, 12]));
      expect(persisted.metadata.payload.nested[1].view).toEqual(binarySummary([8, 9]));
      expect(persisted.metadata).toMatchObject({ apiKey: "[redacted]" });
      expect(JSON.stringify(persisted.metadata)).not.toContain("secret-api-key");
      expect(JSON.stringify(persisted.metadata)).not.toContain('"0":');
    });
  });
});

function binarySummary(bytes: number[]) {
  return {
    binary: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"),
  };
}
