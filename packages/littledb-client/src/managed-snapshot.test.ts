import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  answerInputRequest,
  createHarness,
  createHarnessSnapshotRegistry,
  generateHarness,
  harnessToolContext,
  listInputRequests,
  localHost,
  resumeParked,
  type SnapshotDigest,
  type HarnessEvent,
} from "@little-stack/harness";
import { digest } from "./harness-contract-v1/harness.js";
import { testLittleDB } from "./testing.js";
import { runInEvalContext, type EvalContext } from "./eval-context.js";

const hash = `sha256:${"a".repeat(64)}` as SnapshotDigest;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "managed-snapshot-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function installation(park = false) {
  let writes = 0;
  let revoked = false;
  const systems: string[] = [];
  const change = tool({
    description: "Change one value",
    inputSchema: z.object({ to: z.string() }).strict(),
    execute: async ({ to }, options) => {
      if (park) {
        const asked = await harnessToolContext(options).ask!(
          { question: `Change to ${to}?`, options: [{ id: "approve", label: "Approve" }] },
          { key: "change", wait: true },
        );
        if (asked.status === "parked") return asked.output;
        if (asked.answer?.option !== "approve") throw new Error("Person did not approve");
      }
      writes++;
      return { changed: to };
    },
  });
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "snapshot",
    doGenerate: async (options) => {
      systems.push(
        options.prompt
          .filter((m) => m.role === "system")
          .map((m) => String(m.content))
          .join("\n"),
      );
      const done = options.prompt.some((m) => m.role === "tool");
      return {
        content: done
          ? [{ type: "text", text: "done" }]
          : [
              {
                type: "tool-call",
                toolCallId: "change",
                toolName: "change",
                input: JSON.stringify({ to: "new" }),
              },
            ],
        finishReason: { unified: done ? "stop" : "tool-calls", raw: done ? "stop" : "tool-calls" },
        usage,
        warnings: [],
      };
    },
  });
  const registry = await createHarnessSnapshotRegistry({
    runtime: hash,
    turnLimits: { maxSteps: 3 },
    tools: { change: { tool: change, implementationHash: hash, effect: "write" } },
    envelope: {
      allowedTools: ["change"],
      requiredTools: ["change"],
      defaultTools: ["change"],
      ownerRules: "OWNER: only approved changes.",
    },
    assertCurrent: () => {
      if (revoked) throw new Error("revoked");
    },
  });
  const content = (name: string) =>
    registry.admit({
      harnessFormat: 1,
      system: name,
      files: {
        "skills/change/SKILL.md": `---\nname: change\ndescription: Change policy\n---\n${name}\n`,
      },
    }).content;
  return {
    registry,
    model,
    change,
    content,
    systems,
    writes: () => writes,
    revoke: () => {
      revoked = true;
    },
  };
}
function context(versionId: string, content: Readonly<Record<string, unknown>> = {}): EvalContext {
  return {
    runId: `run-${versionId}`,
    experimentId: "exp",
    traceId: `trace-${versionId}`,
    subject: { kind: "harness", slug: "snapshot" },
    trace: {
      traceId: `trace-${versionId}`,
      versionId,
      environment: "experiment",
      experimentId: "exp",
    },
    pins: [{ kind: "harness", slug: "snapshot", versionId, content }],
  };
}
describe("managed format-1 execution", () => {
  it("pins exact execution identity in metadata and runs isolated baseline/candidate state", async () => {
    const server = testLittleDB();
    const baseline = await installation();
    const candidate = await installation();
    const seen: HarnessEvent[] = [];
    for (const [index, installed] of [baseline, candidate].entries()) {
      const version = server.setLive("harness:snapshot", installed.content(`VERSION_${index}`));
      const managed = server.db.managedHarness({
        slug: "snapshot",
        bootstrap: installed.content("BOOT"),
        trace: { captureContent: false },
        execution: {
          registry: installed.registry,
          model: installed.model,
          state: () => ({ toolState: digest({ value: "old" }), memorySnapshot: digest(null) }),
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: join(dir, String(index)), sandbox: "in-process" }),
        tools: { change: installed.change },
        executionRegistry: installed.registry,
        runtime: { bash: false },
        turnOptions: managed.turnOptions,
        turnLimits: { maxSteps: 3 },
        onEvent: (e) => {
          seen.push(e);
        },
      });
      const output = await runInEvalContext(
        context(version, installed.content(`VERSION_${index}`)),
        () => generateHarness({ harness, session: "s", prompt: "Change" }),
      );
      expect(output.status).toBe("completed");
      expect(installed.writes()).toBe(1);
      const decision = await runInEvalContext(
        context(version, installed.content(`VERSION_${index}`)),
        () => managed.turnOptions({ sessionId: "probe" }),
      );
      expect(decision.metadata.littledb).toMatchObject({
        versionId: version,
        executionHash: expect.stringMatching(/^sha256:/),
        registryHash: installed.registry.registryHash,
      });
      expect(
        installed.systems.every((s) => s.includes(`VERSION_${index}`) && s.includes("OWNER:")),
      ).toBe(true);
    }
    expect(baseline.writes()).toBe(1);
    expect(candidate.writes()).toBe(1);
    const effects = seen.filter((e) => e.type === "harness.snapshot.tool_effect");
    expect(effects.filter((e) => e.metadata?.outcome === "completed")).toHaveLength(2);
    expect(JSON.stringify(effects)).not.toContain('"to":"new"');
    await server.db.flush();
    const exported = [...server.traces.keys()]
      .flatMap((id) => server.spansOf(id))
      .filter((span) => span.name === "harness.snapshot.tool_effect");
    expect(
      exported.filter(
        (span) =>
          (span.attributes?.harnessSnapshot as { outcome?: string })?.outcome === "completed",
      ),
    ).toHaveLength(2);
    expect(
      exported.every(
        (span) => span.type === "event" && span.input === undefined && span.output === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('"to":"new"');
    const traces = [...server.traces.values()];
    expect(traces).toHaveLength(2);
    expect(
      traces.every((trace) =>
        (trace.metadata?.harnessSnapshot as { executionHash?: string })?.executionHash?.startsWith(
          "sha256:",
        ),
      ),
    ).toBe(true);
  });
  it("exports replay-stable provenance without accidental content and rejects mixed execution identities", async () => {
    const errors: unknown[] = [];
    const server = testLittleDB({
      onError: (error) => {
        errors.push(error);
      },
    });
    const tracer = server.db.harnessTracer({ harness: "snapshot", captureContent: false });
    const event = {
      type: "harness.snapshot.catalog_presented",
      sessionId: "evidence",
      turnId: "turn",
      eventId: "stable",
      timestamp: "2026-11-04T00:00:00.000Z",
      metadata: {
        executionHash: hash,
        registryHash: hash,
        envelopeHash: hash,
        tools: [],
        files: [],
        complete: true,
        body: "SECRET",
        input: { password: "SECRET" },
        output: "SECRET",
      },
    };
    await tracer.onEvent(event);
    await tracer.onEvent(event);
    await tracer.onEvent({
      ...event,
      eventId: "mixed",
      metadata: { ...event.metadata, executionHash: `sha256:${"b".repeat(64)}` },
    });
    await server.db.flush();
    const spans = server
      .spansOf(tracer.traceIdFor("evidence")!)
      .filter((span) => span.type === "event");
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans)).not.toContain("SECRET");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("two execution snapshots");
  });
  it("restores an exact pin after a cold restart and a promotion, while requiring the person's answer", async () => {
    const server = testLittleDB();
    const installed = await installation(true);
    const clients: Array<ReturnType<typeof server.connect>> = [];
    const fresh = () => {
      const client = server.connect();
      clients.push(client);
      const managed = client.managedHarness({
        slug: "snapshot",
        bootstrap: installed.content("BOOT"),
        trace: false,
        execution: {
          registry: installed.registry,
          model: installed.model,
          state: () => ({ toolState: digest(null), memorySnapshot: digest(null) }),
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        tools: { change: installed.change },
        humanInput: { tool: false },
        executionRegistry: installed.registry,
        runtime: { bash: false },
        turnOptions: managed.turnOptions,
      });
      return { managed, harness };
    };
    const version = server.setLive("harness:snapshot", installed.content("ORIGINAL"));
    let current = fresh();
    expect(
      await generateHarness({ harness: current.harness, session: "park", prompt: "Change" }),
    ).toMatchObject({ status: "parked" });
    expect(installed.writes()).toBe(0);
    const original = (await current.managed.session("park")).overrides.executionSnapshot!;
    server.setLive("harness:snapshot", installed.content("PROMOTED"));
    current = fresh();
    const [request] = await listInputRequests({ harness: current.harness, sessionId: "park" });
    await answerInputRequest({
      harness: current.harness,
      sessionId: "park",
      requestId: request!.requestId,
      answer: { option: "approve" },
    });
    const resolves = server.requests.filter((r) => r.path === "/v1/resolve").length;
    const result = await resumeParked({ harness: current.harness, sessionId: "park" });
    expect(result.failed).toEqual([]);
    expect(result.resumed[0]?.result.status).toBe("completed");
    expect(installed.writes()).toBe(1);
    expect(server.requests.filter((r) => r.path === "/v1/resolve")).toHaveLength(resolves);
    const saved = await current.managed.session("park");
    expect(saved.resolution.versionId).toBe(version);
    expect(saved.overrides.executionSnapshot?.executionHash).toBe(original.executionHash);
    expect(installed.systems.at(-1)).toContain("ORIGINAL");
    expect(installed.systems.at(-1)).not.toContain("PROMOTED");
    for (const client of clients) await client.flush();
  });
  it("refuses missing/mismatched eval pins and bootstrap rather than producing candidate evidence", async () => {
    const server = testLittleDB();
    const installed = await installation();
    const managed = server.db.managedHarness({
      slug: "snapshot",
      bootstrap: installed.content("BOOT"),
      trace: false,
      execution: {
        registry: installed.registry,
        model: installed.model,
        state: () => ({ toolState: digest(null), memorySnapshot: digest(null) }),
      },
    });
    const version = server.setLive("harness:snapshot", installed.content("LIVE"));
    await expect(
      runInEvalContext(context("missing-version"), () => managed.turnOptions({ sessionId: "bad" })),
    ).rejects.toThrow();
    const empty = { ...context(version), pins: [] };
    await expect(
      runInEvalContext(empty, () => managed.turnOptions({ sessionId: "missing" })),
    ).rejects.toThrow(/exact pinned/);
    expect(installed.writes()).toBe(0);
    expect(installed.systems).toEqual([]);
    await server.db.flush();
  });
});
