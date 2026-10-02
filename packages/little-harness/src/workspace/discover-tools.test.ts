import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverTools } from "./discover-tools.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function agentDir() {
  const d = await mkdtemp(join(tmpdir(), "lh-tools-"));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(d, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  dirs.push(d);
  return d;
}

const toolSrc = (name: string) =>
  `import { tool } from "ai";\nimport { z } from "zod";\n` +
  `export default tool({ description: "${name}", inputSchema: z.object({}), execute: async () => "${name}" });\n`;

it("discovers tools/*.ts keyed by filename", async () => {
  const d = await agentDir();
  await mkdir(join(d, "tools"), { recursive: true });
  await writeFile(join(d, "tools", "lookup_order.ts"), toolSrc("lookup_order"));
  await writeFile(join(d, "tools", "issue_refund.ts"), toolSrc("issue_refund"));
  await writeFile(join(d, "tools", "helper.test.ts"), toolSrc("nope"));
  const tools = await discoverTools(d);
  expect(Object.keys(tools).sort()).toEqual(["issue_refund", "lookup_order"]);
});

it("returns {} when there is no tools/ dir", async () => {
  expect(await discoverTools(await agentDir())).toEqual({});
});
