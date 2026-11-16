import { traceContentStoreFor } from "./storage.js";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { LocalSessionStore } from "../local-host/session-store.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { withTempDir } from "../test/temp.js";
import { listLocalFiles, latestDiffForPath, doctorSession, type TraceEvent } from "./inspect.js";
import type { HarnessTraceEventType } from "./validate.js";

describe("trace inspection types", () => {
  it.each(["/artifacts/trace/legacy.diff", "/.little-harness/trace/file-diffs/new.diff"])("hydrates and counts %s", async ref => {
    await withTempDir(async dir => {
      const store = new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir));
      const session = await store.getOrCreate({ id: "inspect-spill" });
      const content = "@@ -1 +1 @@\n-old\n+new\n";
      if (ref.startsWith("/artifacts/")) await session.files.writeText(ref, content);
      else await traceContentStoreFor(session.files)!.write(ref, content);
      const event = {
        schemaVersion: "lh.trace.v2", eventId: "evt_diff", sequence: 1,
        sessionId: session.id, timestamp: "2026-11-12T00:00:00.000Z", type: "harness.file.updated",
        metadata: { path: "/session/note.md", root: "session", before: { bytes: 4, sha256: "b".repeat(64) }, after: { bytes: 4, sha256: "a".repeat(64) },
          diff: { available: true, format: "unified", truncated: true, contentRef: ref } },
      };
      await writeFile(session.paths.traceFile, JSON.stringify(event) + "\n");
      const options = { dataDir: dir, sessionId: session.id, cwd: dir };
      expect((await latestDiffForPath({ ...options, path: "/session/note.md" }))?.diff).toMatchObject({ content });
      expect(await doctorSession(options)).toMatchObject({ invalidEventCount: 0, contentRefCount: 1, largeTraceArtifactCount: 1 });
    });
  });
  it("types read trace events with the full trace event vocabulary", () => {
    expectTypeOf<TraceEvent["type"]>().toEqualTypeOf<HarnessTraceEventType>();
    expectTypeOf<"harness.execute_step.started">().toMatchTypeOf<TraceEvent["type"]>();
  });

  it("lists .agents skill files", async () => {
    await withTempDir(async (dir) => {
      const store = new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir));
      const session = await store.getOrCreate({ id: "inspect-agents" });
      const skillDir = path.join(session.paths.agentsDir, "skills", "review");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), "review", "utf8");

      const files = await listLocalFiles({ dataDir: dir, sessionId: "inspect-agents", cwd: dir });

      expect(files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/.agents/skills/review/SKILL.md", kind: "file" }),
        ]),
      );
    });
  });
});
