import { expect, it } from "vitest";
import { resolveAgentGroupsOptions } from "../agents/tools.js";
import {
  assembleTurnTools,
  bashSnapshotFromRuntime,
  disposeTurnRuntime,
  dynamicAllowedCapabilities,
  runtimeUsageOf,
} from "./turn-tools.js";
import { validateTraceEvent } from "../trace/validate.js";
import type { ResolvedDynamicWorkflows } from "../dynamic-workflows/config.js";
import { createInMemoryOrchestrationServices } from "../local-host/in-memory-orchestration-services.js";
import type { HarnessSandbox, HarnessSession, ResolvedHarnessConfig } from "../types.js";

// --- Task 8 discovery: how the harness exposes bash to a child run ---
//
// The harness does NOT carry a `BashCapabilities`-typed object that is available
// where the parent snapshot is built. The bash *tool* is `runtime.shellTool()`,
// created lazily by `prepared.createSandbox(...)` in generate-harness.ts:268 —
// AFTER `assembleTurnTools` runs at :206. So at snapshot-build time there is no
// shell tool to capture, and `runtime.shellTool()` carries an `execute` fn that
// must never enter the snapshot (the snapshot is serialized and hashed into the
// child's `definitionIdentity`).
//
// What IS in scope at snapshot time is `config.runtime` (`HarnessRuntimeOptions`),
// which carries the bash enablement toggle plus the structurally
// BashCapabilities-shaped fields:
//   - `bash?: boolean`   default ON (bash present unless explicitly `=== false`)
//   - `python?: boolean`
//   - `javascript?: boolean`
//   - `network?: boolean | HarnessNetworkPolicy`
// `bashSnapshotFromRuntime` derives a serializable `{ default: {network,python,javascript} }`
// from those, and stores it under `snapshot.bash`. When bash is disabled it yields
// an empty record so `dynamicAllowedCapabilities` reports `bash:false`.
//
// TASK 10 THREADING TARGET: the derived caps in `snapshot.bash.default` map onto
// `executeWorkflowVersion` options `bashCapabilities?: BashCapabilities`
// (little-workflow/src/runtime.ts:209). Note `HarnessRuntimeOptions.network` is
// `boolean | HarnessNetworkPolicy` while `BashCapabilities.network` is
// `BashNetworkCapabilities` — Task 10 normalizes that mapping. The parallel for the
// model slot is `config.model` -> options `models.default` (runtime.ts:202); the
// snapshot has no `models` field, `dynamicAllowedCapabilities` derives `["default"]`.

it("derives allowed capabilities from a snapshot, minus exclude", () => {
  const allowed = dynamicAllowedCapabilities(
    { tools: { a: {}, b: {} }, mcpTools: { m: {} }, bash: { default: {} } },
    ["b"],
  );
  expect(allowed.tools.slice().sort()).toEqual(["a", "m"]);
  expect(allowed.bash).toBe(true);
  expect(allowed.models).toEqual(["default"]);
});

it("reports bash:false when the snapshot has no bash", () => {
  const allowed = dynamicAllowedCapabilities({ tools: {}, mcpTools: {} }, []);
  expect(allowed.bash).toBe(false);
});

it("reports bash:false when bash is explicitly excluded", () => {
  const allowed = dynamicAllowedCapabilities(
    { tools: { a: {} }, mcpTools: {}, bash: { default: {} } },
    ["bash"],
  );
  expect(allowed.bash).toBe(false);
});

it("snapshots bash as present when runtime is undefined (default-on)", () => {
  const bash = bashSnapshotFromRuntime(undefined);
  expect(Object.keys(bash).length).toBeGreaterThan(0);
  expect(dynamicAllowedCapabilities({ tools: {}, mcpTools: {}, bash }, []).bash).toBe(true);
});

it("carries derived BashCapabilities under snapshot.bash.default when enabled", () => {
  const bash = bashSnapshotFromRuntime({ python: true, javascript: false, network: false });
  expect(bash).toEqual({ default: { python: true, javascript: false, network: false } });
});

