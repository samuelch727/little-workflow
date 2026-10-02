import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../cli-core.js";
import { discoverTools, loadWorkspace } from "../workspace/index.js";
import { initWorkspace } from "./agent-scaffold.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "lh-e2e-"));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(d, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  dirs.push(d);
  return d;
}

it("init -> loadWorkspace finds the agent -> its echo tool is discoverable", async () => {
  const root = await tmp();
  await initWorkspace(root);
  const { agents } = await loadWorkspace(root);
  expect(agents.map((a) => a.name)).toContain("support");
  const support = agents.find((a) => a.name === "support")!;
  const tools = await discoverTools(support.dir);
  expect(Object.keys(tools)).toContain("echo");
});

it("runCli dispatches `new` and scaffolds the agent", async () => {
  const root = await tmp();
  const code = await runCli(["new", "billing"], { cwd: root, stdout: () => {} });
  expect(code).toBe(0);
  const { agents } = await loadWorkspace(root);
  expect(agents.map((a) => a.name)).toContain("billing");
});

it("runCli dispatches `init` with flags and creates a runnable project", async () => {
  const root = await tmp();
  const code = await runCli([
    "init",
    "support-agents",
    "--provider",
    "openai",
    "--model",
    "gpt-5.2",
    "--yes",
    "--no-install",
  ], { cwd: root, stdout: () => {} });
  expect(code).toBe(0);
  const { agents } = await loadWorkspace(join(root, "support-agents"));
  expect(agents.map((a) => a.name)).toContain("support");
});

it("runCli --help lists the agent commands", async () => {
  let out = "";
  await runCli(["--help"], { stdout: (t) => { out += t; } });
  for (const cmd of ["init [name]", "new <name>", "test <name>", "connectors <name>"]) expect(out).toContain(cmd);
});
