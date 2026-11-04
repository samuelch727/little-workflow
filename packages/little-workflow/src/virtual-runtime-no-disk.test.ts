import { InMemoryFs, type IFileSystem } from "just-bash";
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test";
import { jsonSchema, tool } from "ai";
import type { HarnessWorkflowRunContext } from "@little-stack/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DynamicWorkflowWorldContext } from "./dynamic-workflow.js";

vi.hoisted(() => vi.resetModules());

const disk = vi.hoisted(() => {
  const state = {
    armed: false,
    browser: false,
    calls: [] as string[],
    wrap(source: string, actual: Record<string, unknown>): Record<string, unknown> {
      const wrapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(actual)) {
        if (key === "default") continue;
        wrapped[key] = typeof value === "function"
          ? function (this: unknown, ...args: unknown[]) {
              if (state.armed) {
                state.calls.push(`${source}.${key}`);
                throw new Error(`Disk access forbidden: ${source}.${key}`);
              }
              return new.target === undefined
                ? Reflect.apply(value, actual, args)
                : Reflect.construct(value, args);
            }
          : key === "promises" && value !== null && typeof value === "object"
            ? state.wrap(`${source}.promises`, value as Record<string, unknown>)
            : value;
      }
      wrapped.default = wrapped;
      return wrapped;
    },
  };
  return state;
});

vi.mock("node:fs", async () => disk.wrap("node:fs", await vi.importActual("node:fs")));
vi.mock("node:fs/promises", async () => disk.wrap("node:fs/promises", await vi.importActual("node:fs/promises")));
vi.mock("better-sqlite3", () => ({
  default: class ForbiddenDatabase {
    constructor() {
      disk.calls.push("better-sqlite3");
      throw new Error("A virtual World must not construct better-sqlite3.");
    }
  },
}));
vi.mock("@little-stack/harness/internals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@little-stack/harness/internals")>();
  return {
    ...actual,
    justBashNodeExport: (...args: Parameters<typeof actual.justBashNodeExport>) =>
      disk.browser ? undefined : actual.justBashNodeExport(...args),
  };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function promptText(prompt: unknown): string {
  return (prompt as ReadonlyArray<{ content: unknown }>).map(({ content }) =>
    typeof content === "string" ? content : (content as Array<{ text?: string }>).map(part => part.text ?? "").join(""),
  ).join("\n");
}

function textStream(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "0" });
        controller.enqueue({ type: "text-delta", id: "0", delta: text });
        controller.enqueue({ type: "text-end", id: "0" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
        controller.close();
      },
    }),
  } as never;
}

function context(dataDir: string, runId: string, capabilities: unknown, fs: IFileSystem): HarnessWorkflowRunContext {
  return {
    protocolVersion: 1, workflowId: "virtual.acceptance", workflowHandle: "virtual_acceptance",
    definitionIdentity: "sha256:acceptance", toolCallId: "call_1", disposition: "await",
    parentSessionId: "session", parentTurnId: "turn", originTurnId: "turn",
    reservedRunId: runId, persistence: { dataDir, fs }, inheritance: {},
    capabilities: capabilities as never,
    observation: { recordProgress: async () => undefined },
  };
}

afterEach(() => {
  disk.armed = false;
  disk.browser = false;
  disk.calls.length = 0;
  vi.restoreAllMocks();
});

