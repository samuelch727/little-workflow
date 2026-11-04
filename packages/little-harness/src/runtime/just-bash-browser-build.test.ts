import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import { generateHarness } from "../execution/generate-harness.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { classifyCommand } from "./command-classification.js";
import { justBashSandbox } from "./just-bash-runtime.js";
import { tier0CapabilityMatrix } from "./tier0-capability-matrix.js";

// Stand in for workerd: just-bash's browser build has none of the Node-only exports.
vi.mock("./just-bash-builds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./just-bash-builds.js")>();
  return { ...actual, justBashNodeExport: () => undefined, hasJustBashNodeBuild: () => false };
});

describe("on just-bash's browser build (workerd)", () => {
  it("leaves the commands it cannot run out of Tier 0, and cannot clear a script", () => {
    const commands = tier0CapabilityMatrix().commands;
    expect(commands.get("cat")).toBe("always");
    for (const name of ["python3", "python", "node", "js-exec", "sqlite3", "tar", "yq", "xan"]) {
      expect(commands.has(name)).toBe(false);
    }
    expect(classifyCommand("cat a.txt").reasons).toContainEqual(
      expect.objectContaining({ kind: "classifier-unavailable" }),
    );
  });

  it("runs bash over a filesystem with Python and JavaScript off, and says so in the system hints", async () => {
    const host = virtualHost({ fs: new InMemoryFs() });
    const session = await host.sessions.getOrCreate({ id: "chat" });
    const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
    const sandbox = await prepared.createSandbox({});
    const shell = sandbox.shellTool() as any;

    expect(sandbox.systemHints().join("\n")).toContain("python3, node (js-exec), sqlite3, tar, yq and xan are not available");
    expect(await shell.execute({ command: "echo hi | tr a-z A-Z" }, {})).toMatchObject({ exitCode: 0, stdout: "HI\n" });
    expect((await shell.execute({ command: "python3 -c 'print(1)'" }, {})).exitCode).toBe(127);
  });

  it("writes and recalls memory through a new virtual host without the Node build", async () => {
    const fs = new InMemoryFs();
    const turn = async (command: string) => {
      let called = false;
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          const content = called
            ? [{ type: "text" as const, text: JSON.stringify(prompt.filter((message) => message.role === "tool")) }]
            : [{ type: "tool-call" as const, toolCallId: "memory", toolName: "bash", input: JSON.stringify({ command }) }];
          const finishReason = called ? "stop" as const : "tool-calls" as const;
          called = true;
          return {
            content,
            finishReason: { unified: finishReason, raw: finishReason },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        },
      });
      return generateHarness({
        harness: createHarness({ host: virtualHost({ fs }), model, memory: { sourceDir: "memory", skill: false } }),
        session: "chat",
        prompt: "Use memory.",
      });
    };

    expect((await turn("echo browser-saved-fact > /persistent/memory/fact.md")).status).toBe("completed");
    expect(await fs.readFile("/.little-harness/data/memory/fact.md")).toBe("browser-saved-fact\n");
    await fs.rm("/persistent/memory", { recursive: true, force: true });
    const recalled = await turn("cat /persistent/memory/fact.md");
    expect(recalled.status).toBe("completed");
    if (recalled.status !== "completed") throw new Error(`Memory recall ended ${recalled.status}.`);
    expect(recalled.text).toContain("browser-saved-fact");
  });

  it("refuses a workspace on disk", async () => {
    const createSandbox = justBashSandbox();
    await expect(
      createSandbox({
        workspace: {
          sessionId: "chat",
          workingDir: "/session",
          mounts: [{ mountPath: "/session", backingPath: "/tmp/chat", mode: "rw" }],
        },
        files: (await virtualHost().sessions.getOrCreate({ id: "chat" })).files,
      }),
    ).rejects.toBeInstanceOf(HarnessInputError);
  });
});
