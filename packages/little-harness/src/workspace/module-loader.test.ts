import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importDefault } from "./module-loader.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "lh-modload-"));
  dirs.push(d);
  return d;
}

it("imports the default export of a TypeScript module", async () => {
  const d = await tmp();
  await writeFile(join(d, "m.ts"), `export default { value: 42 as number };\n`);
  expect(await importDefault<{ value: number }>(join(d, "m.ts"))).toEqual({ value: 42 });
});

it("throws when the module has no default export", async () => {
  const d = await tmp();
  await writeFile(join(d, "m.ts"), `export const x = 1;\n`);
  await expect(importDefault(join(d, "m.ts"))).rejects.toThrow(/default export/i);
});
