import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalFileWriter } from "../files/file-writer.js";
import { sessionPaths, type LocalHostPaths } from "../local-host/paths.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "../trace/options.js";
import { modelRespondedMetadata, toolRefsForDurableRequest } from "./model-events.js";

const ticketSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    priority: { enum: ["low", "high"] },
  },
  required: ["summary", "priority"],
  additionalProperties: false,
} as const;

const zodTicketSchema = z.object({
  summary: z.string(),
  priority: z.enum(["low", "high"]),
});

function aiSdkSchemaFor(schema: unknown): unknown {
  return {
    [Symbol.for("vercel.ai.schema")]: true,
    _type: undefined,
    get jsonSchema() {
      return schema;
    },
    validate() {
      return { success: true, value: {} };
    },
  };
}

describe("modelRespondedMetadata", () => {
  it("captures provider-exposed reasoning, tool calls, sources, and generated file metadata", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const files = createLocalFileWriter(sessionPaths(paths, "chat_123"));

      const metadata = await modelRespondedMetadata({
        stepNumber: 2,
        model: { provider: "test", modelId: "rich-model-step" } as any,
        result: {
          finishReason: "tool-calls",
          rawFinishReason: "provider-tool-use",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          warnings: [{ type: "other", message: "low confidence" }],
          providerMetadata: { test: { traceId: "provider_1" } },
          reasoningText: "visible reasoning",
          toolCalls: [
            { toolName: "lookup", toolCallId: "call_1", input: { query: "alpha" } },
          ],
          sources: [{ sourceType: "url", id: "src_1", url: "https://example.com" }],
          files: [
            {
              mediaType: "text/plain",
              uint8Array: new TextEncoder().encode("generated file"),
            },
          ],
        },
        text: "ask lookup",
        files,
        traceOptions: resolveTraceOptions(undefined, undefined),
      });

      expect(metadata).toMatchObject({
        stepNumber: 2,
        finishReason: "tool-calls",
        rawFinishReason: "provider-tool-use",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        warnings: [{ type: "other", message: "low confidence" }],
        providerMetadata: { test: { traceId: "provider_1" } },
        reasoning: expect.objectContaining({
          captured: true,
          preview: "visible reasoning",
        }),
        toolCalls: [
          expect.objectContaining({
            toolName: "lookup",
            toolCallId: "call_1",
            input: expect.objectContaining({ captured: true }),
          }),
        ],
        sources: [{ sourceType: "url", id: "src_1", url: "https://example.com" }],
        generatedFiles: [
          {
            mediaType: "text/plain",
            bytes: 14,
            sha256: expect.any(String),
          },
        ],
      });
    });
  });
});

describe("toolRefsForDurableRequest", () => {
  it("hashes sorted tool descriptions and normalized schemas without storing raw schema content", () => {
    expect(
      toolRefsForDurableRequest({
        lookup: {
          description: "Lookup tool",
          inputSchema: aiSdkSchemaFor(ticketSchema) as any,
          outputSchema: zodTicketSchema,
        },
      }),
    ).toEqual([
      {
        toolName: "lookup",
        descriptionHash: "sha256:6de1d4670c63c21ceffbf908fac2be01a0c5522a7a62b7ade27afdae04e8272d",
        inputSchemaHash: "sha256:fb5097d1708ff90689555248b7a0b6f8614d656e34e99cfaf7e38ed4f439128b",
        outputSchemaHash: "sha256:d5aa0ee45b0e241f5825c0112f1d10f66415ba18c9fb5a9ef88b2f6722a02a6f",
      },
    ]);
  });
});
