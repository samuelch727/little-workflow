import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { withTempDir } from "../test/temp.js";
import { wrapToolsWithHarnessContext } from "./tools.js";

describe("wrapToolsWithHarnessContext", () => {
  it("passes files, extraBody, session, and abortSignal into AI SDK tool execute functions", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const controller = new AbortController();
      const wrapped = wrapToolsWithHarnessContext(
        {
          exportRows: tool({
            description: "Export rows.",
            inputSchema: z.object({ count: z.number() }),
            execute: async (input, ctx: any) => {
              const file = await ctx.files.writeJSON("/artifacts/tool/export/result.json", {
                count: input.count,
                sessionId: ctx.session.id,
                userId: ctx.extraBody.userId,
                aborted: ctx.abortSignal.aborted,
              });
              return { path: file.path };
            },
          }),
        },
        {
          session,
          files: session.files,
          artifacts: session.artifacts,
          extraBody: { userId: "u1" },
          abortSignal: controller.signal,
        },
      );

      const result = await (wrapped.exportRows as any).execute({ count: 3 }, {});

      expect(result.path).toBe("/artifacts/tool/export/result.json");
      expect((await session.files.read(result.path)).json()).toEqual({
        count: 3,
        sessionId: "chat",
        userId: "u1",
        aborted: false,
      });
    });
  });

  it("spools oversized string tool results to an artifact file", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const longResult = `start\n${"x".repeat(80)}\nLONG_TOOL_SENTINEL_8472`;
      const wrapped = wrapToolsWithHarnessContext(
        {
          longLookup: tool({
            description: "Return a large lookup result.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => longResult,
          }),
        },
        {
          session,
          files: session.files,
          artifacts: session.artifacts,
          toolResultSpooling: {
            maxInlineBytes: 32,
            previewBytes: 12,
          },
        },
      );

      const result = await (wrapped.longLookup as any).execute(
        { query: "alpha" },
        { toolCallId: "call_1" },
      );

      expect(result).toMatchObject({
        type: "harness.tool_result_file",
        toolName: "longLookup",
        path: "/artifacts/tool-results/longLookup/call_1.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(longResult).byteLength,
        summary: {
          format: "text",
          characters: longResult.length,
          lines: 3,
        },
        truncated: true,
        preview: "start\nxxxxxx",
      });
      expect(result.message).toContain("read");
      expect((await session.files.read(result.path)).text()).toBe(longResult);
    });
  });

  it("does not base64-spool binary tool results", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const binary = new Uint8Array([0, 1, 2, 3]);
      const wrapped = wrapToolsWithHarnessContext(
        {
          binaryLookup: tool({
            description: "Return binary data.",
            inputSchema: z.object({}),
            execute: async () => binary,
          }),
        },
        {
          session,
          files: session.files,
          artifacts: session.artifacts,
          toolResultSpooling: {
            maxInlineBytes: 1,
          },
        },
      );

      const result = await (wrapped.binaryLookup as any).execute({}, { toolCallId: "call_1" });

      expect(result).toBe(binary);
      await expect(session.files.list("/artifacts/tool-results", { recursive: true })).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("summarizes oversized structured tool results with a bounded JSON shape", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const rows = [
        {
          id: "acct_1",
          arr: 2400,
          active: true,
          tags: ["enterprise", "renewal"],
          owner: { id: "user_1", team: "sales" },
        },
        {
          id: "acct_2",
          arr: 1200,
          active: false,
          tags: ["self-serve"],
          owner: { id: "user_2", region: "us" },
        },
      ];
      const wrapped = wrapToolsWithHarnessContext(
        {
          queryAccounts: tool({
            description: "Query account rows.",
            inputSchema: z.object({ segment: z.string() }),
            execute: async () => ({ rows, nextCursor: null }),
          }),
        },
        {
          session,
          files: session.files,
          artifacts: session.artifacts,
          toolResultSpooling: {
            maxInlineBytes: 32,
          },
        },
      );

      const result = await (wrapped.queryAccounts as any).execute(
        { segment: "renewal" },
        { toolCallId: "call_rows" },
      );

      expect(result).toMatchObject({
        type: "harness.tool_result_file",
        toolName: "queryAccounts",
        path: "/artifacts/tool-results/queryAccounts/call_rows.json",
        mediaType: "application/json",
        summary: {
          format: "json",
          structure: {
            type: "object",
            keys: [
              {
                name: "rows",
                value: {
                  type: "array",
                  length: 2,
                  element: {
                    type: "object",
                    keys: [
                      { name: "id", value: { type: "string" } },
                      { name: "arr", value: { type: "number" } },
                      { name: "active", value: { type: "boolean" } },
                      { name: "tags", value: { type: "array", length: 2, element: { type: "string" } } },
                      {
                        name: "owner",
                        value: {
                          type: "object",
                          keys: [
                            { name: "id", value: { type: "string" } },
                            { name: "team", optional: true, value: { type: "string" } },
                            { name: "region", optional: true, value: { type: "string" } },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
              { name: "nextCursor", value: { type: "null" } },
            ],
          },
        },
      });
      expect(result.summary.characters).toBeGreaterThan(200);
      expect(result.summary.lines).toBeGreaterThan(10);
    });
  });
});
