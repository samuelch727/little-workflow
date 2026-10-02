import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { HarnessInputError } from "./errors.js";
import type { HarnessMcpConfig } from "./mcp.js";
import { withTempDir } from "./test/temp.js";
import { createHarness } from "./create-harness.js";
import { localHost } from "./local-host/index.js";
import { memory } from "./memory/memory.js";
import { skill } from "./skills/skill.js";

const model = { provider: "test", modelId: "test" } as any;

describe("createHarness", () => {
  it("returns an opaque harness with sessions and normalized config", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        system: "Be useful.",
      });

      expect(harness.config.model).toBe(model);
      expect(harness.config.tools).toEqual({});
      expect(harness.config.trace).toEqual({
        enabled: true,
        schemaVersion: "lh.trace.v2",
        content: {
          previewBytes: 512,
          maxInlineBytes: 16 * 1024,
          captureReasoning: true,
          captureModelMessages: true,
          captureToolInputs: true,
          captureToolOutputs: true,
        },
        fileDiffs: {
          enabled: true,
          maxInlineBytes: 8 * 1024,
          maxBytesToDiff: 256 * 1024,
        },
        redaction: {
          paths: [],
          metadataKeys: ["apiKey", "authorization", "cookie", "set-cookie", "token", "password", "secret"],
        },
      });
      const session = await harness.sessions.getOrCreate({ id: "chat_123" });
      expect(session.id).toBe("chat_123");
    });
  });

  it("accepts harness-level remote skill audit defaults", async () => {
    await withTempDir(async (dir) => {
      const envToken: string | undefined = process.env.VERCEL_OIDC_TOKEN;
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        skillMaxRisk: "LOW",
        skillOidcToken: envToken,
        skills: [skill("https://github.com/org/repo", { skills: ["alpha"] })],
      });

      expect(harness.config.skillMaxRisk).toBe("LOW");
      expect(harness.config.skillOidcToken).toBe(envToken);
    });
  });

  it("applies workflow budget defaults", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        system: "Be useful.",
      });

      expect(harness.config.workflowBudgets).toEqual({
        maxModelSteps: 20,
        maxToolCallsPerTurn: 100,
        maxConcurrentToolCalls: 10,
        maxConcurrentWorkflowRuns: 10,
        maxQueuedWorkflowRuns: 100,
        maxAutonomousTurns: 10,
      });
      expect(harness.config.workflowBudgets).not.toHaveProperty("toolDeadlineMs");
      expect(harness.config.workflowBudgets).not.toHaveProperty("workflowDeadlineMs");
      expect(harness.config.workflowBudgets).not.toHaveProperty("queueDeadlineMs");
      expect(harness.config.workflowBudgets).not.toHaveProperty("maxDynamicWorkflowTokens");
      expect(harness.config.workflowBudgets).not.toHaveProperty("maxDynamicWorkflowOutputBytes");
    });
  });

  it("preserves workflow budget defaults when users provide partial overrides", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        system: "Be useful.",
        workflowBudgets: {
          maxConcurrentWorkflowRuns: 2,
          maxQueuedWorkflowRuns: 3,
          queueDeadlineMs: 30_000,
          maxDynamicWorkflowTokens: 8_000,
        },
      });

      expect(harness.config.workflowBudgets).toEqual({
        maxModelSteps: 20,
        maxToolCallsPerTurn: 100,
        maxConcurrentToolCalls: 10,
        maxConcurrentWorkflowRuns: 2,
        maxQueuedWorkflowRuns: 3,
        maxAutonomousTurns: 10,
        queueDeadlineMs: 30_000,
        maxDynamicWorkflowTokens: 8_000,
      });
      expect(harness.config.workflowBudgets).not.toHaveProperty("toolDeadlineMs");
      expect(harness.config.workflowBudgets).not.toHaveProperty("workflowDeadlineMs");
      expect(harness.config.workflowBudgets).not.toHaveProperty("maxDynamicWorkflowOutputBytes");
    });
  });

  it("preserves MCP config in the normalized harness config", async () => {
    await withTempDir(async (dir) => {
      const mcp: HarnessMcpConfig = {
        servers: [
          {
            id: "figma",
            description: "Figma MCP server.",
            transport: { type: "http", url: "https://mcp.example.test/figma" },
          },
        ],
      };
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        mcp,
        memory: memory({
          sourceDir: "memory/db-query-agent",
        }),
      });

      expect(harness.config.mcp).toBe(mcp);
      expect(harness.config.tools).toHaveProperty("remember");
    });
  });

  it("expands memory into resolved config, persistent dir, and remember tool", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: memory({
          sourceDir: "memory/db-query-agent",
        }),
      });

      expect(harness.config.memory).toHaveLength(1);
      expect(harness.config.memory[0]).toMatchObject({
        harnessDir: "/persistent/memory",
        indexPath: "MEMORY.md",
        toolName: "remember",
      });
      expect(harness.config.persistentDirs).toHaveLength(1);
      expect(harness.config.persistentDirs[0]).toMatchObject({
        harnessDir: "/persistent/memory",
        commit: "after-turn",
      });
      expect(harness.config.tools).toHaveProperty("remember");
    });
  });

  it("preserves explicit persistent dirs before the memory persistent dir", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        persistentDirs: [
          {
            harnessDir: "/persistent/project",
            commit: "manual",
          },
        ],
        memory: memory({
          sourceDir: "memory/db-query-agent",
        }),
      });

      expect(harness.config.persistentDirs.map((persistentDir) => persistentDir.harnessDir)).toEqual([
        "/persistent/project",
        "/persistent/memory",
      ]);
    });
  });

  it("rejects duplicate memory persistent dirs after normalizing trailing slashes", async () => {
    await withTempDir(async (dir) => {
      expect(() =>
        createHarness({
          host: localHost({ dataDir: dir }),
          model,
          persistentDirs: [
            {
              harnessDir: "/persistent/memory/",
            },
          ],
          memory: memory({
            sourceDir: "memory/db-query-agent",
          }),
        }),
      ).toThrow(HarnessInputError);
    });
  });

  it("rejects duplicate memory persistent dirs after canonicalizing path segments", async () => {
    await withTempDir(async (dir) => {
      for (const harnessDir of ["/persistent/./memory", "/persistent//memory", "/persistent/foo/../memory"]) {
        expect(() =>
          createHarness({
            host: localHost({ dataDir: dir }),
            model,
            persistentDirs: [
              {
                harnessDir,
              },
            ],
            memory: memory({
              sourceDir: "memory/db-query-agent",
            }),
          }),
        ).toThrow(HarnessInputError);
      }
    });
  });

  it("resolves dynamicWorkflows and registers the authored-plans persistent dir", async () => {
    await withTempDir(async (dir) => {
      const factory = {
        compile: () => ({ ok: false as const, causeCode: "plan_invalid" as const, message: "x" }),
      };
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        dynamicWorkflows: { enabled: true, factory },
      });

      expect(harness.config.dynamicWorkflows).toBeDefined();
      expect(harness.config.dynamicWorkflows?.factory).toBe(factory);
      expect(
        harness.config.persistentDirs.map((persistentDir) => persistentDir.harnessDir),
      ).toContain("/persistent/dynamic-plans");
    });
  });

  it("leaves dynamicWorkflows unset and adds no authored-plans dir when disabled", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
      });

      expect(harness.config.dynamicWorkflows).toBeUndefined();
      expect(
        harness.config.persistentDirs.map((persistentDir) => persistentDir.harnessDir),
      ).not.toContain("/persistent/dynamic-plans");
    });
  });

  it("rejects reserved user tool names before runtime tools are merged", async () => {
    await withTempDir(async (dir) => {
      expect(() =>
        createHarness({
          host: localHost({ dataDir: dir }),
          model,
          tools: {
            bash: tool({
              inputSchema: z.object({}),
              execute: async () => "user bash",
            }),
          },
        }),
      ).toThrow(HarnessInputError);
    });
  });
});