it("snapshots bash as absent when runtime.bash is false", () => {
  const bash = bashSnapshotFromRuntime({ bash: false });
  expect(bash).toEqual({});
  expect(dynamicAllowedCapabilities({ tools: {}, mcpTools: {}, bash }, []).bash).toBe(false);
});

// --- Task 11: dynamic-workflow tools appear in per-turn assembly only when enabled ---

async function assembleForTest(opts: {
  dynamic: ResolvedDynamicWorkflows | undefined;
  agents?: boolean;
}) {
  const config = {
    host: {},
    model: {},
    tools: {},
    skills: [],
    persistentDirs: [],
    memory: [],
    trace: {},
    workflowBudgets: {},
    workflows: [],
    ...(opts.dynamic ? { dynamicWorkflows: opts.dynamic } : {}),
    ...(opts.agents
      ? {
          agents: resolveAgentGroupsOptions({
            launcher: {
              startAgentGroup: async () => { throw new Error("not executed"); },
              watchAgentGroup: async () => { throw new Error("not executed"); },
              joinAgentGroup: async () => { throw new Error("not executed"); },
              cancelAgentGroup: async () => { throw new Error("not executed"); },
            },
            profiles: [{
              handle: "worker",
              resourcesHandle: "resources",
              secretsHandle: "secrets",
              toolsHandle: "tools",
              networkHandle: "network",
              priorityHandle: "priority",
            }],
            joinPolicies: [{ handle: "all", policy: { kind: "all_success" } }],
            defaultJoinPolicyHandle: "all",
            reductionPolicies: [{
              handle: "concise",
              maxMemberSummaryBytes: 128,
              maxGroupSummaryBytes: 256,
              maxResultRefs: 4,
            }],
            defaultReductionPolicyHandle: "concise",
          }),
        }
      : {}),
  } as unknown as ResolvedHarnessConfig;
  const session = { id: "session-11" } as unknown as HarnessSession;
  return assembleTurnTools({
    config,
    baseTools: {},
    session,
    turnId: "turn-11",
    orchestration: opts.agents ? createInMemoryOrchestrationServices() : undefined,
  });
}

it("adds dynamic-workflow tools only when dynamicWorkflows is configured", async () => {
  const withoutDynamic = await assembleForTest({ dynamic: undefined });
  expect(withoutDynamic.turnTools).not.toHaveProperty("run_ad_hoc_plan");
  expect(withoutDynamic.turnTools).not.toHaveProperty("start_agent_group");
  expect(withoutDynamic.turnTools).not.toHaveProperty("spawn_agent");
  expect(withoutDynamic.manifest.agentGroupToolNames).toEqual([]);
  await withoutDynamic.mcp.close();

  const withDynamic = await assembleForTest({
    dynamic: {
      factory: { compile: () => ({ ok: false, causeCode: "plan_invalid", message: "x" }) },
      exclude: [],
      limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
    },
  });
  expect(withDynamic.turnTools).toHaveProperty("run_ad_hoc_plan");
  expect(withDynamic.turnTools).toHaveProperty("search_authored_plans");
  await withDynamic.mcp.close();
});

// --- Agent-defined workflows: a registry decides which ones a turn offers ---

