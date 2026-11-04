import { InMemoryFs } from "just-bash";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { localWorld } from "./authoring.js";
import {
  appendEvent,
  listEvents,
} from "./entries/internals.js";
import {
  closeEventStoresForTest,
  virtualWorld,
} from "./world.js";

const tempDirs: string[] = [];

async function tempWorld(kind: "local" | "virtual") {
  if (kind === "virtual") return virtualWorld({ fs: new InMemoryFs(), dataDir: "/test-world" });
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-wal-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  // Drop cached DB handles before removing the temp dirs so the WAL files are
  // released and cleanup cannot race an open connection.
  closeEventStoresForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each(["local", "virtual"] as const)("%s event store reopen", (kind) => {
  it("returns committed events in sequence order after the connection is reopened", async () => {
    const world = await tempWorld(kind);

    await appendEvent(world, "run_wal_reopen", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_wal" },
    });
    await appendEvent(world, "run_wal_reopen", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });
    await appendEvent(world, "run_wal_reopen", {
      type: "RunCompleted",
      payload: { output: { ok: true } },
    });

    const beforeReopen = await listEvents(world, "run_wal_reopen");

    // Close all cached connections; the next access reopens the DB from disk,
    // proving disk persistence for localWorld. For virtualWorld this is a reopen
    // over the same filesystem, with no process-crash durability claim.
    closeEventStoresForTest();
    const reopened = world.files === undefined
      ? localWorld({ dataDir: world.dataDir })
      : virtualWorld({ fs: world.files, dataDir: world.dataDir });

    const afterReopen = await listEvents(reopened, "run_wal_reopen");
    expect(afterReopen.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(afterReopen.map((event) => event.type)).toEqual([
      "RunStarted",
      "StepScheduled",
      "RunCompleted",
    ]);
    // Reopened events are byte-for-byte identical to the pre-close view.
    expect(afterReopen).toEqual(beforeReopen);
  });

  it("derives a deterministic eventId from runId + sequence + type + payload", async () => {
    const world = await tempWorld(kind);

    // Identical payload/type/sequence under two different runIds must yield
    // different eventIds (eventId is keyed on runId), and each must match the
    // documented evt_<16-hex> shape.
    const left = await appendEvent(world, "run_wal_id_left", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_wal", n: 1 },
    });
    const right = await appendEvent(world, "run_wal_id_right", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_wal", n: 1 },
    });

    expect(left.eventId).toMatch(/^evt_[0-9a-f]{16}$/);
    expect(right.eventId).toMatch(/^evt_[0-9a-f]{16}$/);
    expect(left.sequence).toBe(1);
    expect(right.sequence).toBe(1);
    expect(left.eventId).not.toBe(right.eventId);

    // The same logical event reproduced from a reopened store keeps its eventId.
    closeEventStoresForTest();
    const reopened = world.files === undefined
      ? localWorld({ dataDir: world.dataDir })
      : virtualWorld({ fs: world.files, dataDir: world.dataDir });
    const [reread] = await listEvents(reopened, "run_wal_id_left");
    expect(reread!.eventId).toBe(left.eventId);
  });
});
