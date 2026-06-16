import { describe, expect, it } from "vitest";
import { createLocalFileWriter } from "../files/file-writer.js";
import { sessionPaths, type LocalHostPaths } from "../local-host/paths.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "../trace/options.js";
import { toolCallMetadata } from "./tool-events.js";

describe("toolCallMetadata", () => {
  it("records caller, step id, bounded input, output, and spooled output refs", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const files = createLocalFileWriter(sessionPaths(paths, "chat_123"));

      const metadata = await toolCallMetadata(
        {
          stepNumber: 1,
          toolCall: {
            toolName: "lookup",
            toolCallId: "call_1",
            input: { query: "alpha" },
          },
          success: true,
          durationMs: 25,
          output: {
            type: "harness.tool_result_file",
            toolName: "lookup",
            toolCallId: "call_1",
            path: "/artifacts/tool-results/lookup/call_1.json",
            bytes: 24000,
            sha256: "abc123",
            mediaType: "application/json",
            preview: "{\"rows\":",
          },
        },
        files,
        resolveTraceOptions(undefined, undefined),
      );

      expect(metadata).toMatchObject({
        toolName: "lookup",
        toolCallId: "call_1",
        caller: "model",
        stepId: "step_2",
        durationMs: 25,
        input: expect.objectContaining({ captured: true }),
        output: expect.objectContaining({ captured: true }),
        spooled: {
          path: "/artifacts/tool-results/lookup/call_1.json",
          bytes: 24000,
          sha256: "abc123",
          mediaType: "application/json",
        },
      });
    });
  });

  it("records structured error envelopes for failed tools", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const files = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const error = new Error("lookup failed");
      error.cause = { status: 503 };

      const metadata = await toolCallMetadata(
        {
          stepNumber: 0,
          toolCall: { toolName: "lookup", toolCallId: "call_1", input: { query: "alpha" } },
          success: false,
          durationMs: 10,
          error,
        },
        files,
        resolveTraceOptions(undefined, undefined),
      );

      expect(metadata).toMatchObject({
        toolName: "lookup",
        toolCallId: "call_1",
        caller: "model",
        stepId: "step_1",
        durationMs: 10,
        error: {
          name: "Error",
          message: "lookup failed",
          cause: { status: 503 },
        },
      });
    });
  });
});
