import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryFs } from "just-bash";
import { compileHarnessFolder, compileHarnessWorkspace } from "../compiler.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { resolveSkills } from "../skills/skill.js";
import { loadHarness } from "./load-harness.js";
import { importDefault } from "./module-loader.js";
import type { Harness, HarnessHost } from "../types.js";
vi.setConfig({ testTimeout: 90_000 });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-compiler-")); dirs.push(root);
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  const dir = join(root, "agents", "support");
  await mkdir(join(dir, "tools"), { recursive: true });
  await writeFile(join(dir, "agent.ts"), `import { createHarness } from "@little-stack/harness";
export default (host) => { let n = 0; return createHarness({ host, model: {}, tools: { ping: { description: "inline wins", execute: async () => ++n } } }); };`);
  await writeFile(join(dir, "tools/ping.ts"), 'export default { description: "discovered", execute: async () => 99 };');
  await writeFile(join(dir, "tools/other.cjs"), 'module.exports = { description: "cjs tool" };');
  await writeFile(join(dir, "tools/ignored.test.ts"), 'throw new Error("not a tool");');
  await writeFile(join(dir, "instructions.md"), "  folder instructions\n");
  const skills = join(dir, "skills", "guide");
  await mkdir(join(skills, "assets"), { recursive: true });
  await writeFile(join(skills, "SKILL.md"), '---\nname: guide\ndescription: "Offline guide"\n---\nHello');
  await writeFile(join(skills, "assets/bytes.bin"), new Uint8Array([0, 255, 128, 3]));
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "workflows/review.ts"), `export default { id: "review", inputSchema: { kind: "untyped", allowUntypedInput: true }, executionMode: "inline", definitionIdentity: "test:review", runForHarness: async () => ({ status: "completed" }) };`);
  return { root, dir, moduleDir: root };
}
function host() { return virtualHost({ fs: new InMemoryFs() }); }
async function compiled(dir: string, moduleDir: string) {
  const source = await compileHarnessFolder(dir, { moduleDir });
  const path = join(moduleDir, "generated.ts"); await writeFile(path, source);
  return importDefault<(options: { host: HarnessHost }) => Promise<Harness>>(path);
}
it("Node and compiled loaders preserve tools, instructions, workflows and byte-exact skill assets", async () => {
  const { dir, moduleDir } = await fixture();
  const node = await loadHarness(dir, { host: host() });
  const built = await (await compiled(dir, moduleDir))({ host: host() });
  expect(built.config.system).toBe(node.config.system);
  expect(Object.keys(built.config.tools)).toEqual(Object.keys(node.config.tools));
  expect(built.config.tools.ping?.description).toBe("inline wins");
  expect(built.config.workflows?.map(w => w.id)).toEqual(node.config.workflows?.map(w => w.id));
  const canonical = async (h: Harness) => (await resolveSkills(h.config.skills)).map(s => ({
    ...s, files: Object.fromEntries(Object.entries(s.files).map(([name, bytes]) => [name, Array.from(bytes)])),
  }));
  expect(await canonical(built)).toEqual(await canonical(node));
});
it("factories create independent closures and inject both config.host and sessions for each chat", async () => {
  const { dir, moduleDir } = await fixture(); const create = await compiled(dir, moduleDir);
  const aHost = host(), bHost = host();
  const [a, b] = await Promise.all([create({ host: aHost }), create({ host: bHost })]);
  expect(a.config.host).toBe(aHost); expect(a.sessions).toBe(aHost.sessions); expect(b.sessions).toBe(bHost.sessions);
  const run = (h: Harness) => h.config.tools.ping!.execute!({} as never, {} as never);
  expect(await run(a)).toBe(1); expect(await run(a)).toBe(2); expect(await run(b)).toBe(1);
  await expect(create({} as never)).rejects.toThrow(/per-chat host/);
  expect((await loadHarness(dir, { dataDir: join(moduleDir, "node-data") })).config.host.kind).toBe("local");
});
it("compilation reads modules without executing them and uses deterministic relative imports", async () => {
  const { dir, moduleDir } = await fixture();
  await writeFile(join(dir, "agent.ts"), 'throw new Error("must not execute during build"); export default {};');
  const a = await compileHarnessFolder(dir, { moduleDir });
  expect(await compileHarnessFolder(dir, { moduleDir })).toBe(a);
  expect(a).toContain('from "./agents/support/agent.ts"');
  expect(a).not.toMatch(/node:|import\(|jiti|ignored\.test/);
});
it("workspace compilation uses marker, sorted immediate folders, and safely handles unknown names", async () => {
  const { root, dir } = await fixture();
  await writeFile(join(root, "little-harness.json"), '{"agents":"agents"}');
  await mkdir(join(root, "agents/empty"));
  const source = await compileHarnessWorkspace(root, { moduleDir: root });
  expect(source).toContain('Object.freeze(["support"])');
  await writeFile(join(root, "registry.ts"), source + '\nexport default loadHarness;');
  const load = await importDefault<(name: string, options: { host: HarnessHost }) => Promise<Harness>>(join(root, "registry.ts"));
  expect((await load("support", { host: host() })).config.system).toBe("folder instructions");
  await expect(load("__proto__", { host: host() })).rejects.toThrow(/Unknown compiled agent/);
  expect(dir).toContain("support");
});
it.each(["bash", "constructor", "my.tool"])("refuses reserved/invalid discovered tool %s", async name => {
  const { dir, moduleDir } = await fixture(); await writeFile(join(dir, `tools/${name}.ts`), "export default {};");
  await expect(compileHarnessFolder(dir, { moduleDir })).rejects.toThrow(/reserved or invalid/);
});
it("refuses symlinks and oversized skills instead of leaking or truncating assets", async () => {
  const { dir, moduleDir } = await fixture();
  await expect(compileHarnessFolder(dir, { moduleDir, maxSkillBytes: 1 })).rejects.toThrow(/maxSkillBytes/);
  await symlink(join(dir, "instructions.md"), join(dir, "skills/guide/link"));
  await expect(compileHarnessFolder(dir, { moduleDir })).rejects.toThrow(/symlink/);
});
it("inline system wins and skill modules win over SKILL.md; disk/git skills fail clearly", async () => {
  const { dir, moduleDir } = await fixture();
  const agent = await readFile(join(dir, "agent.ts"), "utf8");
  await writeFile(join(dir, "agent.ts"), agent.replace('model: {},', 'model: {}, system: "inline",'));
  await writeFile(join(dir, "skills/guide/skill.ts"), 'export default { name: "module", description: "module wins", files: { "SKILL.md": "module" } };');
  const h = await (await compiled(dir, moduleDir))({ host: host() });
  expect(h.config.system).toBe("inline"); expect(h.config.skills[0]).toMatchObject({ name: "module" });
  const fresh = await fixture();
  await writeFile(join(fresh.dir, "skills/guide/skill.ts"), 'export default "./disk-only";');
  const create = await compiled(fresh.dir, fresh.moduleDir);
  await expect(create({ host: host() })).rejects.toThrow(/inline skill files/);
});

it("legacy Harness exports rebind host and sessions, including promised discovered tools", async () => {
  const { dir, moduleDir } = await fixture();
  await writeFile(join(dir, "agent.ts"), `import { createHarness, virtualHost } from "@little-stack/harness";
import { InMemoryFs } from "just-bash";
export default createHarness({ host: virtualHost({ fs: new InMemoryFs() }), model: {} });`);
  await writeFile(join(dir, "tools/ping.ts"), 'export default Promise.resolve({ description: "promised", execute: async () => "pong" });');
  const nodeHost = host(), builtHost = host();
  const node = await loadHarness(dir, { host: nodeHost });
  const built = await (await compiled(dir, moduleDir))({ host: builtHost });
  expect(node.sessions).toBe(nodeHost.sessions); expect(built.sessions).toBe(builtHost.sessions);
  expect(built.config.tools.ping?.description).toBe(node.config.tools.ping?.description);
  expect(await built.config.tools.ping!.execute!({} as never, {} as never)).toBe("pong");
});
it("the compiled path retains Node workflow/tool collision checks", async () => {
  const { dir, moduleDir } = await fixture();
  await writeFile(join(dir, "tools/review.ts"), 'export default { description: "collides" };');
  await expect(loadHarness(dir, { host: host() })).rejects.toThrow(/collid|collision/i);
  const create = await compiled(dir, moduleDir);
  await expect(create({ host: host() })).rejects.toThrow(/collid|collision/i);
});

it("factory folders run through the default Node server and schedules command with their data dir", async () => {
  const { root, dir } = await fixture();
  const { startAgentServer } = await import("../server/agent-server.js");
  const { schedulesCommand } = await import("../cli/serve-commands.js");
  const dataDir = join(root, "server-data");
  const server = await startAgentServer({ agentDir: dir, agentName: "support", dataDir, port: 0, log: () => undefined });
  try { expect(server.harness.config.host.dataDir).toBe(dataDir); }
  finally { await server.close(); }
  const output: string[] = [];
  expect(await schedulesCommand(["support"], "schedule-data", { cwd: root, stdout: text => { output.push(text); } })).toBe(0);
  expect(output.join("")).toContain("No schedules");
  expect((await loadHarness(dir)).config.host.kind).toBe("local");
});
it("CRLF/BOM metadata matches Node and compiled assets without changing their bytes", async () => {
  const { dir, moduleDir } = await fixture();
  const skill = join(dir, "skills/guide/SKILL.md");
  await writeFile(skill, '\uFEFF---\r\nname: guide\r\ndescription: "Windows guide"\r\n---\r\nHello\r\n');
  const node = await loadHarness(dir, { host: host() });
  const built = await (await compiled(dir, moduleDir))({ host: host() });
  expect((await resolveSkills(node.config.skills))[0]!.description).toBe("Windows guide");
  expect((await resolveSkills(built.config.skills))[0]!.description).toBe("Windows guide");
  expect(Array.from((await resolveSkills(built.config.skills))[0]!.files["SKILL.md"]!)).toEqual(Array.from(await readFile(skill)));
});
it("uses shared code-unit discovery and copies cached asset bytes per chat", async () => {
  const { dir, moduleDir } = await fixture();
  await mkdir(join(dir, "skills/Guide"));
  await writeFile(join(dir, "skills/Guide/SKILL.md"), '---\nname: upper\ndescription: Upper\n---');
  const node = await loadHarness(dir, { host: host() });
  const create = await compiled(dir, moduleDir);
  const a = await create({ host: host() }), b = await create({ host: host() });
  expect((await resolveSkills(a.config.skills)).map(s => s.name)).toEqual((await resolveSkills(node.config.skills)).map(s => s.name));
  expect((await resolveSkills(a.config.skills)).map(s => s.name)).toEqual(["upper", "guide"]);
  const first = a.config.skills[1] as { files: Record<string, Uint8Array> };
  first.files["assets/bytes.bin"]![0] = 99;
  expect((b.config.skills[1] as { files: Record<string, Uint8Array> }).files["assets/bytes.bin"]![0]).toBe(0);
});
it("emits only the required runtime imports for workflow-free and empty workspaces", async () => {
  const { dir, moduleDir } = await fixture();
  await rm(join(dir, "workflows"), { recursive: true });
  expect(await compileHarnessFolder(dir, { moduleDir })).not.toContain("validateDiscoveredWorkflow");
  const empty = await compileHarnessWorkspace(join(moduleDir, "empty"), { moduleDir });
  expect(empty).not.toContain("assembleHarness"); expect(empty).not.toContain("instantiateHarness");
});

it("repeated factory loads share the resolved data-dir host and session queue", async () => {
  const { dir, root } = await fixture(); const dataDir = join(root, "shared-host");
  const [a, b] = await Promise.all([loadHarness(dir, { dataDir }), loadHarness(dir, { dataDir: `${root}/nested/../shared-host` })]);
  expect(a.config.host).toBe(b.config.host); expect(a.sessions).toBe(b.sessions);
  expect((await loadHarness(dir, { dataDir: join(root, "different-host") })).config.host).not.toBe(a.config.host);
  const explicit = host(); expect((await loadHarness(dir, { dataDir, host: explicit })).config.host).toBe(explicit);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const session = await a.sessions.getOrCreate({ id: "same-session" });
  const first = a.config.host.runExclusive(session, { turnId: "a" }, async () => { order.push("a-start"); entered(); await gate; order.push("a-end"); });
  await started;
  const second = b.config.host.runExclusive(session, { turnId: "b" }, async () => { order.push("b-start"); });
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(order).toEqual(["a-start"]); }
  finally { release(); await Promise.allSettled([first, second]); }
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});
