import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { LocalSessionStore } from "../local-host/session-store.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { withTempDir } from "../test/temp.js";
import { listLocalFiles, type TraceEvent } from "./inspect.js";
import type { HarnessTraceEventType } from "./validate.js";

describe("trace inspection types", () => {
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
