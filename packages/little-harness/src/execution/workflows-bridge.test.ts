import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { HarnessWorkflow } from "../workflows.js";
import { generateHarness } from "./generate-harness.js";

const mcpResolverMock = vi.hoisted(() => ({ resolveHarnessMcpGateway: vi.fn() }));
vi.mock("../mcp.js", () => ({
  resolveHarnessMcpGateway: mcpResolverMock.resolveHarnessMcpGateway,
}));

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

beforeEach(() => {
  mcpResolverMock.resolveHarnessMcpGateway.mockReset();
  mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValue({
    tools: {},
    skills: [],
    manifest: { servers: [] },
    close: async () => {},
  });
});

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

it("exposes each workflow listed in createHarness({ workflows }) as a named tool to the agent", async () => {
  await withTempDir(async (dir) => {
    let seenToolNames: string[] = [];
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "test-model",
      doGenerate: async (options) => {
        seenToolNames = providerToolNames(options.tools);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const refund: HarnessWorkflow = {
      id: "billing.refund",
      description: "Process a customer refund.",
      inputSchema: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
      executionMode: "inline",
      definitionIdentity: "sha256:test-billing-refund",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        output: { ok: true },
        runId: ctx.reservedRunId,
      }),
    };
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      workflows: [refund],
    });

    await generateHarness({ harness, type: "job", input: {} });

    expect(seenToolNames).toContain("billing_refund");
  });
});

it("runs the workflow when the agent calls its full-id tool and returns compact metadata to the agent", async () => {
  await withTempDir(async (dir) => {
    let receivedInput: unknown;
    let receivedContext: unknown;
    const refund: HarnessWorkflow = {
      id: "billing.refund",
      description: "Process a customer refund.",
      inputSchema: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            amountCents: { type: "number" },
            reason: { type: "string" },
          },
          required: ["orderId", "amountCents", "reason"],
          additionalProperties: false,
        },
      },
      executionMode: "inline",
      definitionIdentity: "sha256:test-billing-refund",
      runForHarness: async (input, ctx) => {
        receivedInput = input;
        receivedContext = ctx;
        return {
          protocolVersion: 1,
          status: "completed",
          runId: ctx.reservedRunId,
          output: { status: "refunded", amountCents: 4999 },
          summary: "REFUND_SENTINEL_7",
        };
      },
    };

    let call = 0;
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "refund-bridge",
      doGenerate: async (options) => {
        call += 1;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_refund",
                toolName: "billing_refund",
                input: JSON.stringify({ orderId: "O-9", amountCents: 4999, reason: "arrived late" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        secondPrompt = JSON.stringify(options.prompt);
        return {
          content: [{ type: "text", text: "Your refund is processed." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });

    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      workflows: [refund],
    });

    const result = await generateHarness({
      harness,
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Refund order O-9." }] }] as any,
      session: "refund-bridge",
    });

    // The harness ran the workflow tool with exactly the args the model supplied.
    expect(receivedInput).toEqual({ orderId: "O-9", amountCents: 4999, reason: "arrived late" });
    expect(receivedContext).toMatchObject({
      protocolVersion: 1,
      workflowId: "billing.refund",
      workflowHandle: "billing_refund",
      disposition: "await",
      parentSessionId: "refund-bridge",
      parentTurnId: expect.any(String),
      originTurnId: expect.any(String),
      // Under the host data dir, never relative to the process cwd (LIT-44).
      persistence: { dataDir: join(dir, "sessions", "refund-bridge", "workflows") },
      toolCallId: "call_refund",
    });
    // The workflow summary flows back as compact tool metadata for the agent.
    expect(secondPrompt).toContain("REFUND_SENTINEL_7");
    expect(result.text).toBe("Your refund is processed.");
  });
});

it("passes configured tool allowlists into workflow context capabilities", async () => {
  await withTempDir(async (dir) => {
    const lookupOrder = tool({
      description: "Lookup an order.",
      inputSchema: jsonSchema({
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      }),
      execute: async () => ({ status: "found" }),
    });
    let receivedCapabilities: unknown;
    const refund: HarnessWorkflow = {
      id: "billing.refund",
      description: "Process a customer refund.",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      definitionIdentity: "sha256:test-billing-refund",
      inheritancePolicy: {
        tools: { mode: "allowlist", handles: ["lookup_order"] },
      },
      runForHarness: async (_input, ctx) => {
        receivedCapabilities = ctx.capabilities;
        return {
          protocolVersion: 1,
          status: "completed",
          runId: ctx.reservedRunId,
          output: { ok: true },
          summary: "CAPABILITY_SENTINEL_3",
        };
      },
    };

    let call = 0;
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "workflow-capabilities",
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_refund",
                toolName: "billing_refund",
                input: JSON.stringify({ orderId: "O-9" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
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
      tools: { lookup_order: lookupOrder },
      workflows: [refund],
    });

    await generateHarness({
      harness,
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Refund order O-9." }] }] as any,
      session: "refund-capabilities",
    });

    expect(receivedCapabilities).toMatchObject({
      tools: { lookup_order: lookupOrder },
    });
  });
});

it("rejects MCP tools that collide with workflow handles before the model turn", async () => {
  await withTempDir(async (dir) => {
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "test-model",
      doGenerate: async () => {
        throw new Error("model should not be called");
      },
    });
    const candidate: HarnessWorkflow = {
      id: "candidate.review",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        output: "ok",
        runId: ctx.reservedRunId,
      }),
    };
    mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValueOnce({
      tools: {
        candidate_review: tool({
          description: "Conflicting MCP tool.",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({}),
        }),
      },
      skills: [],
      manifest: { servers: [] },
      close: async () => {},
    });
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      mcp: { servers: [] },
      workflows: [candidate],
    });

    await expect(generateHarness({ harness, type: "job", input: {} })).rejects.toThrow(/collides/i);
  });
});

it("rejects MCP tools that use the generated workflow launcher prefix before the model turn", async () => {
  await withTempDir(async (dir) => {
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "test-model",
      doGenerate: async () => {
        throw new Error("model should not be called");
      },
    });
    const candidate: HarnessWorkflow = {
      id: "candidate.review",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        output: "ok",
        runId: ctx.reservedRunId,
      }),
    };
    mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValueOnce({
      tools: {
        start_candidate_review: tool({
          description: "Reserved MCP tool.",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({}),
        }),
      },
      skills: [],
      manifest: { servers: [] },
      close: async () => {},
    });
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      mcp: { servers: [] },
      workflows: [candidate],
    });

    await expect(generateHarness({ harness, type: "job", input: {} })).rejects.toThrow(/reserved start_/i);
  });
});
