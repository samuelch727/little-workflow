import type { HarnessWorkflowExecution, HarnessWorkflowRunContext } from "@little-stack/harness";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs, type IFileSystem } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { World } from "./world-port.js";
import type { WorkflowVersionSource } from "./versioned-harness-workflow.js";

vi.hoisted(() => vi.resetModules());

const disk = vi.hoisted(() => {
  const state = {
    armed: false,
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
      throw new Error("A virtual versioned workflow must not construct better-sqlite3.");
    }
  },
}));

afterEach(() => {
  disk.armed = false;
  disk.calls.length = 0;
  vi.restoreAllMocks();
});

type Content = { readonly greeting: string };
const original = { content: { greeting: "Hello" }, version: { versionId: "version_1" } };
const changed = { content: { greeting: "Good news," }, version: { versionId: "version_2" } };

async function builder(calls: string[]) {
  const { defineWorkflow } = await import("./authoring.js");
  return (content: Content) => defineWorkflow({
    id: "versioned.note",
    description: "Write a versioned note.",
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    tools: {
      note: tool({
        description: "Write a note.",
        inputSchema: jsonSchema<{ text: string }>({
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        }),
        execute: async ({ text }) => {
          calls.push(text);
          return { text };
        },
      }),
    },
    plan: { steps: [{
      id: "note", uses: "tool.call",
      with: { tool: "note", args: { text: `${content.greeting} {{ input.name }}` } },
      output: { mode: "json", schema: true },
    }] },
  });
}

function context(fs: IFileSystem): HarnessWorkflowRunContext {
  return {
    protocolVersion: 1, workflowId: "versioned.note", workflowHandle: "versioned_note",
    definitionIdentity: "sha256:versioned-test", toolCallId: "pin", disposition: "await",
    parentSessionId: "versioned-session", parentTurnId: "turn", originTurnId: "turn",
    reservedRunId: "run_versioned_pin", persistence: { dataDir: "/context", fs },
    inheritance: {}, observation: { recordProgress: async () => undefined },
  };
}