describe.each([false, true].flatMap(browser =>
  (["provided", "default", "callback"] as const).map(selection => ({ browser, selection })),
))("virtual runtime without disk (browser build=$browser, World=$selection)", ({ browser, selection }) => {
  it("runs a real one-shot plan and a planned workflow, then reopens and keeps that plan", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const workingDir = await actualFs.mkdtemp("/tmp/virtual-workflow-no-disk-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workingDir);
    disk.calls.length = 0;
    disk.browser = browser;
    disk.armed = true;
    let resetValidator: (() => void) | undefined;
    try {
      const { virtualWorld } = await import("./world.js");
      const { littleWorkflowDynamicWorkflowFactory } = await import("./dynamic-workflow-factory.js");
      const { setSchemaCodeGenerationForTest } = await import("./schema-validator.js");
      setSchemaCodeGenerationForTest(browser ? false : undefined);
      resetValidator = () => setSchemaCodeGenerationForTest(undefined);
      const fs = new InMemoryFs();
      const world = virtualWorld({ fs, dataDir: "/runs" });
      let plannerCalls = 0;
      const model = new MockLanguageModelV4({
        provider: "test", modelId: "diskless-planner",
        doStream: async options => {
          if ((options.tools ?? []).some(entry => entry.name === "bash")) {
            plannerCalls += 1;
            const text = promptText(options.prompt);
            const marker = "no prose or markdown fences:\n";
            const start = text.indexOf("{", text.indexOf(marker));
            return textStream(text.slice(start, text.indexOf("\n}", start) + 2));
          }
          return textStream("Approved.");
        },
      });
      const echo = tool({
        description: "Echo input.",
        inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
        execute: async (input: unknown) => input,
      });
      const capabilities = {
        tools: { echo }, models: { default: model }, mcpTools: {}, bash: {}, code: {},
        workflows: {}, skills: {}, mounts: [], permissions: { approvalPolicy: "reject_ask" },
      };
      const selectedContexts: DynamicWorkflowWorldContext[] = [];
      const factoryFor = (target: ReturnType<typeof virtualWorld>) =>
        littleWorkflowDynamicWorkflowFactory(selection === "provided" ? { world: target }
          : selection === "default" ? {} : {
            world: selected => {
              selectedContexts.push(selected);
              expect(selected.fs).toBe(fs);
              return virtualWorld({ fs: selected.fs!, dataDir: selected.dataDir });
            },
          });
      const factory = factoryFor(world);
      const compiled = factory.compile({
        purpose: "Echo then answer", input: { name: "Ada" }, outputSchema: { type: "string" },
        plan: {
          steps: [
            { id: "echo", uses: "tool.call", tool: "echo", with: { name: "{{ input.name }}" }, output: { mode: "json", schema: true } },
            { id: "reply", uses: "ai.generate", model: "default", prompt: "Answer {{ steps.echo.output.name }}", output: { mode: "text" } },
          ],
          output: { from: "reply" },
        },
        allowed: { tools: ["echo"], models: ["default"], bash: false },
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      });
      if (!compiled.ok) throw new Error(compiled.message);
      expect(await compiled.workflow.runForHarness({ name: "Ada" }, context(world.dataDir, "run_no_disk_plan", capabilities, fs)))
        .toMatchObject({ status: "completed", output: "Approved." });

      const definition = {
        id: "virtual.acceptance", description: "Reply to one applicant.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        outputSchema: { type: "string" }, tools: ["echo"], policy: "Keep the reply brief.",
      };
      const build = (target: ReturnType<typeof virtualWorld>) =>
        factoryFor(target).define!(definition, {
          tools: { echo }, models: { default: model }, planner: model,
        });
      const first = build(world);
      if (!first.ok) throw new Error(first.message);
      expect(await first.workflow.runForHarness({ name: "Ada" }, context(world.dataDir, "run_no_disk_defined", capabilities, fs)))
        .toMatchObject({ status: "completed", output: "Approved." });
      expect(plannerCalls).toBe(1);

      // Reopen the same backing object; this proves visibility, not process-crash durability.
      const reopened = virtualWorld({ fs, dataDir: "/runs/./" });
      expect(await reopened.listEvents("run_no_disk_defined")).toEqual(await world.listEvents("run_no_disk_defined"));
      const second = build(reopened);
      if (!second.ok) throw new Error(second.message);
      expect(await second.workflow.runForHarness({ name: "Bo" }, context(reopened.dataDir, "run_no_disk_kept", capabilities, fs)))
        .toMatchObject({ status: "completed", output: "Approved." });
      expect(plannerCalls).toBe(1);

      for (const runId of ["run_no_disk_plan", "run_no_disk_defined", "run_no_disk_kept"]) {
        const events = await reopened.listEvents(runId);
        expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["RunStarted", "RunCompleted", "ArtifactCreated"]));
        const artifacts = events.filter(event => event.type === "ArtifactCreated");
        for (const artifact of artifacts) {
          const ref = String(artifact.payload.artifactRef);
          expect((await reopened.readArtifact(ref)).manifest.artifactRef).toBe(ref);
        }
      }
      const originalVersion = (await reopened.listEvents("run_no_disk_defined"))
        .find(event => event.type === "RunStarted")?.payload.workflowVersionId;
      const reusedVersion = (await reopened.listEvents("run_no_disk_kept"))
        .find(event => event.type === "RunStarted")?.payload.workflowVersionId;
      expect(originalVersion).toEqual(expect.any(String));
      expect(reusedVersion).toBe(originalVersion);
      if (selection === "callback") {
        expect(selectedContexts.map(selected => selected.kind)).toEqual(["ad_hoc", "defined", "defined"]);
        expect(selectedContexts.map(selected => selected.runId)).toEqual(["run_no_disk_plan", "run_no_disk_defined", "run_no_disk_kept"]);
        expect(selectedContexts.every(selected => selected.fs === fs)).toBe(true);
      }
      expect(disk.calls).toEqual([]);
      expect(await actualFs.readdir(workingDir)).toEqual([]);
    } finally {
      resetValidator?.();
      disk.armed = false;
      cwd.mockRestore();
      await actualFs.rm(workingDir, { recursive: true, force: true });
    }
  });
});