it("offers the agent-defined workflows the registry resolves, and none when it fails", async () => {
  const stored = (id: string, handle: string, sessionId: string) => ({
    id,
    handle,
    description: `Workflow ${id}.`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    tools: [],
    revision: 1,
    definedAt: "2026-10-14T00:00:00.000Z",
    sessionId,
  });
  const store = new Map<string, string>([
    ["/persistent/dynamic-plans/workflows/approved_one.json", JSON.stringify(stored("approved.one", "approved_one", "s0"))],
    ["/persistent/dynamic-plans/workflows/draft_one.json", JSON.stringify(stored("draft.one", "draft_one", "s0"))],
  ]);
  const files = {
    async list(prefix: string) {
      return [...store.keys()].filter((path) => path.startsWith(prefix)).map((path) => ({ path, kind: "file" as const }));
    },
    async read(path: string) {
      const text = store.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { text: () => text };
    },
  };
  const factory = {
    compile: () => ({ ok: false as const, causeCode: "plan_invalid" as const, message: "x" }),
    define: (definition: { id: string }) => ({
      ok: true as const,
      workflow: {
        id: definition.id,
        executionMode: "inline" as const,
        definitionIdentity: "sha256:x",
        inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
        runForHarness: async () => { throw new Error("not run"); },
      },
    }),
  };
  const seen: Array<{ handles: string[]; ctx: unknown }> = [];
  const assemble = (resolve: (records: readonly { handle: string }[]) => unknown) =>
    assembleTurnTools({
      config: {
        host: {},
        model: {},
        tools: {},
        skills: [],
        persistentDirs: [],
        memory: [],
        trace: {},
        workflowBudgets: {},
        workflows: [],
        dynamicWorkflows: {
          factory,
          exclude: [],
          limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
          define: true,
          registry: {
            resolve: (records: readonly { handle: string }[], ctx: unknown) => {
              seen.push({ handles: records.map((r) => r.handle), ctx });
              return resolve(records);
            },
          },
        },
      } as unknown as ResolvedHarnessConfig,
      baseTools: {},
      session: { id: "s1" } as unknown as HarnessSession,
      turnId: "turn-1",
      orchestration: undefined,
      files: files as never,
    });

  const approvedOnly = await assemble((records) => records.filter((r) => r.handle === "approved_one"));
  expect(approvedOnly.turnTools).toHaveProperty("approved_one");
  expect(approvedOnly.turnTools).not.toHaveProperty("draft_one");
  expect(approvedOnly.turnTools).toHaveProperty("define_workflow");
  expect(seen[0]).toEqual({ handles: ["approved_one", "draft_one"], ctx: { sessionId: "s1", turnId: "turn-1" } });
  await approvedOnly.mcp.close();

  const failing = await assemble(() => {
    throw new Error("registry offline");
  });
  expect(failing.turnTools).not.toHaveProperty("approved_one");
  expect(failing.turnTools).toHaveProperty("define_workflow");
  expect(failing.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining("registry offline"));
  await failing.mcp.close();
});

// --- LIT-35: the turn's workflow tools carry the harness's workflow-run budgets ---

it("wires config.workflowBudgets into the assembled workflow tools", async () => {
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const workflow = {
    id: "candidate.review",
    description: "Review a candidate.",
    inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
    executionMode: "inline" as const,
    definitionIdentity: "sha256:turn-tools-budget",
    async runForHarness(_input: unknown, ctx: { reservedRunId: string }) {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise<void>((resolve) => state.gates.push(resolve));
      state.inFlight -= 1;
      return {
        protocolVersion: 1 as const,
        status: "completed" as const,
        output: { ok: true },
        runId: ctx.reservedRunId,
      };
    },
  };
  const config = {
    host: {},
    model: {},
    tools: {},
    skills: [],
    persistentDirs: [],
    memory: [],
    trace: {},
    workflowBudgets: { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 100 },
    workflows: [workflow],
  } as unknown as ResolvedHarnessConfig;
  const assembled = await assembleTurnTools({
    config,
    baseTools: {},
    session: { id: "session-lit-35" } as unknown as HarnessSession,
    turnId: "turn-lit-35",
    orchestration: undefined,
  });

  const calls = [0, 1, 2].map((n) =>
    assembled.turnTools.candidate_review?.execute?.({}, { toolCallId: `call_${n}` } as never));
  for (let released = 0; released < 3; released += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.inFlight).toBeLessThanOrEqual(1);
    state.gates.shift()?.();
  }
  await Promise.all(calls);
  expect(state.peak).toBe(1);
  await assembled.mcp.close();
});

// --- LIT-44: workflow event stores live under the host's session data dir, not cwd ---

