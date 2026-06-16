import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import type {
  DurableHarnessEventInput,
  HarnessPriorEventQuery,
  PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import { inputType } from "../input-types/input-type.js";
import { localHost } from "../local-host/index.js";
import { skill } from "../skills/skill.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textModel(text: string, warnings: Array<{ type: "other"; message: string }> = []) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings,
    },
  });
}

function replayDurability(seed: readonly PersistedDurableHarnessEvent[] = []) {
  const events = [...seed];
  return {
    events,
    sink: {
      append: async (event: DurableHarnessEventInput) => {
        const persisted: PersistedDurableHarnessEvent = {
          ...event,
          eventId: `evt_${events.length + 1}`,
          sequence: events.length + 1,
          recordedAt: "2026-06-07T00:00:00.000Z",
        };
        events.push(persisted);
        return persisted;
      },
      priorEvents: async (query: HarnessPriorEventQuery = {}) =>
        events.filter((event) =>
          (query.runId === undefined || event.runId === query.runId) &&
          (query.type === undefined || event.type === query.type) &&
          (query.occurrenceId === undefined || event.occurrenceId === query.occurrenceId)
        ),
    },
  };
}

function providerToolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools.flatMap((entry) =>
      entry && typeof entry === "object" && "name" in entry
        ? [String((entry as { name: unknown }).name)]
        : [],
    );
  }
  return Object.keys((tools ?? {}) as Record<string, unknown>);
}