describe.each(["app", "once"] as const)("virtualHost workflow integration: %s", kind => {
  it("keeps the run and once records in the session data filesystem without native filesystem calls", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const workingDir = await actualFs.mkdtemp("/tmp/virtual-harness-workflow-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workingDir);
    disk.calls.length = 0;
    disk.armed = true;
    try {
      const { createHarness, generateHarness, virtualHost, once } = await import("@little-stack/harness");
      const { defineWorkflow } = await import("./authoring.js");
      const { asHarnessWorkflow } = await import("./harness-workflow.js");
      const { dynamicWorkflows } = await import("./dynamic-workflow.js");
      const { virtualWorld } = await import("./world.js");
      const dataFs = new InMemoryFs();
      const workspace = new InMemoryFs();
      const host = virtualHost({ fs: workspace, dataFs });
      const sessionId = "../an unsafe session";
      const session = await host.sessions.getOrCreate({ id: sessionId });
      const pathKey = (await session.status()).pathKey;
      const dataDir = `/.little-harness/data/sessions/${pathKey}`;
      expect(session.dataDir).toBe(dataDir);
      let executions = 0;
      const echo = tool({
        description: "Echo a value.",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
        }),
        execute: async ({ value }) => ({ value, execution: ++executions }),
      });
      const workflow = defineWorkflow({
        id: "app.echo", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        tools: { echo },
        plan: { steps: [{
          id: "echo", uses: "tool.call", with: { tool: "echo", args: { value: "{{ input.value }}" } },
          output: { mode: "json", schema: true },
        }] },
      });
      const call = kind === "app"
        ? { name: "app_echo", input: { value: "hello" } }
        : { name: "run_ad_hoc_plan", input: {
            purpose: "Record the same value twice", input: { value: "hello" }, outputSchema: true,
            plan: {
              steps: [
                { id: "first", uses: "tool.call", tool: "echo", with: { value: "{{ input.value }}" } },
                { id: "second", uses: "tool.call", tool: "echo", with: { value: "{{ input.value }}" }, needs: ["first"] },
              ],
              output: { from: "second" },
            },
          } };
      let modelCalls = 0;
      let outcome: { status: string; runId: string } | undefined;
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          if (modelCalls++ === 0) return {
            content: [{ type: "tool-call", toolCallId: "workflow_1", toolName: call.name, input: JSON.stringify(call.input) }],
            finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [],
          };
          const result = prompt.flatMap(message => message.role === "tool" && Array.isArray(message.content)
            ? message.content.filter(part => part.type === "tool-result" && part.toolName === call.name)
            : []).at(-1);
          outcome = (result as { output: { value: typeof outcome } } | undefined)?.output.value;
          return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
        },
      });
      const harness = createHarness({
        host, model,
        ...(kind === "app" ? {
          workflows: [asHarnessWorkflow(workflow, { definitionIdentity: "sha256:virtual-app-echo" })],
        } : {
          tools: { echo: once(echo) },
          dynamicWorkflows: dynamicWorkflows({ define: false }),
        }),
      });
      expect((await generateHarness({ harness, session: sessionId, prompt: "run" })).status).toBe("completed");
      expect(outcome?.status).toBe("completed");
      expect(outcome?.runId).toEqual(expect.any(String));
      expect(executions).toBe(1);
      const runDir = kind === "app" ? `${dataDir}/workflows` : `${dataDir}/dynamic-workflows/${outcome!.runId}`;
      const world = virtualWorld({ fs: dataFs, dataDir: runDir });
      const events = await world.listEvents(outcome!.runId);
      expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["RunStarted", "StepCompleted", "RunCompleted", "ArtifactCreated"]));
      if (kind === "once") {
        const names = await dataFs.readdir(`${dataDir}/once`);
        expect(names).toHaveLength(1);
        expect(JSON.parse(await dataFs.readFile(`${dataDir}/once/${names[0]}`)))
          .toMatchObject({ toolName: "echo", result: { value: "hello", execution: 1 } });
        expect(events.filter(event => event.type === "StepCompleted")).toHaveLength(2);
      }
      expect(await workspace.exists(runDir)).toBe(false);
      expect(disk.calls).toEqual([]);
      expect(await actualFs.readdir(workingDir)).toEqual([]);
    } finally {
      disk.armed = false;
      cwd.mockRestore();
      await actualFs.rm(workingDir, { recursive: true, force: true });
    }
  });
});