it("roots a turn's workflow stores in the session data dir", async () => {
  const seen: string[] = [];
  const workflow = {
    id: "store.probe",
    description: "Report where the run would persist.",
    inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
    executionMode: "inline" as const,
    definitionIdentity: "sha256:turn-tools-data-dir",
    async runForHarness(
      _input: unknown,
      ctx: { reservedRunId: string; persistence: { dataDir: string } },
    ) {
      seen.push(ctx.persistence.dataDir);
      return {
        protocolVersion: 1 as const,
        status: "completed" as const,
        output: { ok: true },
        runId: ctx.reservedRunId,
      };
    },
  };
  const config = {
    host: {},
    model: {},
    tools: {},
    skills: [],
    persistentDirs: [],
    memory: [],
    trace: {},
    workflows: [workflow],
  } as unknown as ResolvedHarnessConfig;
  const assemble = (session: Partial<HarnessSession>) =>
    assembleTurnTools({
      config,
      baseTools: {},
      session: session as HarnessSession,
      turnId: "turn-lit-44",
      orchestration: undefined,
    });

  const local = await assemble({ id: "session-lit-44", dataDir: "/data/sessions/session-lit-44" });
  await local.turnTools.store_probe?.execute?.({}, { toolCallId: "call_local" } as never);
  await local.mcp.close();
  // A custom host with no data dir keeps the historical relative path.
  const custom = await assemble({ id: "session-lit-44" });
  await custom.turnTools.store_probe?.execute?.({}, { toolCallId: "call_custom" } as never);
  await custom.mcp.close();

  expect(seen).toEqual(["/data/sessions/session-lit-44/workflows", "session-lit-44/workflows"]);
});

it("lists and injects Agent Group tools only when agents is configured", async () => {
  const configured = await assembleForTest({ dynamic: undefined, agents: true });
  expect(configured.manifest.agentGroupToolNames).toEqual([
    "cancel_agent_group",
    "join_agent_group",
    "spawn_agent",
    "start_agent_group",
    "watch_agent_group",
  ]);
  expect(configured.turnTools).toHaveProperty("start_agent_group");
  expect(configured.turnTools).toHaveProperty("spawn_agent");
  await configured.mcp.close();
});

// --- LIT-58: turn teardown must not be silent ---
//
// Disposal is where a Tier-1 execution environment syncs the sandbox workspace back to
// the host. Swallowing that failure would turn data loss into a no-op, so it is reported
// as one `harness.runtime.dispose.failed` event — and reporting still never throws.

it("emits harness.runtime.dispose.failed when the runtime's dispose throws", async () => {
  const events: { type: string; metadata?: Record<string, unknown> }[] = [];
  await disposeTurnRuntime(
    {
      dispose: async () => {
        throw new Error("workspace sync-back failed");
      },
    } as unknown as HarnessSandbox,
    async (event) => {
      events.push(event as { type: string; metadata?: Record<string, unknown> });
    },
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe("harness.runtime.dispose.failed");
  expect(events[0]!.metadata?.error).toMatchObject({
    name: "Error",
    message: "workspace sync-back failed",
  });
  expect(validateTraceEvent({
    schemaVersion: "lh.trace.v2",
    eventId: "evt_1",
    sequence: 1,
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    ...events[0]!,
  }).type).toBe("harness.runtime.dispose.failed");
});

// --- Refocus decision 5: what the turn ran on, and what that cost ---
//
// Disposal is when a sandbox's usage is final (a remote one learns its awake time only once
// it sleeps), so the turn's one `harness.runtime.usage` event is emitted right after it, from
// `tiering()` and `usage()`, and it is a valid trace event.

it("emits harness.runtime.usage after dispose, from the sandbox's tiering and usage", async () => {
  const order: string[] = [];
  const events: { type: string; metadata?: Record<string, unknown> }[] = [];
  await disposeTurnRuntime(
    {
      dispose: async () => {
        order.push("dispose");
      },
      usage: () => {
        order.push("usage");
        return { provider: "cloudflare-sandbox", instanceType: "standard-1", vcpu: 0.5, memoryGiB: 4, activeMs: 300_000, awakeMs: 900_000, costUsd: 0.0125 };
      },
      tiering: () => ({ tier: "next-tier", commands: { tier0: 3, nextTier: 2, denied: 1 }, escalations: 1 }),
    } as unknown as HarnessSandbox,
    async (event) => {
      events.push(event as { type: string; metadata?: Record<string, unknown> });
    },
  );
  expect(order).toEqual(["dispose", "usage"]);
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    type: "harness.runtime.usage",
    metadata: {
      tier: "next-tier",
      commands: { tier0: 3, nextTier: 2, denied: 1 },
      escalations: 1,
      sandbox: { provider: "cloudflare-sandbox", instanceType: "standard-1", vcpu: 0.5, memoryGiB: 4, activeMs: 300_000, awakeMs: 900_000, costUsd: 0.0125 },
    },
  });
  expect(validateTraceEvent({
    schemaVersion: "lh.trace.v2",
    eventId: "evt_1",
    sequence: 1,
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    ...events[0]!,
  }).type).toBe("harness.runtime.usage");
});

