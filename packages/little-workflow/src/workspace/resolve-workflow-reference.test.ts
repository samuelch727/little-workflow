import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveWorkflowReference } from "./resolve-workflow-reference.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lw-ref-"));
  dirs.push(dir);
  return dir;
}

it("resolves an existing direct workflow folder", async () => {
  const root = await tmp();
  const workflowDir = join(root, "workflows", "candidate-review");
  await mkdir(workflowDir, { recursive: true });

  await expect(resolveWorkflowReference(workflowDir, { cwd: root }))
    .resolves.toEqual({ folder: workflowDir });
});

it("resolves a named workflow from the nearest little-workflow.json", async () => {
  const root = await tmp();
  const workflowDir = join(root, "workflows", "candidate-review");
  const child = join(root, "nested");
  await mkdir(workflowDir, { recursive: true });
  await mkdir(child, { recursive: true });
  await writeFile(join(root, "little-workflow.json"), `${JSON.stringify({
    workflows: { "candidate-review": "./workflows/candidate-review" },
  })}\n`);

  await expect(resolveWorkflowReference("candidate-review", { cwd: child }))
    .resolves.toEqual({ folder: workflowDir });
});

it("rejects unknown workflow names", async () => {
  const root = await tmp();
  await writeFile(join(root, "little-workflow.json"), `${JSON.stringify({ workflows: {} })}\n`);

  await expect(resolveWorkflowReference("missing", { cwd: root })).rejects.toThrow(/unknown workflow/i);
});

it("rejects manifest workflow paths that escape the manifest root", async () => {
  const root = await tmp();
  const outside = join(root, "..", "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "little-workflow.json"), `${JSON.stringify({
    workflows: { bad: "../outside" },
  })}\n`);

  await expect(resolveWorkflowReference("bad", { cwd: root })).rejects.toThrow(/escapes/i);
});
