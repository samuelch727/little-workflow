import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emitTrackedMountFileChanges,
  snapshotTrackedMounts,
} from "./shell-runtime.js";
import type { FileWriter, HarnessEventInput, HarnessWorkspaceSpec } from "../types.js";

// An execution environment that writes to a mount OUTSIDE a bash command (a Tier-1
// sandbox syncing its workspace back at dispose, LIT-58) still owes the trace the same
// harness.file.* events the `bash` tool emits. These two helpers are that seam.

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const files = {
  async write() {
    throw new Error("trace spooling is not exercised here");
  },
} as unknown as FileWriter;

describe("tracked mount file events", () => {
  it("reports created, updated, and deleted files between two snapshots", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "kept.txt"), "same");
    await writeFile(join(root, "changed.txt"), "before");
    await writeFile(join(root, "removed.txt"), "gone soon");
    const workspace = workspaceFor(root);

    const before = await snapshotTrackedMounts(workspace);
    await writeFile(join(root, "changed.txt"), "after");
    await rm(join(root, "removed.txt"));
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested/new.txt"), "fresh");
    // Rewriting identical bytes must not look like a change: the diff is by content hash.
    await writeFile(join(root, "kept.txt"), "same");

    const events: HarnessEventInput[] = [];
    await emitTrackedMountFileChanges({
      workspace,
      before,
      emit: async (event) => {
        events.push(event);
      },
      files,
    });

    const byType = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) => event.metadata?.path as string | undefined)
        .filter((path): path is string => path !== undefined);
    expect(byType("harness.file.created")).toEqual(["/session/nested/new.txt"]);
    expect(byType("harness.file.updated")).toEqual(["/session/changed.txt"]);
    expect(byType("harness.file.deleted")).toEqual(["/session/removed.txt"]);
  });

  it("ignores mounts that are not tracked", async () => {
    const root = await temporaryRoot();
    const workspace: HarnessWorkspaceSpec = {
      sessionId: "untracked",
      workingDir: "/session",
      mounts: [{ mountPath: "/session", backingPath: root, mode: "rw" }],
    };
    const before = await snapshotTrackedMounts(workspace);
    expect(before).toEqual({});
    await writeFile(join(root, "invisible.txt"), "not tracked");
    const events: HarnessEventInput[] = [];
    await emitTrackedMountFileChanges({
      workspace,
      before,
      emit: async (event) => {
        events.push(event);
      },
      files,
    });
    expect(events).toEqual([]);
  });
});

function workspaceFor(root: string): HarnessWorkspaceSpec {
  return {
    sessionId: "tracked",
    workingDir: "/session",
    mounts: [
      { mountPath: "/session", backingPath: root, mode: "rw", trackChanges: true },
    ],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lh-tracked-"));
  cleanup.push(root);
  return root;
}
