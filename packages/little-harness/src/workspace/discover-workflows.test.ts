import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverWorkflows } from "./discover-workflows.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lh-workflows-"));
  dirs.push(dir);
  return dir;
}

it("imports workflows from agent workflows folder", async () => {
  const dir = await agentDir();
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "workflows", "candidate.ts"), `
    export default {
      id: "candidate.review",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
      async runForHarness() {
        return { protocolVersion: 1, status: "completed", runId: "run_x", output: "ok" };
      },
    };
  `);

  const workflows = await discoverWorkflows(dir);
  expect(workflows.map((workflow) => workflow.id)).toEqual(["candidate.review"]);
});

it("rejects discovered workflows without definition identity", async () => {
  const dir = await agentDir();
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "workflows", "candidate.ts"), `
    export default {
      id: "candidate.review",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      executionMode: "inline",
      async runForHarness() {
        return { protocolVersion: 1, status: "completed", runId: "run_x", output: "ok" };
      },
    };
  `);

  await expect(discoverWorkflows(dir)).rejects.toThrow(/definition identity/i);
});

