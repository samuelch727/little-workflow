import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverSkills } from "./discover-skills.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function agentDir() {
  const d = await mkdtemp(join(tmpdir(), "lh-skills-"));
  dirs.push(d);
  return d;
}

it("discovers local SKILL.md and declared skill.ts skills", async () => {
  const d = await agentDir();
  await mkdir(join(d, "skills", "refund-policy"), { recursive: true });
  await writeFile(
    join(d, "skills", "refund-policy", "SKILL.md"),
    "---\nname: refund-policy\ndescription: Use for refunds.\n---\nbody\n",
  );
  await mkdir(join(d, "skills", "frontend"), { recursive: true });
  await writeFile(join(d, "skills", "frontend", "skill.ts"), `export default "https://github.com/org/repo";\n`);
  const skills = await discoverSkills(d);
  expect(skills).toHaveLength(2);
  // skill.ts default export flows straight through:
  expect(skills).toContain("https://github.com/org/repo");
});

it("prefers skill.ts over SKILL.md in the same folder", async () => {
  const d = await agentDir();
  await mkdir(join(d, "skills", "x"), { recursive: true });
  await writeFile(join(d, "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
  await writeFile(join(d, "skills", "x", "skill.ts"), `export default "https://github.com/org/x";\n`);
  expect(await discoverSkills(d)).toEqual(["https://github.com/org/x"]);
});

it("returns [] when there is no skills/ dir", async () => {
  expect(await discoverSkills(await agentDir())).toEqual([]);
});
