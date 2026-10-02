import { describe, expect, it } from "vitest";
import {
  authoredPlansPersistentDir,
  searchAuthoredPlans,
  writeAuthoredPlan,
  AUTHORED_PLANS_HARNESS_DIR,
} from "./authored-plans-store.js";

// In-memory stub matching the real FileWriter shape the store consumes:
//  - read(path) -> FileData-like ({ text(): string })
//  - list(prefix) -> FileEntry-like ({ path, kind }) with full, directly-readable paths.
function fakeFiles() {
  const store = new Map<string, string>();
  return {
    async writeText(path: string, content: string) {
      store.set(path, content);
    },
    async read(path: string) {
      const v = store.get(path);
      if (v === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return { text: () => v };
    },
    async list(prefix: string) {
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((path) => ({ path, kind: "file" as const }));
    },
    _store: store,
  } as never;
}

const record = {
  runId: "run_a",
  purpose: "validate imports",
  plan: { steps: [] },
  definitionHash: "sha256:x",
  capabilitySnapshot: { tools: ["a"], models: ["default"], bash: false },
  outputSchema: true,
  status: "completed" as const,
  outputSummary: "done",
  createdAt: "2026-07-06T00:00:00Z",
  steps: 2,
};

describe("authored-plans store", () => {
  it("writes then finds a record by purpose substring", async () => {
    const files = fakeFiles();
    await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, record);
    const found = await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "validate");
    expect(found).toHaveLength(1);
    expect(found[0]?.runId).toBe("run_a");
    expect(found[0]?.outputSummary).toBe("done");
  });

  it("returns empty when nothing matches", async () => {
    const files = fakeFiles();
    await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, record);
    expect(await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "unrelated")).toHaveLength(0);
  });

  it("skips a shape-invalid record and still returns the valid one", async () => {
    const files = fakeFiles();
    await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, record);
    // Write two bogus records directly to the store: a `null` and a `{ purpose: 5 }`.
    const prefix = `${AUTHORED_PLANS_HARNESS_DIR}/plans/`;
    const raw = files as { writeText(p: string, c: string): Promise<void> };
    await raw.writeText(`${prefix}bogus_null.json`, JSON.stringify(null));
    await raw.writeText(`${prefix}bogus_shape.json`, JSON.stringify({ purpose: 5 }));
    // An empty query returns every VALID record; the search must not throw on the bogus files.
    const all = await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "");
    expect(all).toHaveLength(1);
    expect(all[0]?.runId).toBe("run_a");
    // And a substring query over `purpose` still finds the valid record.
    const found = await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "validate");
    expect(found).toHaveLength(1);
  });

  it("caps returned records at 10 (completed-first)", async () => {
    const files = fakeFiles();
    for (let i = 0; i < 15; i += 1) {
      await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, {
        ...record,
        runId: `run_${i}`,
        purpose: "cap probe",
      });
    }
    const found = await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "cap probe");
    expect(found).toHaveLength(10);
  });

  it("overwrites the same runId (running -> completed)", async () => {
    const files = fakeFiles();
    const { outputSummary: _drop, ...runningBase } = record;
    await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, {
      ...runningBase,
      status: "running",
    });
    await writeAuthoredPlan(files, AUTHORED_PLANS_HARNESS_DIR, record);
    const found = await searchAuthoredPlans(files, AUTHORED_PLANS_HARNESS_DIR, "validate");
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe("completed");
  });
});

describe("authoredPlansPersistentDir", () => {
  it("registers the /persistent/dynamic-plans mount with an after-turn commit policy", () => {
    const dir = authoredPlansPersistentDir();
    expect(dir.harnessDir).toBe(AUTHORED_PLANS_HARNESS_DIR);
    expect(dir.commit).toBe("after-turn");
  });
});
