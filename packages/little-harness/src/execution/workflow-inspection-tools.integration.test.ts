import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { HarnessWorkflow } from "../workflows.js";
import { generateHarness } from "./generate-harness.js";

const mcpResolverMock = vi.hoisted(() => ({
  resolveHarnessMcpGateway: vi.fn(),
}));

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

it("lets the model inspect available workflows before choosing one", async () => {
  await withTempDir(async (dir) => {
    const workflow: HarnessWorkflow = {
      id: "candidate.review",
      description: "Review a candidate application.",
      inputSchema: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { candidateId: { type: "string" } },
          required: ["candidateId"],
          additionalProperties: false,
        },
      },
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        runId: ctx.reservedRunId,
        output: { ok: true },
      }),
    };
    let call = 0;
    const seenToolNames: string[][] = [];
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "workflow-inspection-tools",
      doGenerate: async (options) => {
        call += 1;
        seenToolNames.push(providerToolNames(options.tools));
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_list_workflows",
                toolName: "list_workflows",
                input: JSON.stringify({}),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        secondPrompt = JSON.stringify(options.prompt);
        return {
          content: [{ type: "text", text: "I found candidate.review." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      workflows: [workflow],
    });

    const result = await generateHarness({ harness, type: "job", input: {} });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("I found candidate.review.");
    expect(call).toBe(2);
    expect(seenToolNames[0]).toEqual(expect.arrayContaining([
      "candidate_review",
      "list_workflows",
      "get_workflow",
      "get_workflow_task",
      "get_workflow_run",
    ]));
    expect(secondPrompt).toContain("candidate.review");
    expect(secondPrompt).toContain("Review a candidate application.");
  });
});