describe("versionedHarnessWorkflow on a virtual host", () => {
  it("reopens the stored version pin and events even when prepare returns changed content", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const workingDir = await actualFs.mkdtemp("/tmp/versioned-virtual-workflow-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workingDir);
    disk.armed = true;
    try {
      const { createHarness, generateHarness, virtualHost } = await import("@little-stack/harness");
      const { versionedHarnessWorkflow } = await import("./versioned-harness-workflow.js");
      const { virtualWorld, readRunPin } = await import("./world.js");
      const dataFs = new InMemoryFs();
      const workspace = new InMemoryFs();
      const sessionId = "versioned/session";
      const toolCalls: string[] = [];
      const build = await builder(toolCalls);
      const asked: Parameters<WorkflowVersionSource<Content>["prepare"]>[0][] = [];
      const worlds: World[] = [];
      const contexts: HarnessWorkflowRunContext[] = [];
      let live = original;
      const source: WorkflowVersionSource<Content> = {
        bootstrap: original.content,
        async prepare(options) {
          asked.push(options);
          return {
            ...live,
            world(inner) {
              worlds.push(inner);
              return inner;
            },
          };
        },
      };
      const invoke = async (toolCallId: string) => {
        // New hosts and adapters share only their backing filesystems, not a built-version cache.
        const host = virtualHost({ fs: workspace, dataFs });
        const session = await host.sessions.getOrCreate({ id: sessionId });
        const pathKey = (await session.status()).pathKey;
        const adapter = versionedHarnessWorkflow(source, build);
        let execution: HarnessWorkflowExecution | undefined;
        let modelCalls = 0;
        const model = new MockLanguageModelV3({
          doGenerate: async () => ({
            content: modelCalls++ === 0
              ? [{ type: "tool-call", toolCallId, toolName: "versioned_note", input: '{"name":"Ada"}' }]
              : [{ type: "text", text: "done" }],
            finishReason: modelCalls === 1
              ? { unified: "tool-calls", raw: "tool-calls" }
              : { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }),
        });
        const harness = createHarness({
          host, model,
          workflows: [{
            ...adapter,
            async runForHarness(input, ctx) {
              contexts.push(ctx);
              execution = await adapter.runForHarness(input, ctx);
              return execution;
            },
          }],
        });
        expect((await generateHarness({ harness, session: sessionId, prompt: "Write the note." })).status).toBe("completed");
        expect(execution).toMatchObject({ status: "completed", output: { text: `${original.content.greeting} Ada` } });
        return { execution: execution!, dataDir: `/.little-harness/data/sessions/${pathKey}/workflows` };
      };

      const first = await invoke("pin");
      const runId = first.execution.runId;
      const pinPath = `${first.dataDir}/run-pins/${runId}.json`;
      const storedPin = await dataFs.readFile(pinPath);
      expect(JSON.parse(storedPin)).toMatchObject({ runId, ...original });
      const firstWorld = virtualWorld({ fs: dataFs, dataDir: first.dataDir });
      const firstEvents = await firstWorld.listEvents(runId);
      expect(firstEvents.map(event => event.type)).toEqual(expect.arrayContaining(["RunStarted", "RunCompleted", "ArtifactCreated"]));
      expect(toolCalls).toEqual(["Hello Ada"]);

      live = changed;
      const reopened = await invoke("pin");
      expect(reopened.execution.runId).toBe(runId);
      expect(reopened.dataDir).toBe(first.dataDir);
      expect(asked).toEqual([
        { stickyKey: sessionId },
        { stickyKey: sessionId, pinned: original },
      ]);
      expect(toolCalls).toEqual(["Hello Ada"]);
      expect(worlds).toHaveLength(2);
      expect(worlds[1]).not.toBe(worlds[0]);
      expect(worlds.every(world => world.kind === "virtual-world" && world.files === dataFs && world.dataDir === first.dataDir)).toBe(true);
      expect(contexts.every(ctx => ctx.persistence.fs === dataFs && ctx.persistence.dataDir === first.dataDir)).toBe(true);
      expect(await dataFs.readFile(pinPath)).toBe(storedPin);
      const reopenedWorld = virtualWorld({ fs: dataFs, dataDir: reopened.dataDir });
      expect(await readRunPin(reopenedWorld, runId)).toMatchObject(original);
      expect(await reopenedWorld.listEvents(runId)).toEqual(firstEvents);
      for (const event of firstEvents.filter(event => event.type === "ArtifactCreated")) {
        const ref = String(event.payload.artifactRef);
        expect((await reopenedWorld.readArtifact(ref)).manifest.artifactRef).toBe(ref);
      }
      expect(await workspace.exists(first.dataDir)).toBe(false);
      expect(disk.calls).toEqual([]);
      expect(await actualFs.readdir(workingDir)).toEqual([]);
    } finally {
      disk.armed = false;
      cwd.mockRestore();
      await actualFs.rm(workingDir, { recursive: true, force: true });
    }
  });

  it.each(["provided", "factory"] as const)("uses an explicit World %s as given", async selection => {
    disk.armed = true;
    const { versionedHarnessWorkflow } = await import("./versioned-harness-workflow.js");
    const { virtualWorld, readRunPin } = await import("./world.js");
    const dataFs = new InMemoryFs();
    const explicitFs = new InMemoryFs();
    const world = virtualWorld({ fs: explicitFs, dataDir: "/explicit" });
    const ctx = context(dataFs);
    const factory = vi.fn((actual: HarnessWorkflowRunContext) => {
      expect(actual).toBe(ctx);
      return world;
    });
    const wrapped: World[] = [];
    const source: WorkflowVersionSource<Content> = {
      bootstrap: original.content,
      async prepare() {
        return { ...original, world: inner => { wrapped.push(inner); return inner; } };
      },
    };
    const adapter = versionedHarnessWorkflow(source, await builder([]), {
      world: selection === "provided" ? world : factory,
    });
    expect(await adapter.runForHarness({ name: "Ada" }, ctx)).toMatchObject({ status: "completed", output: { text: "Hello Ada" } });
    expect(wrapped).toEqual([world]);
    expect(factory).toHaveBeenCalledTimes(selection === "factory" ? 1 : 0);
    expect(await readRunPin(world, ctx.reservedRunId)).toMatchObject(original);
    expect((await world.listEvents(ctx.reservedRunId)).map(event => event.type)).toContain("RunCompleted");
    expect(await dataFs.exists("/context")).toBe(false);
    expect(disk.calls).toEqual([]);
  });
});
