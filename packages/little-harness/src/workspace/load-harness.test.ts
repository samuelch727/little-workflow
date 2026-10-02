import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadHarness, loadWorkspace } from "./index.js";

// loadHarness compiles TS agent/tool modules via jiti; the FIRST test in this file pays the
// cold module-loader warm-up, which exceeds vitest's 30s default on loaded CI runners (the
// suite has seen 30s+ here while local runs take <1s). Generous file-level budget instead of
// guessing which test runs first.
vi.setConfig({ testTimeout: 90_000 });

const here = import.meta.dirname;
const createHarnessPath = resolve(here, "../create-harness.ts");
const localHostPath = resolve(here, "../local-host/index.ts");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "lh-load-"));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(d, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  dirs.push(d);
  return d;
}

const AGENT_TS = (system: string | null) =>
  `import { createHarness } from ${JSON.stringify(createHarnessPath)};\n` +
  `import { localHost } from ${JSON.stringify(localHostPath)};\n` +
  `const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;\n` +
  `export default createHarness({ host: localHost(), model${system === null ? "" : `, system: ${JSON.stringify(system)}`} });\n`;

const TOOL_TS =
  `import { tool } from "ai";\nimport { z } from "zod";\n` +
  `export default tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" });\n`;

it("merges discovered tools and applies the instructions.md fallback", async () => {
  const agent = join(await tmp(), "agents", "support");
  await mkdir(join(agent, "tools"), { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS(null));
  await writeFile(join(agent, "instructions.md"), "You are support.");
  await writeFile(join(agent, "tools", "ping.ts"), TOOL_TS);
  const harness = await loadHarness(agent);
  expect(Object.keys(harness.config.tools)).toContain("ping");
  expect(harness.config.system).toBe("You are support.");
});

it("merges discovered workflows", async () => {
  const agent = join(await tmp(), "agents", "support");
  await mkdir(join(agent, "workflows"), { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS(null));
  await writeFile(join(agent, "workflows", "candidate.ts"), `
    export default {
      id: "candidate.review",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
      async runForHarness(_input, ctx) {
        return { protocolVersion: 1, status: "completed", runId: ctx.reservedRunId, output: "ok" };
      },
    };
  `);

  const harness = await loadHarness(agent);

  expect(harness.config.workflows?.map((workflow) => workflow.id)).toEqual(["candidate.review"]);
});

it("rejects discovered tool names that use the generated workflow launcher prefix", async () => {
  const agent = join(await tmp(), "agents", "support");
  await mkdir(join(agent, "tools"), { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS(null));
  await writeFile(join(agent, "tools", "start_candidate_review.ts"), TOOL_TS);

  await expect(loadHarness(agent)).rejects.toThrow(/reserved start_/i);
});

it("rejects a discovered tool whose name collides with the reserved runtime bash tool", async () => {
  const agent = join(await tmp(), "agents", "support");
  await mkdir(join(agent, "tools"), { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS(null));
  // A discovered `tools/bash.ts` would otherwise be silently overwritten by the runtime shell
  // tool during object spread at turn assembly, masking the author's tool. createHarness rejects
  // a configured `bash` tool, so the folder-discovery path must reject it too.
  await writeFile(join(agent, "tools", "bash.ts"), TOOL_TS);

  await expect(loadHarness(agent)).rejects.toThrow(/reserved/i);
});

it("rejects a discovered tool whose name is not a valid model-tool identifier", async () => {
  const agent = join(await tmp(), "agents", "support");
  await mkdir(join(agent, "tools"), { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS(null));
  // `tools/my.tool.ts` yields the stem `my.tool` (path.parse keeps the internal dot), which is not
  // a valid model-tool id. createHarness rejects such inline names via HARNESS_TOOL_NAME, so the
  // folder-discovery path must too — failing fast at load instead of late at the provider.
  await writeFile(join(agent, "tools", "my.tool.ts"), TOOL_TS);

  await expect(loadHarness(agent)).rejects.toThrow(/reserved or invalid/i);
});

it("agent.ts system wins over instructions.md", async () => {
  const agent = join(await tmp(), "agents", "s");
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "agent.ts"), AGENT_TS("inline-system"));
  await writeFile(join(agent, "instructions.md"), "file-system");
  expect((await loadHarness(agent)).config.system).toBe("inline-system");
});

it("loadWorkspace enumerates agents that have an agent.ts", async () => {
  const ws = await tmp();
  await writeFile(join(ws, "little-harness.json"), `{ "agents": "agents" }`);
  for (const n of ["support", "triage"]) {
    await mkdir(join(ws, "agents", n), { recursive: true });
    await writeFile(join(ws, "agents", n, "agent.ts"), AGENT_TS(null));
  }
  await mkdir(join(ws, "agents", "not-an-agent"), { recursive: true });
  const { agents } = await loadWorkspace(ws);
  expect(agents.map((a) => a.name).sort()).toEqual(["support", "triage"]);
});
