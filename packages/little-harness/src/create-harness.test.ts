import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { HarnessInputError } from "./errors.js";
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