describe("generateHarness", () => {
  it("rejects with HarnessInputError when no harness or call model is configured", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        system: "Missing model.",
      } as any);

      const run = generateHarness({ harness, type: "job", input: {} });

      await expect(run).rejects.toThrow(HarnessInputError);
      await expect(run).rejects.toThrow(/model/i);
    });
  });

  it("supports per-call model, system, and temperature overrides", async () => {
    await withTempDir(async (dir) => {
      const defaultModel = textModel("default response");
      let seenPrompt = "";
      let seenTemperature: number | undefined;
      const requestModel = new MockLanguageModelV3({
        provider: "test",
        modelId: "request-model",
        doGenerate: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenTemperature = options.temperature;
          return {
            content: [{ type: "text", text: "request response" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: defaultModel,
        system: "Default system.",
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as any,
        model: requestModel,
        system: "Request system.",
        temperature: 0.2,
      });

      expect(result.text).toBe("request response");
      expect(defaultModel.doGenerateCalls).toHaveLength(0);
      expect(requestModel.doGenerateCalls).toHaveLength(1);
      expect(seenPrompt).toContain("Request system.");
      expect(seenPrompt).not.toContain("Default system.");
      expect(seenTemperature).toBe(0.2);
    });
  });

  it("continues and warns when a remote skill source is unavailable", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "remote-skill-soft-fail",
        doGenerate: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const remote = `${pathToFileURL(path.join(dir, "missing-repo")).href}#${"a".repeat(40)}`;
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        skills: [skill(remote, { skills: ["missing"] })],
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as any,
      });

      expect(result.text).toBe("done");
      expect(seenPrompt).not.toContain("missing");
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "policy_warning",
          metadata: expect.objectContaining({
            reason: "remote_skill_unavailable",
            source: remote,
          }),
        }),
      ]);
    });
  });

  it("can disable the built-in bash tool through runtime options", async () => {
    await withTempDir(async (dir) => {
      let seenToolNames: string[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bash-disabled",
        doGenerate: async (options) => {
          seenToolNames = providerToolNames(options.tools);
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        runtime: { bash: false },
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as any,
      });

      expect(seenToolNames).toContain("lookup");
      expect(seenToolNames).not.toContain("bash");
    });
  });

  it("can disable the built-in bash tool for one call", async () => {
    await withTempDir(async (dir) => {
      const seenToolNames: string[][] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bash-call-override",
        doGenerate: async (options) => {
          seenToolNames.push(providerToolNames(options.tools));
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({ host: localHost({ dataDir: dir }), model });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as any;

      await generateHarness({ harness, messages, session: "with-bash" });
      await generateHarness({
        harness,
        messages,
        session: "without-bash",
        runtime: { bash: false },
      });

      expect(seenToolNames[0]).toContain("bash");
      expect(seenToolNames[1]).not.toContain("bash");
    });
  });

  it("runs a custom input type to completion", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        inputTypes: {
          "support.ticket_triage": inputType({
            description: "Triage one support ticket.",
            inputSchema: z.object({ id: z.string() }),
            toMessages: ({ input }) => [{ role: "user", content: `Ticket ${input.id}` }],
          }),
        },
      });

      const result = await generateHarness({
        harness,
        type: "support.ticket_triage",
        input: { id: "t1" },
        session: "ticket:t1",
      });

      expect(result.text).toBe("done");
      expect(result.output).toBe("done");
      expect(result.session.id).toBe("ticket:t1");
      expect(result.persistence.status).toBe("not-configured");
      expect(await result.session.status()).toMatchObject({ state: "idle" });
    });
  });

  it("returns undefined input type warnings", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: textModel("done") });

      const result = await generateHarness({
        harness,
        type: "unknown.kind",
        input: { ok: true },
      });

      expect(result.warnings[0]?.code).toBe("undefined_input_type");
      expect(result.text).toBe("done");
    });
  });

  it("commits after-turn Persistent Dir changes after the model call", async () => {
    await withTempDir(async (dir) => {
      const stored: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        persistentDirs: [
          {
            harnessDir: "/persistent/memory",
            load: () => ({ "before.txt": "before" }),
            store: ({ changes, snapshot }) => {
              stored.push({ changes, snapshot });
            },
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Write memory.",
            toMessages: async ({ files }) => {
              await files.writeText("/persistent/memory/after.txt", "after");
              return [{ role: "user", content: "Write memory" }];
            },
          }),
        },
      });

      const result = await generateHarness({ harness, type: "job", input: {}, session: "job" });

      expect(result.persistence.status).toBe("succeeded");
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        changes: { created: { "after.txt": expect.any(Uint8Array) }, updated: {}, deleted: [] },
        snapshot: {
          "before.txt": expect.any(Uint8Array),
          "after.txt": expect.any(Uint8Array),
        },
      });
    });
  });

  it("maps provider warnings into harness warnings", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done", [{ type: "other", message: "provider warning" }]),
      });

      const result = await generateHarness({ harness, type: "job", input: {} });

      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "undefined_input_type" }),
        expect.objectContaining({
          code: "provider_warning",
          message: "provider warning",
        }),
      ]);
    });
  });

  it("mounts configured skills under /.agents before Input Types run", async () => {
    await withTempDir(async (dir) => {
      const skillRoot = path.join(dir, "skills", "renewal");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: renewal\ndescription: Renewal analysis.\n---\n\nUse account evidence.",
        "utf8",
      );

      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "harness") }),
        model: textModel("done"),
        skills: [skillRoot],
        inputTypes: {
          job: inputType({
            description: "Read mounted skill.",
            toMessages: async ({ files }) => {
              const mounted = await files.read("/.agents/skills/renewal/SKILL.md");
              return [{ role: "user", content: mounted.text() }];
            },
          }),
        },
      });

      await expect(
        generateHarness({ harness, type: "job", input: {}, session: "skill" }),
      ).resolves.toMatchObject({
        text: "done",
      });
    });
  });

  it("stages remote-style .agents skills where advertised paths are readable", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "harness") }),
        model: textModel("done"),
        skills: [
          skill({
            name: "remote-review",
            description: "Remote review.",
            harnessDir: ".agents/skills/remote-review",
            files: { "SKILL.md": "Remote review body." },
          }),
        ],
        inputTypes: {
          job: inputType({
            description: "Read remote-style skill.",
            toMessages: async ({ files }) => {
              const mounted = await files.read("/.agents/skills/remote-review/SKILL.md");
              return [{ role: "user", content: mounted.text() }];
            },
          }),
        },
      });

      await expect(
        generateHarness({ harness, type: "job", input: {}, session: "agent-skill" }),
      ).resolves.toMatchObject({
        text: "done",
      });
    });
  });

  it("continues the default agent loop after tool calls and passes artifact helpers to tools", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "tool-loop",
        doGenerate: async () => {
          call += 1;
          if (call === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "writeArtifact",
                  input: JSON.stringify({ text: "hello" }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }

          return {
            content: [{ type: "text", text: "final after tool" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          writeArtifact: tool({
            description: "Write an artifact and read it back.",
            inputSchema: z.object({ text: z.string() }),
            execute: async ({ text }, ctx: any) => {
              const ref = await ctx.files.writeText("/artifacts/tool/out.txt", text);
              const readBack = await ctx.artifacts.read(ref.path);
              return { path: ref.path, text: readBack.text() };
            },
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Run tool." }] }] as any,
        session: "tool-loop",
      });

      expect(result.text).toBe("final after tool");
      expect(model.doGenerateCalls).toHaveLength(2);
      expect((await result.session.files.read("/artifacts/tool/out.txt")).text()).toBe("hello");
    });
  });

  it("exposes configured tools to the runtime bridge when only bash is active for the provider", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-active-bash",
        doGenerate: async () => {
          call += 1;
          return call === 1
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_bash",
                    toolName: "bash",
                    input: JSON.stringify({
                      command: "js-exec -c 'console.log((await tools.add({a:19,b:23})).sum)'",
                    }),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: "final after runtime bridge" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as any,
        session: "runtime-bridge-active-bash",
        activeTools: ["bash"],
      });

      expect(result.text).toBe("final after runtime bridge");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "harness.tool_call.started",
            metadata: expect.objectContaining({ caller: "runtime", toolName: "add" }),
          }),
          expect.objectContaining({
            type: "harness.tool_call.succeeded",
            metadata: expect.objectContaining({
              caller: "runtime",
              toolName: "add",
              output: expect.objectContaining({ preview: expect.stringContaining("\"sum\": 42") }),
            }),
          }),
        ]),
      );
    });
  });

  it("does not advertise runtime bridge calls when activeTools excludes bash", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-inactive-bash-hints",
        doGenerate: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          return {
            content: [{ type: "text", text: "no bridge hint" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as any,
        session: "runtime-bridge-inactive-bash-hints",
        activeTools: ["add"],
      });

      expect(result.text).toBe("no bridge hint");
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("does not advertise runtime bridge calls when prepareStep activeTools excludes bash", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      let seenToolNames: string[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-prepare-step-inactive-bash-hints",
        doGenerate: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenToolNames = providerToolNames(options.tools);
          return {
            content: [{ type: "text", text: "prepare step no bridge hint" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as any,
        session: "runtime-bridge-prepare-step-inactive-bash-hints",
        prepareStep: () => ({ activeTools: ["add"] }) as any,
      });

      expect(result.text).toBe("prepare step no bridge hint");
      expect(seenToolNames).toEqual(["add"]);
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("keeps activeTools hint gating when prepareStep returns undefined overrides", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      let seenToolNames: string[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-prepare-step-undefined-hints",
        doGenerate: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenToolNames = providerToolNames(options.tools);
          return {
            content: [{ type: "text", text: "undefined prepare step no bridge hint" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        system: "Keep this base system.",
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as any,
        session: "runtime-bridge-prepare-step-undefined-hints",
        activeTools: ["add"],
        prepareStep: () => ({ activeTools: undefined, system: undefined }) as any,
      });

      expect(result.text).toBe("undefined prepare step no bridge hint");
      expect(seenToolNames).toEqual(["add"]);
      expect(seenPrompt).toContain("Keep this base system.");
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("shares tool result spooling with runtime bridge tool calls", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const longResult = `LONG_RUNTIME_SENTINEL_1937\n${"x".repeat(256)}`;
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-spooling",
        doGenerate: async () => {
          call += 1;
          return call === 1
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_bash",
                    toolName: "bash",
                    input: JSON.stringify({
                      command:
                        "js-exec -c 'const result = await tools.longLookup({query:\"alpha\"}); console.log(result.path); if (!result.path) throw new Error(\"missing spooled path\")' > /artifacts/runtime-bridge-path.txt",
                    }),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: "final after runtime spooling" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        toolResultSpooling: { maxInlineBytes: 64, previewBytes: 24 },
        onEvent: (event) => {
          events.push(event);
        },
        tools: {
          longLookup: tool({
            description: "Return a large lookup result.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => longResult,
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as any,
        session: "runtime-bridge-spooling",
        activeTools: ["bash"],
      });

      const spooledPath = (await result.session.files.read("/artifacts/runtime-bridge-path.txt")).text().trim();
      expect(result.text).toBe("final after runtime spooling");
      expect(spooledPath).toMatch(/^\/artifacts\/tool-results\/longLookup\/.+\.txt$/u);
      expect((await result.session.files.read(spooledPath)).text()).toBe(longResult);
      expect(
        events.filter((event) =>
          event.type === "harness.file.created" &&
          event.metadata?.path === spooledPath
        ),
      ).toHaveLength(1);
      expect(
        events.filter((event) =>
          event.type === "harness.artifact.created" &&
          event.metadata?.artifact?.path === spooledPath
        ),
      ).toHaveLength(1);
    });
  });

  it("lets the model remember durable lessons", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      let secondTurnPrompt = "";
      const tailSentinel = "TAIL_SENTINEL_SHOULD_NOT_APPEAR";
      const lesson = [
        "For natural-language questions about paid invoices, query billing_invoices before invoice_events.",
        "This bounded-context check adds filler before the late sentinel.",
        tailSentinel,
      ].join(" ");
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "remember-durable-lessons",
        doGenerate: async (options) => {
          call += 1;
          if (call === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_remember",
                  toolName: "remember",
                  input: JSON.stringify({ memory: lesson, topic: "db-query-agent" }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }

          if (call === 2) {
            return {
              content: [{ type: "text", text: "stored memory" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            };
          }

          secondTurnPrompt = JSON.stringify(options.prompt);
          return {
            content: [{ type: "text", text: "used stored memory" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: {
          sourceDir: "memory/db-query-agent",
          maxIndexBytes: 220,
          now: () => new Date("2026-06-09T00:00:00.000Z"),
        },
      });

      const first = await generateHarness({
        harness,
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "Remember this database query rule." }],
          },
        ] as any,
        session: "db-query-agent",
      });

      expect(first.text).toBe("stored memory");
      expect(first.persistence.status).toBe("succeeded");
      const memoryIndex = await readFile(
        path.join(dir, "memory/db-query-agent/MEMORY.md"),
        "utf8",
      );
      expect(memoryIndex).toContain("billing_invoices");
      expect(memoryIndex).toContain("entries/2026-06-09/");

      await generateHarness({
        harness,
        messages: [
          {
            id: "m2",
            role: "user",
            parts: [{ type: "text", text: "How should I answer paid invoice questions?" }],
          },
        ] as any,
        session: "db-query-agent",
      });

      expect(secondTurnPrompt).toContain("billing_invoices");
      expect(secondTurnPrompt).toContain("Long-term memory is mounted at /persistent/memory.");
      expect(secondTurnPrompt).not.toContain(tailSentinel);
    });
  });

  it("preserves memory index bullets from concurrent sessions sharing one sourceDir", async () => {
    await withTempDir(async (dir) => {
      let firstTurnCount = 0;
      let releaseFirstTurns!: () => void;
      const bothFirstTurnsLoaded = new Promise<void>((resolve) => {
        releaseFirstTurns = resolve;
      });
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "concurrent-shared-memory",
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          if (prompt.includes("tool-result")) {
            return {
              content: [{ type: "text", text: "stored memory" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            };
          }

          firstTurnCount += 1;
          if (firstTurnCount >= 2) {
            releaseFirstTurns();
          }
          await bothFirstTurnsLoaded;

          const memory = prompt.includes("FIRST_SHARED_MEMORY")
            ? "FIRST_SHARED_MEMORY survives a concurrent shared source commit."
            : "SECOND_SHARED_MEMORY survives a concurrent shared source commit.";
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call_${memory.slice(0, 6).toLowerCase()}`,
                toolName: "remember",
                input: JSON.stringify({ memory }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: {
          sourceDir: "memory/shared",
          now: () => new Date("2026-06-09T00:00:00.000Z"),
        },
      });

      const [first, second] = await Promise.all([
        generateHarness({
          harness,
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "Remember FIRST_SHARED_MEMORY." }],
            },
          ] as any,
          session: "shared-memory-first",
        }),
        generateHarness({
          harness,
          messages: [
            {
              id: "m2",
              role: "user",
              parts: [{ type: "text", text: "Remember SECOND_SHARED_MEMORY." }],
            },
          ] as any,
          session: "shared-memory-second",
        }),
      ]);

      expect(first.persistence.status).toBe("succeeded");
      expect(second.persistence.status).toBe("succeeded");
      const memoryIndex = await readFile(path.join(dir, "memory/shared/MEMORY.md"), "utf8");
      expect(memoryIndex).toContain("FIRST_SHARED_MEMORY");
      expect(memoryIndex).toContain("SECOND_SHARED_MEMORY");
    });
  });

  it("prioritizes concurrent source memory over stale loaded index bullets when bounded", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, "memory/shared"), { recursive: true });
      await writeFile(
        path.join(dir, "memory/shared/MEMORY.md"),
        [
          "# Memory Index",
          "- 2026-06-08: [old](entries/2026-06-08/old.md) - OLD_ORDERING_SENTINEL",
          "",
        ].join("\n"),
      );

      let firstTurnCount = 0;
      let releaseFirstTurns!: () => void;
      const bothFirstTurnsLoaded = new Promise<void>((resolve) => {
        releaseFirstTurns = resolve;
      });
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "bounded-concurrent-shared-memory",
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          if (prompt.includes("tool-result")) {
            return {
              content: [{ type: "text", text: "stored memory" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            };
          }

          firstTurnCount += 1;
          if (firstTurnCount >= 2) {
            releaseFirstTurns();
          }
          await bothFirstTurnsLoaded;

          const memory = prompt.includes("FIRST_ORDERING_SENTINEL")
            ? "FIRST_ORDERING_SENTINEL"
            : "SECOND_ORDERING_SENTINEL";
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call_${memory.slice(0, 6).toLowerCase()}`,
                toolName: "remember",
                input: JSON.stringify({ memory }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: {
          sourceDir: "memory/shared",
          maxIndexBytes: 300,
          now: () => new Date("2026-06-09T00:00:00.000Z"),
        },
      });

      const [first, second] = await Promise.all([
        generateHarness({
          harness,
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "Remember FIRST_ORDERING_SENTINEL." }],
            },
          ] as any,
          session: "bounded-shared-memory-first",
        }),
        generateHarness({
          harness,
          messages: [
            {
              id: "m2",
              role: "user",
              parts: [{ type: "text", text: "Remember SECOND_ORDERING_SENTINEL." }],
            },
          ] as any,
          session: "bounded-shared-memory-second",
        }),
      ]);

      expect(first.persistence.status).toBe("succeeded");
      expect(second.persistence.status).toBe("succeeded");
      const memoryIndex = await readFile(path.join(dir, "memory/shared/MEMORY.md"), "utf8");
      expect(new TextEncoder().encode(memoryIndex).byteLength).toBeLessThanOrEqual(300);
      expect(memoryIndex).toContain("FIRST_ORDERING_SENTINEL");
      expect(memoryIndex).toContain("SECOND_ORDERING_SENTINEL");
      expect(memoryIndex).not.toContain("OLD_ORDERING_SENTINEL");
    });
  });

  it("spools oversized tool results into files that later model steps can read", async () => {
    await withTempDir(async (dir) => {
      const longResult = `header\n${"alpha\n".repeat(40)}LONG_TOOL_SENTINEL_8472\n`;
      let call = 0;
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "spooled-tool-result",
        doGenerate: async (options) => {
          call += 1;
          if (call === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "longLookup",
                  input: JSON.stringify({ query: "alpha" }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }

          if (call === 2) {
            expect(JSON.stringify(options.prompt)).toContain(
              "/artifacts/tool-results/longLookup/call_1.txt",
            );
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_2",
                  toolName: "bash",
                  input: JSON.stringify({
                    command:
                      "grep -o LONG_TOOL_SENTINEL_8472 /artifacts/tool-results/longLookup/call_1.txt > /artifacts/readback.txt",
                  }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }

          return {
            content: [{ type: "text", text: "final after readback" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        toolResultSpooling: { maxInlineBytes: 64, previewBytes: 24 },
        tools: {
          longLookup: tool({
            description: "Return a large lookup result.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => longResult,
          }),
        },
      });

      const result = await generateHarness({
        harness,
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "Lookup alpha, then read the result file." }],
          },
        ] as any,
        session: "spooled-tool-result",
      });

      expect(result.text).toBe("final after readback");
      expect((await result.session.files.read("/artifacts/tool-results/longLookup/call_1.txt")).text()).toBe(
        longResult,
      );
      expect((await result.session.files.read("/artifacts/readback.txt")).text()).toBe(
        "LONG_TOOL_SENTINEL_8472\n",
      );
    });
  });

  it("emits host-facing trace events for tools, files, artifacts, and Persistent Dir commits", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: string[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "events",
          doGenerate: async () => {
            call += 1;
            return call === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "save",
                      input: JSON.stringify({ text: "artifact" }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "done" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        tools: {
          save: tool({
            description: "Save artifact.",
            inputSchema: z.object({ text: z.string() }),
            execute: async ({ text }, ctx: any) => {
              await ctx.files.writeText("/artifacts/events/out.txt", text);
              return { ok: true };
            },
          }),
        },
        persistentDirs: [
          {
            harnessDir: "/persistent/memory",
            load: () => ({}),
            store: () => {},
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Write memory.",
            toMessages: async ({ files }) => {
              await files.writeText("/persistent/memory/note.md", "remember");
              return [{ role: "user", content: "Run event task." }];
            },
          }),
        },
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      await generateHarness({ harness, type: "job", input: {}, session: "events" });

      expect(events).toEqual(
        expect.arrayContaining([
          "harness.persistent_dir.loaded",
          "harness.tool_call.started",
          "harness.tool_call.succeeded",
          "harness.file.created",
          "harness.file.written_by_tool",
          "harness.artifact.created",
          "harness.persistent_dir.commit.started",
          "harness.persistent_dir.commit.succeeded",
        ]),
      );
    });
  });

  it("records bounded tool input and output metadata", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "tool-telemetry",
          doGenerate: async () => {
            call += 1;
            return call === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "done" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async ({ query }) => ({ rows: [{ query, value: 42 }] }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup." }] }] as any,
        session: "tool-telemetry",
      });

      expect(events.find((event) => event.type === "harness.tool_call.started")).toMatchObject({
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          input: expect.objectContaining({ captured: true }),
        },
      });
      expect(events.find((event) => event.type === "harness.tool_call.succeeded")).toMatchObject({
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          output: expect.objectContaining({ captured: true }),
        },
      });
    });
  });

  it("passes versioned trace envelopes to callbacks and persists the same envelope", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Run." }] }] as any,
        session: "trace-envelope",
      });

      const persisted = (await readFile(result.trace.path!, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events[0]).toEqual(
        expect.objectContaining({
          schemaVersion: "lh.trace.v2",
          eventId: persisted[0].eventId,
          sequence: 1,
          sessionId: "trace-envelope",
          type: "harness.session.started",
        }),
      );
      expect(persisted[0]).toEqual(
        expect.objectContaining({
          schemaVersion: "lh.trace.v2",
          eventId: events[0].eventId,
          sequence: 1,
          sessionId: "trace-envelope",
          type: "harness.session.started",
        }),
      );
    });
  });

  it("records model request and response metadata for debugging", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("debug text"),
        tools: {
          noop: tool({
            description: "No-op tool.",
            inputSchema: z.object({ ok: z.boolean() }),
            execute: async () => ({ ok: true }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Debug this." }] }] as any,
        session: "model-debug",
      });

      expect(events.find((event) => event.type === "harness.model.called")).toMatchObject({
        metadata: {
          stepNumber: 1,
          model: { provider: "test", modelId: "test-model" },
          request: {
            promptHash: expect.any(String),
            system: { captured: true },
            messages: [
              expect.objectContaining({
                role: "user",
                content: expect.objectContaining({ captured: true }),
              }),
            ],
            tools: expect.arrayContaining([
              expect.objectContaining({ toolName: "noop" }),
              expect.objectContaining({ toolName: "bash" }),
            ]),
          },
        },
      });
      expect(events.find((event) => event.type === "harness.model.responded")).toMatchObject({
        metadata: {
          stepNumber: 1,
          model: { provider: "test", modelId: "test-model" },
          finishReason: "stop",
          text: {
            captured: true,
            preview: "debug text",
            truncated: false,
            bytes: 10,
            sha256: expect.any(String),
          },
          usage: expect.any(Object),
        },
      });
    });
  });

  it("emits durable payloads and trace metadata from one model occurrence", async () => {
    await withTempDir(async (dir) => {
      const durable: unknown[] = [];
      const trace: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        durability: {
          append: async (event) => {
            durable.push(event);
          },
        },
        onEvent: async (event) => {
          trace.push(event);
        },
      });

      await generateHarness({
        harness,
        type: "job",
        input: {},
        session: "durable-model",
        runId: "run_durable_model",
      });

      expect(durable).toEqual([
        expect.objectContaining({
          type: "harness.session.started",
          runId: "run_durable_model",
          payload: expect.any(Object),
        }),
        expect.objectContaining({
          type: "harness.model.called",
          runId: "run_durable_model",
          occurrenceId: expect.any(String),
          payload: expect.objectContaining({
            callId: expect.any(String),
            turn: 1,
            promptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            request: expect.objectContaining({
              model: "test-model",
              messages: expect.any(Array),
              tools: expect.any(Array),
            }),
          }),
        }),
        expect.objectContaining({
          type: "harness.model.responded",
          runId: "run_durable_model",
          occurrenceId: expect.any(String),
          payload: expect.objectContaining({
            callId: expect.any(String),
            turn: 1,
            response: expect.objectContaining({ text: "done" }),
          }),
        }),
        expect.objectContaining({
          type: "harness.session.completed",
          runId: "run_durable_model",
          payload: expect.any(Object),
        }),
      ]);
      expect(trace).toContainEqual(
        expect.objectContaining({
          type: "harness.model.called",
          occurrenceId: expect.any(String),
          metadata: expect.objectContaining({
            request: expect.any(Object),
          }),
        }),
      );

      const durableModel = durable.find(
        (event) => (event as { type?: string }).type === "harness.model.called",
      ) as { occurrenceId?: string; payload?: { callId?: string } };
      const durableResponse = durable.find(
        (event) => (event as { type?: string }).type === "harness.model.responded",
      ) as { occurrenceId?: string; payload?: { callId?: string } };
      const traceModel = trace.find(
        (event) => (event as { type?: string }).type === "harness.model.called",
      ) as { occurrenceId?: string };
      expect(traceModel.occurrenceId).toBe(durableModel.occurrenceId);
      expect(durableResponse.occurrenceId).toBe(durableModel.occurrenceId);
      expect(durableResponse.payload?.callId).toBe(durableModel.payload?.callId);
    });
  });

  it("replays a completed single model response for the same runId without calling the provider again", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("cached response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Cache me." }] }] as any;

      const first = await generateHarness({ harness, messages, session: "model-replay", runId: "run_model_replay" });
      const second = await generateHarness({ harness, messages, session: "model-replay", runId: "run_model_replay" });

      expect(first.text).toBe("cached response");
      expect(second.text).toBe("cached response");
      expect(model.doGenerateCalls).toHaveLength(1);
    });
  });

  it("does not replay a completed model response when per-call temperature changes", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("temperature-sensitive response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Temperature-sensitive request." }] },
      ] as any;

      await generateHarness({
        harness,
        messages,
        session: "temperature-replay",
        runId: "run_temperature_replay",
        temperature: 0.1,
      });
      await generateHarness({
        harness,
        messages,
        session: "temperature-replay",
        runId: "run_temperature_replay",
        temperature: 0.7,
      });

      expect(model.doGenerateCalls).toHaveLength(2);
    });
  });

  it("does not replay a completed model response when activeTools changes", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("active-tools-sensitive response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Active tools sensitive request." }] },
      ] as any;

      await generateHarness({
        harness,
        messages,
        session: "active-tools-replay",
        runId: "run_active_tools_replay",
        activeTools: ["lookup"],
      });
      await generateHarness({
        harness,
        messages,
        session: "active-tools-replay",
        runId: "run_active_tools_replay",
        activeTools: ["bash"],
      });

      expect(model.doGenerateCalls).toHaveLength(2);
      expect(
        durability.events
          .filter((event) => event.type === "harness.model.called")
          .map((event) => (event.payload as { request?: { settings?: { activeTools?: string[] } } }).request?.settings?.activeTools),
      ).toEqual([["lookup"], ["bash"]]);
    });
  });

  it("does not replay a completed model response when activeTools changes from empty to omitted", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("empty-active-tools-sensitive response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Empty active tools request." }] },
      ] as any;

      await generateHarness({
        harness,
        messages,
        session: "empty-active-tools-replay",
        runId: "run_empty_active_tools_replay",
        activeTools: [],
      });
      await generateHarness({
        harness,
        messages,
        session: "empty-active-tools-replay",
        runId: "run_empty_active_tools_replay",
      });

      expect(model.doGenerateCalls).toHaveLength(2);
      const firstModelCall = durability.events.find((event) => event.type === "harness.model.called");
      expect(
        (firstModelCall?.payload as { request?: { settings?: { activeTools?: string[] } } } | undefined)
          ?.request?.settings?.activeTools,
      ).toEqual([]);
    });
  });

  it("replays a completed model response when activeTools order and duplicates change", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("active-tools-set response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Active tools set request." }] },
      ] as any;

      const first = await generateHarness({
        harness,
        messages,
        session: "active-tools-set-replay",
        runId: "run_active_tools_set_replay",
        activeTools: ["lookup", "bash", "lookup"],
      });
      const second = await generateHarness({
        harness,
        messages,
        session: "active-tools-set-replay",
        runId: "run_active_tools_set_replay",
        activeTools: ["bash", "lookup"],
      });

      expect(first.text).toBe("active-tools-set response");
      expect(second.text).toBe("active-tools-set response");
      expect(model.doGenerateCalls).toHaveLength(1);
    });
  });

  it("does not replay a completed model response when prepareStep changes activeTools", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("prepare-step-active-tools response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Prepare step active tools request." }] },
      ] as any;

      await generateHarness({
        harness,
        messages,
        session: "prepare-step-active-tools-replay",
        runId: "run_prepare_step_active_tools_replay",
        prepareStep: () => ({ activeTools: ["lookup"] }) as any,
      });
      await generateHarness({
        harness,
        messages,
        session: "prepare-step-active-tools-replay",
        runId: "run_prepare_step_active_tools_replay",
        prepareStep: () => ({ activeTools: ["bash"] }) as any,
      });

      expect(model.doGenerateCalls).toHaveLength(2);
      const preparedActiveTools = durability.events
        .filter((event) => event.type === "harness.model.called")
        .map((event) => (event.payload as { request?: { settings?: { activeTools?: string[] } } }).request?.settings?.activeTools);
      expect(preparedActiveTools).toEqual([["lookup"], ["bash"]]);
    });
  });

  it("does not replay a completed model response when toolChoice changes", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = textModel("tool-choice-sensitive response");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Tool choice sensitive request." }] },
      ] as any;

      await generateHarness({
        harness,
        messages,
        session: "tool-choice-replay",
        runId: "run_tool_choice_replay",
        toolChoice: "auto",
      });
      await generateHarness({
        harness,
        messages,
        session: "tool-choice-replay",
        runId: "run_tool_choice_replay",
        toolChoice: { type: "tool", toolName: "lookup" } as any,
      });

      expect(model.doGenerateCalls).toHaveLength(2);
    });
  });

  it("reuses an inflight model callId and appends only the terminal event after a crash window", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      const firstHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model: textModel("before crash"),
        durability: initial.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Resume me." }] }] as any;
      await generateHarness({ harness: firstHarness, messages, session: "model-crash", runId: "run_model_crash" });

      const called = initial.events.find((event) => event.type === "harness.model.called");
      expect(called).toBeDefined();
      const crashWindow = replayDurability([called!]);
      const model = textModel("after crash");
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model,
        durability: crashWindow.sink,
      });

      const result = await generateHarness({ harness, messages, session: "model-crash", runId: "run_model_crash" });
      const modelEvents = crashWindow.events.filter((event) => event.type.startsWith("harness.model."));
      const responded = crashWindow.events.find((event) => event.type === "harness.model.responded");

      expect(result.text).toBe("after crash");
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(modelEvents.filter((event) => event.type === "harness.model.called")).toHaveLength(1);
      expect(responded).toMatchObject({
        occurrenceId: called!.occurrenceId,
        payload: expect.objectContaining({
          callId: (called!.payload as { callId?: string }).callId,
          turn: (called!.payload as { turn?: number }).turn,
          response: expect.objectContaining({ text: "after crash" }),
        }),
      });
    });
  });

  it("starts a fresh model call after a prior terminal model failure", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const failingHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "failed") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "test-model",
          doGenerate: async () => {
            throw new Error("provider down");
          },
        }),
        durability: durability.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Retry me." }] }] as any;

      await expect(
        generateHarness({ harness: failingHarness, messages, session: "model-terminal-failed", runId: "run_model_terminal_failed" }),
      ).rejects.toThrow("provider down");

      const failedCall = durability.events.find((event) => event.type === "harness.model.called");
      const model = textModel("recovered");
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "recovered") }),
        model,
        durability: durability.sink,
      });

      const result = await generateHarness({ harness, messages, session: "model-terminal-failed", runId: "run_model_terminal_failed" });
      const modelCalled = durability.events.filter((event) => event.type === "harness.model.called");
      const recoveredResponse = durability.events.find(
        (event) =>
          event.type === "harness.model.responded" &&
          (event.payload as { response?: { text?: string } }).response?.text === "recovered",
      );

      expect(result.text).toBe("recovered");
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(modelCalled).toHaveLength(2);
      expect((recoveredResponse!.payload as { callId?: string }).callId).not.toBe(
        (failedCall!.payload as { callId?: string }).callId,
      );
      expect(recoveredResponse).toMatchObject({
        payload: expect.objectContaining({
          response: expect.objectContaining({ text: "recovered" }),
        }),
      });
    });
  });

  it("reuses an inflight second model call in a tool loop without appending a duplicate called event", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      let firstToolCalls = 0;
      let firstProviderCalls = 0;
      const firstHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "tool-loop-replay",
          doGenerate: async () => {
            firstProviderCalls += 1;
            return firstProviderCalls === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "first final" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        durability: initial.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => {
              firstToolCalls += 1;
              return { value: 42 };
            },
          }),
        },
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup." }] }] as any;

      await generateHarness({ harness: firstHarness, messages, session: "second-step-crash", runId: "run_second_step_crash" });
      expect(firstToolCalls).toBe(1);
      const secondCalled = initial.events.filter((event) => event.type === "harness.model.called")[1];
      expect(secondCalled).toBeDefined();

      const crashWindow = replayDurability([secondCalled!]);
      let providerCalls = 0;
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "tool-loop-replay",
          doGenerate: async () => {
            providerCalls += 1;
            return providerCalls === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "resumed final" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        durability: crashWindow.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });

      const result = await generateHarness({ harness, messages, session: "second-step-crash", runId: "run_second_step_crash" });
      const modelCalled = crashWindow.events.filter((event) => event.type === "harness.model.called");
      const resumedResponse = crashWindow.events.find(
        (event) =>
          event.type === "harness.model.responded" &&
          (event.payload as { callId?: string }).callId === (secondCalled!.payload as { callId?: string }).callId,
      );

      expect(result.text).toBe("resumed final");
      expect(providerCalls).toBe(2);
      expect(modelCalled).toHaveLength(2);
      expect(resumedResponse).toMatchObject({
        occurrenceId: secondCalled!.occurrenceId,
        payload: expect.objectContaining({
          callId: (secondCalled!.payload as { callId?: string }).callId,
          response: expect.objectContaining({ text: "resumed final" }),
        }),
      });
    });
  });

  it("replays a completed tool result for generate without invoking the tool again", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      let providerCalls = 0;
      let toolCalls = 0;
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "tool-replay",
        doGenerate: async () => {
          providerCalls += 1;
          return providerCalls === 1 || providerCalls === 3
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "lookup",
                    input: JSON.stringify({ query: "alpha" }),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: "final with tool" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => {
              toolCalls += 1;
              return { value: 42 };
            },
          }),
        },
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup." }] }] as any;

      const first = await generateHarness({ harness, messages, session: "tool-replay", runId: "run_tool_replay" });
      const second = await generateHarness({ harness, messages, session: "tool-replay", runId: "run_tool_replay" });

      expect(first.text).toBe("final with tool");
      expect(second.text).toBe("final with tool");
      expect(toolCalls).toBe(1);
    });
  });

  it("replays completed runtime bridge tool calls when rerunning an inflight bash call", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      let providerCalls = 0;
      let bridgedToolCalls = 0;
      const command =
        "js-exec -c 'await tools.counted({label:\"alpha\"}); throw new Error(\"after bridged tool\")'";
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-replay",
        doGenerate: async () => {
          providerCalls += 1;
          return providerCalls === 1
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_bash",
                    toolName: "bash",
                    input: JSON.stringify({ command }),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: "first final" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model,
        durability: initial.sink,
        tools: {
          counted: tool({
            description: "Count executions.",
            inputSchema: z.object({ label: z.string() }),
            execute: async () => {
              bridgedToolCalls += 1;
              return { value: bridgedToolCalls };
            },
          }),
        },
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as any;

      const first = await generateHarness({
        harness,
        messages,
        session: "runtime-bridge-replay",
        runId: "run_runtime_bridge_replay",
        activeTools: ["bash"],
      });
      expect(first.text).toBe("first final");
      expect(bridgedToolCalls).toBe(1);

      const bashTerminalIndex = initial.events.findIndex(
        (event) =>
          event.type !== "harness.tool_call.started" &&
          event.type.startsWith("harness.tool_call.") &&
          (event.payload as { caller?: string; toolName?: string } | undefined)?.caller === "model" &&
          (event.payload as { caller?: string; toolName?: string } | undefined)?.toolName === "bash",
      );
      expect(bashTerminalIndex).toBeGreaterThan(0);
      const crashWindow = replayDurability(initial.events.slice(0, bashTerminalIndex));
      let replayProviderCalls = 0;
      const replayHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "runtime-bridge-replay",
          doGenerate: async () => {
            replayProviderCalls += 1;
            return replayProviderCalls === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_bash",
                      toolName: "bash",
                      input: JSON.stringify({ command }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "replayed final" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        durability: crashWindow.sink,
        tools: {
          counted: tool({
            description: "Count executions.",
            inputSchema: z.object({ label: z.string() }),
            execute: async () => {
              bridgedToolCalls += 1;
              return { value: bridgedToolCalls };
            },
          }),
        },
      });

      const second = await generateHarness({
        harness: replayHarness,
        messages,
        session: "runtime-bridge-replay",
        runId: "run_runtime_bridge_replay",
        activeTools: ["bash"],
      });

      expect(second.text).toBe("replayed final");
      expect(bridgedToolCalls).toBe(1);
    });
  });

  it("replays repeated runtime bridge calls within the matching parent bash command", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      let providerCalls = 0;
      let bridgedToolCalls = 0;
      const firstCommand =
        "js-exec -c 'const result = await tools.counted({label:\"same\"}); console.log(result.value)'";
      const secondCommand =
        "js-exec -c 'const result = await tools.counted({label:\"same\"}); console.log(result.value); throw new Error(\"after second bridge call\")' > /artifacts/second-bridge-value.txt";
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "runtime-bridge-parent-scope",
        doGenerate: async () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_bash_1",
                  toolName: "bash",
                  input: JSON.stringify({ command: firstCommand }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }
          if (providerCalls === 2) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_bash_2",
                  toolName: "bash",
                  input: JSON.stringify({ command: secondCommand }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          }
          return {
            content: [{ type: "text", text: "first final" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
      });
      const counted = tool({
        description: "Count executions.",
        inputSchema: z.object({ label: z.string() }),
        execute: async () => {
          bridgedToolCalls += 1;
          return { value: bridgedToolCalls };
        },
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash twice." }] }] as any;
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model,
        durability: initial.sink,
        tools: { counted },
      });

      const first = await generateHarness({
        harness,
        messages,
        session: "runtime-bridge-parent-scope",
        runId: "run_runtime_bridge_parent_scope",
        activeTools: ["bash"],
      });
      expect(first.text).toBe("first final");
      expect(bridgedToolCalls).toBe(2);
      expect((await first.session.files.read("/artifacts/second-bridge-value.txt")).text()).toBe("2\n");

      const secondBashTerminalIndex = initial.events.findIndex(
        (event) =>
          event.type !== "harness.tool_call.started" &&
          event.type.startsWith("harness.tool_call.") &&
          (event.payload as { caller?: string; toolName?: string; callId?: string } | undefined)?.caller === "model" &&
          (event.payload as { caller?: string; toolName?: string; callId?: string } | undefined)?.toolName === "bash" &&
          (event.payload as { caller?: string; toolName?: string; callId?: string } | undefined)?.callId === "call_bash_2",
      );
      expect(secondBashTerminalIndex).toBeGreaterThan(0);

      const crashWindow = replayDurability(initial.events.slice(0, secondBashTerminalIndex));
      let replayProviderCalls = 0;
      const replayHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "runtime-bridge-parent-scope",
          doGenerate: async () => {
            replayProviderCalls += 1;
            return replayProviderCalls === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_bash_2",
                      toolName: "bash",
                      input: JSON.stringify({ command: secondCommand }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "replayed final" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        durability: crashWindow.sink,
        tools: { counted },
      });

      const second = await generateHarness({
        harness: replayHarness,
        messages,
        session: "runtime-bridge-parent-scope",
        runId: "run_runtime_bridge_parent_scope",
        activeTools: ["bash"],
      });

      expect(second.text).toBe("replayed final");
      expect(bridgedToolCalls).toBe(2);
      expect((await second.session.files.read("/artifacts/second-bridge-value.txt")).text()).toBe("2\n");
    });
  });

  it("emits model request and response metadata for every AI SDK model-loop step", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "multi-step-telemetry",
          doGenerate: async () => {
            call += 1;
            return call === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "final" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup." }] }] as any,
        session: "multi-step-telemetry",
      });

      const requested = events.filter((event) => event.type === "harness.model.called");
      const responded = events.filter((event) => event.type === "harness.model.responded");
      expect(requested.map((event) => event.stepId)).toEqual(["step_1", "step_2"]);
      expect(requested.map((event) => event.metadata.stepNumber)).toEqual([1, 2]);
      expect(responded.map((event) => event.stepId)).toEqual(["step_1", "step_2"]);
      expect(responded.map((event) => event.metadata.stepNumber)).toEqual([1, 2]);
      expect(responded[0]).toMatchObject({
        metadata: {
          finishReason: "tool-calls",
          toolCalls: [
            expect.objectContaining({
              toolName: "lookup",
              toolCallId: "call_1",
              input: expect.objectContaining({ captured: true }),
            }),
          ],
        },
      });
      expect(responded[1]).toMatchObject({
        metadata: {
          finishReason: "stop",
          text: expect.objectContaining({ preview: "final" }),
        },
      });
    });
  });

  it("emits harness.model.failed with an error envelope when the provider call fails", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "failing-model",
          doGenerate: async () => {
            throw new Error("provider down");
          },
        }),
        onEvent: (event) => {
          events.push(event);
        },
      });

      await expect(
        generateHarness({
          harness,
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Fail." }] }] as any,
          session: "model-failed",
        }),
      ).rejects.toThrow("provider down");

      expect(events.find((event) => event.type === "harness.model.failed")).toMatchObject({
        stepId: "step_1",
        metadata: {
          stepNumber: 1,
          model: { provider: "test", modelId: "failing-model" },
          error: { name: "Error", message: "provider down" },
        },
      });
      expect(events.find((event) => event.type === "harness.session.failed")).toBeDefined();
    });
  });

  it("honors trace policy that disables model message capture", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("sensitive response"),
        trace: { content: { captureModelMessages: false } },
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Sensitive prompt." }] }] as any,
        session: "model-capture-disabled",
      });

      expect(events.find((event) => event.type === "harness.model.called")).toMatchObject({
        metadata: {
          request: {
            system: { captured: false },
            messages: [expect.objectContaining({ content: { captured: false } })],
          },
        },
      });
      expect(events.find((event) => event.type === "harness.model.responded")).toMatchObject({
        metadata: {
          text: { captured: false },
        },
      });
    });
  });

  it("redacts sensitive metadata keys across model file and staged-message events", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        trace: { redaction: { metadataKeys: ["customerId"] } },
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "redaction-model",
          doGenerate: {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [{ type: "other", message: "warning", apiKey: "warning-secret" } as any],
            providerMetadata: {
              test: { apiKey: "provider-secret", customerId: "customer-secret", safe: "ok" },
            },
          },
        }),
        inputTypes: {
          job: inputType({
            description: "Write metadata.",
            toMessages: async ({ files }) => {
              await files.writeText("/session/from-input.md", "ok", {
                metadata: { apiKey: "input-secret" },
              });
              return [{ role: "user", content: "Run redaction." }];
            },
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        type: "job",
        input: {},
        session: "metadata-redaction",
      });

      const serialized = JSON.stringify(events);
      expect(serialized).toContain("[redacted]");
      expect(serialized).toContain("ok");
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("customer-secret");
      expect(serialized).not.toContain("warning-secret");
      expect(serialized).not.toContain("input-secret");
    });
  });

  it("does not persist trace events when per-run trace is disabled but still calls onEvent", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No trace." }] }] as any,
        session: "trace-disabled",
        trace: false,
      });

      await expect(readFile(result.trace.path!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            eventId: expect.stringMatching(/^evt_/),
            sequence: 1,
            type: "harness.session.started",
            sessionId: "trace-disabled",
          }),
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            type: "harness.model.responded",
            sessionId: "trace-disabled",
          }),
        ]),
      );
    });
  });

  it("does not persist trace events when harness trace is disabled but still calls onEvent", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        trace: false,
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No trace." }] }] as any,
        session: "harness-trace-disabled",
      });

      await expect(readFile(result.trace.path!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            sequence: 1,
            type: "harness.session.started",
            sessionId: "harness-trace-disabled",
          }),
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            type: "harness.model.responded",
            sessionId: "harness-trace-disabled",
          }),
        ]),
      );
    });
  });

  it("emits harness.filesystem.mounted events with mounted file metadata", async () => {
    await withTempDir(async (dir) => {
      const skillRoot = path.join(dir, "skills", "trace-skill");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: trace-skill\ndescription: Trace skill.\n---\n\nUse traces.",
        "utf8",
      );
      const mountedEvents: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "harness") }),
        model: textModel("done"),
        skills: [skillRoot],
        persistentDirs: [
          {
            harnessDir: "/persistent/memory",
            load: () => ({ "note.md": "PERSISTENT_CONTENT_SENTINEL" }),
            commit: "read-only",
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Write session input.",
            toMessages: async ({ files }) => {
              await files.writeText("/session/input.md", "SESSION_CONTENT_SENTINEL");
              return [{ role: "user", content: "Inspect mounts." }];
            },
          }),
        },
        onEvent: (event) => {
          if (event.type === "harness.filesystem.mounted") {
            mountedEvents.push(event.metadata);
          }
        },
      });

      await generateHarness({ harness, type: "job", input: {}, session: "mounts" });

      expect(mountedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            root: "session",
            harnessDir: "/session",
            source: "session",
            writable: true,
            fileCount: 1,
            files: expect.arrayContaining([
              expect.objectContaining({ path: "/session/input.md", kind: "file", bytes: expect.any(Number) }),
            ]),
          }),
          expect.objectContaining({
            root: "agents",
            harnessDir: "/.agents",
            source: "skill",
            writable: false,
            files: expect.arrayContaining([
              expect.objectContaining({
                path: "/.agents/skills/trace-skill/SKILL.md",
                kind: "file",
                bytes: expect.any(Number),
              }),
            ]),
          }),
          expect.objectContaining({
            root: "persistent",
            harnessDir: "/persistent",
            source: "persistent_dir",
            commit: "read-only",
            writable: true,
            files: expect.arrayContaining([
              expect.objectContaining({
                path: "/persistent/memory/note.md",
                kind: "file",
                bytes: expect.any(Number),
              }),
            ]),
          }),
        ]),
      );
      expect(JSON.stringify(mountedEvents)).not.toContain("PERSISTENT_CONTENT_SENTINEL");
      expect(JSON.stringify(mountedEvents)).not.toContain("SESSION_CONTENT_SENTINEL");
    });
  });

  it("emits file and artifact events for files written by the bash runtime", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: string[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "bash-events",
          doGenerate: async () => {
            call += 1;
            return call === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "bash",
                      input: JSON.stringify({
                        command: "mkdir -p /artifacts/bash && echo bash > /artifacts/bash/out.txt",
                      }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "done" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      const result = await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as any,
        session: "bash-events",
      });

      expect((await result.session.files.read("/artifacts/bash/out.txt")).text()).toBe("bash\n");
      expect(events).toEqual(
        expect.arrayContaining(["harness.file.created", "harness.file.written_by_tool", "harness.artifact.created"]),
      );
    });
  });

  it("emits runtime command telemetry and file diffs for bash writes", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "bash-runtime-events",
          doGenerate: async () => {
            call += 1;
            return call === 1
              ? {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "bash",
                      input: JSON.stringify({
                        command: "printf 'new line\\n' > /session/bash-note.md && cat /session/bash-note.md",
                      }),
                    },
                  ],
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                  warnings: [],
                }
              : {
                  content: [{ type: "text", text: "done" }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                  warnings: [],
                };
          },
        }),
        onEvent: (event) => {
          events.push(event);
        },
      });

      await generateHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as any,
        session: "bash-runtime-events",
      });

      expect(events.find((event) => event.type === "harness.runtime.command.started")).toMatchObject({
        metadata: { command: "printf 'new line\\n' > /session/bash-note.md && cat /session/bash-note.md" },
      });
      expect(events.find((event) => event.type === "harness.runtime.command.succeeded")).toMatchObject({
        metadata: {
          command: "printf 'new line\\n' > /session/bash-note.md && cat /session/bash-note.md",
          exitCode: 0,
          stdout: expect.objectContaining({ captured: true, preview: "new line\n" }),
          stderr: expect.objectContaining({ captured: true, preview: "" }),
        },
      });
      expect(events.find((event) => event.type === "harness.file.created" && event.metadata?.path === "/session/bash-note.md")).toMatchObject({
        metadata: {
          root: "session",
          after: { bytes: 9, sha256: expect.any(String) },
          diff: {
            available: true,
            format: "unified",
            preview: expect.stringContaining("+new line"),
          },
        },
      });
    });
  });

  it("allows manual Persistent Dirs to be committed from the completed result", async () => {
    await withTempDir(async (dir) => {
      const stored: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: textModel("done"),
        persistentDirs: [
          {
            harnessDir: "/persistent/manual",
            commit: "manual",
            load: () => ({}),
            store: ({ changes }) => {
              stored.push(changes);
            },
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Write manual memory.",
            toMessages: async ({ files }) => {
              await files.writeText("/persistent/manual/note.md", "manual");
              return [{ role: "user", content: "Manual commit." }];
            },
          }),
        },
      });

      const result = await generateHarness({ harness, type: "job", input: {}, session: "manual" });

      expect(result.persistence).toMatchObject({
        status: "succeeded",
        commits: [{ harnessDir: "/persistent/manual", commit: "manual", status: "skipped" }],
      });
      expect(stored).toHaveLength(0);

      const manual = await result.commitManual();
      expect(manual).toMatchObject({
        status: "succeeded",
        commits: [{ harnessDir: "/persistent/manual", commit: "manual", status: "succeeded" }],
      });
      expect(stored).toHaveLength(1);
    });
  });

  it("serializes manual Persistent Dir commits with later same-session turns", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      let releaseSecond!: () => void;
      let secondStarted!: () => void;
      const secondStartedPromise = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      const releaseSecondPromise = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const stored: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "manual-commit-lock",
          doGenerate: async () => {
            call += 1;
            if (call === 2) {
              secondStarted();
              await releaseSecondPromise;
            }
            return {
              content: [{ type: "text", text: `done ${call}` }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            };
          },
        }),
        persistentDirs: [
          {
            harnessDir: "/persistent/manual",
            commit: "manual",
            load: () => ({}),
            store: ({ changes }) => {
              stored.push(changes);
            },
          },
        ],
        inputTypes: {
          write: inputType({
            description: "Write manual memory.",
            toMessages: async ({ files }) => {
              await files.writeText("/persistent/manual/note.md", "manual");
              return [{ role: "user", content: "Write manual memory." }];
            },
          }),
          noop: inputType({
            description: "No-op turn.",
            toMessages: () => [{ role: "user", content: "No-op." }],
          }),
        },
      });

      const first = await generateHarness({ harness, type: "write", input: {}, session: "manual-lock" });
      const second = generateHarness({ harness, type: "noop", input: {}, session: "manual-lock" });
      await secondStartedPromise;

      let manualDone = false;
      const manual = first.commitManual().then(() => {
        manualDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(manualDone).toBe(false);
      expect(stored).toHaveLength(0);

      releaseSecond();
      await second;
      await manual;
      expect(stored).toHaveLength(1);
    });
  });
});