it("still reports usage when dispose throws, after the dispose failure", async () => {
  const events: { type: string }[] = [];
  await disposeTurnRuntime(
    {
      dispose: async () => {
        throw new Error("sync-back failed");
      },
      usage: () => ({ provider: "just-bash", activeMs: 12 }),
      tiering: () => ({ tier: "tier-0", commands: { tier0: 1, nextTier: 0, denied: 0 }, escalations: 0 }),
    } as unknown as HarnessSandbox,
    async (event) => {
      events.push(event as { type: string });
    },
  );
  expect(events.map((event) => event.type)).toEqual(["harness.runtime.dispose.failed", "harness.runtime.usage"]);
});

it("accounts for a sandbox from what it reports, and not at all for one that reports nothing", () => {
  const sandbox = (parts: Partial<HarnessSandbox>) => parts as unknown as HarnessSandbox;
  expect(runtimeUsageOf(sandbox({}))).toBeUndefined();
  // A sandbox with usage but no tiering is a real execution environment, unless it is just-bash.
  expect(runtimeUsageOf(sandbox({ usage: () => ({ provider: "little-compute", activeMs: 5 }) }))).toEqual({
    tier: "next-tier",
    commands: { tier0: 0, nextTier: 0, denied: 0 },
    escalations: 0,
    sandbox: { provider: "little-compute", activeMs: 5 },
  });
  expect(runtimeUsageOf(sandbox({ usage: () => ({ provider: "just-bash", activeMs: 5 }) }))?.tier).toBe("tier-0");
  // Tiering without usage: an unknown provider, measured as nothing.
  expect(runtimeUsageOf(sandbox({ tiering: () => ({ tier: "tier-0", commands: { tier0: 2, nextTier: 0, denied: 0 }, escalations: 0 }) }))).toEqual({
    tier: "tier-0",
    commands: { tier0: 2, nextTier: 0, denied: 0 },
    escalations: 0,
    sandbox: { provider: "unknown", activeMs: 0 },
  });
  // A read that throws is a sandbox that cannot be asked, not a failed turn.
  expect(runtimeUsageOf(sandbox({
    usage: () => {
      throw new Error("gone");
    },
  }))).toBeUndefined();
});

it("stays silent when dispose succeeds and never throws when the emitter fails", async () => {
  const events: unknown[] = [];
  await disposeTurnRuntime(
    { dispose: async () => {} } as unknown as HarnessSandbox,
    async (event) => {
      events.push(event);
    },
  );
  expect(events).toEqual([]);

  await expect(disposeTurnRuntime(
    {
      dispose: async () => {
        throw new Error("boom");
      },
    } as unknown as HarnessSandbox,
    async () => {
      throw new Error("the trace sink is down too");
    },
  )).resolves.toBeUndefined();

  // No emitter at all is still legal: the failure is swallowed, not rethrown.
  await expect(disposeTurnRuntime({
    dispose: async () => {
      throw new Error("boom");
    },
  } as unknown as HarnessSandbox)).resolves.toBeUndefined();
});
