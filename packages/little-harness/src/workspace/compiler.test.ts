import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryFs } from "just-bash";
import { compileHarnessFolder, compileHarnessWorkspace } from "../compiler.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { resolveSkills } from "../skills/skill.js";
import { loadHarness } from "./load-harness.js";
import { importDefault } from "./module-loader.js";
import type { CompiledHarnessOptions } from "../compiled.js";
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
async function compiled<TContext = unknown>(dir: string, moduleDir: string) {
  const source = await compileHarnessFolder(dir, { moduleDir });
  const path = join(moduleDir, "generated.ts"); await writeFile(path, source);
  return importDefault<(options: CompiledHarnessOptions<TContext>) => Promise<Harness>>(path);
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
  // Uppercase Z sorts before lowercase g by code unit, after it by locale.
  // Distinct spellings also work on case-insensitive filesystems.
  await mkdir(join(dir, "skills/Z-guide"));
  await writeFile(join(dir, "skills/Z-guide/SKILL.md"), '---\nname: upper\ndescription: Upper\n---');
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


it("forwards live construction context by reference through Node, folder and workspace loaders", async () => {
  const { dir, moduleDir, root } = await fixture();
  await writeFile(join(dir, "agent.ts"), `import { createHarness } from "@little-stack/harness";
export default async (host, context) => {
  await Promise.resolve();
  let count = 0;
  context.onConstruct(context);
  return createHarness({ host, model: {}, onEvent: context.onEvent, tools: {
    instance: { execute: async () => { const result = { id: context.chatSessionId, count: ++count }; await context.onResult(result); return result; } }
  } });
};`);
  // A callable tool VALUE must never be mistaken for a discovered factory.
  await writeFile(join(dir, "tools/callable.ts"), `export default Object.assign(() => { throw new Error("must not invoke discovered exports"); }, { description: "callable value", execute: async () => "static" });`);
  const source = await compileHarnessWorkspace(root, { moduleDir });
  await writeFile(join(root, "registry.ts"), source + "\nexport default loadHarness;");
  type Context = { chatSessionId: string; onConstruct: (value: unknown) => void; onResult: (value: unknown) => Promise<void>; onEvent: () => void };
  const workspace = await importDefault<(name: string, options: CompiledHarnessOptions<Context>) => Promise<Harness>>(join(root, "registry.ts"));
  const create = await compiled<Context>(dir, moduleDir);
  for (const load of [(options: CompiledHarnessOptions<Context>) => loadHarness(dir, options), create, (options: CompiledHarnessOptions<Context>) => workspace("support", options)]) {
    const resultsA: unknown[] = [], resultsB: unknown[] = [];
    function context(id: string, results: unknown[]): Context {
      const value = { chatSessionId: id, onConstruct: vi.fn(), onResult: async (result: unknown) => { results.push(result); }, onEvent: vi.fn() };
      Object.defineProperty(value, "toJSON", { value: () => { throw new Error("must not serialize context"); } });
      Object.defineProperty(value, "privateBinding", { enumerable: true, get: () => { throw new Error("must not spread/read context"); } });
      return value;
    }
    const aContext = context("a", resultsA), bContext = context("b", resultsB);
    const aHost = host(), bHost = host();
    const [a, b] = await Promise.all([load({ host: aHost, context: aContext }), load({ host: bHost, context: bContext })]);
    expect(aContext.onConstruct).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aContext.onConstruct).mock.calls[0]![0]).toBe(aContext);
    expect(bContext.onConstruct).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bContext.onConstruct).mock.calls[0]![0]).toBe(bContext);
    expect(a.config.onEvent).toBe(aContext.onEvent); expect(b.config.onEvent).toBe(bContext.onEvent);
    expect(a.config.host).toBe(aHost); expect(b.config.host).toBe(bHost);
    expect(a.config).not.toHaveProperty("context"); expect(aHost).not.toHaveProperty("context");
    const run = (h: Harness) => h.config.tools.instance!.execute!({} as never, {} as never);
    expect(await run(a)).toEqual({ id: "a", count: 1 });
    expect(await run(b)).toEqual({ id: "b", count: 1 });
    expect(await run(a)).toEqual({ id: "a", count: 2 });
    expect(resultsA).toEqual([{ id: "a", count: 1 }, { id: "a", count: 2 }]);
    expect(resultsB).toEqual([{ id: "b", count: 1 }]);
    expect(typeof a.config.tools.callable).toBe("function");
    expect(await a.config.tools.callable!.execute!({} as never, {} as never)).toBe("static");
  }
});

it("generated folder/workspace loaders infer required context and preserve legacy TypeScript calls", async () => {
  const { dir, root } = await fixture();
  await rm(join(dir, "tools"), { recursive: true });
  await rm(join(dir, "workflows"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await rm(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@little-stack"), { recursive: true });
  await symlink(process.cwd(), join(root, "node_modules/@little-stack/harness"));
  await symlink(join(process.cwd(), "node_modules/@types"), join(root, "node_modules/@types"));
  await writeFile(join(dir, "agent.ts"), `import { createHarness, type HarnessHost } from "@little-stack/harness";
export default async (host: HarnessHost, context: { chatSessionId: string; onResult: () => void }) => createHarness({ host, model: {} as never, tools: {} });`);
  const legacy = join(root, "agents/legacy"); await mkdir(legacy);
  await writeFile(join(legacy, "agent.ts"), `import { createHarness, type HarnessHost } from "@little-stack/harness";
export default (host: HarnessHost) => createHarness({ host, model: {} as never });`);
  await writeFile(join(root, "generated.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  await writeFile(join(root, "workspace.ts"), await compileHarnessWorkspace(root, { moduleDir: root }));
  const path = join(root, "typecheck.ts");
  await writeFile(path, `import create from "./generated.js";
import { loadHarness } from "./workspace.js";
import { loadHarness as nodeLoad, type HarnessHost } from "@little-stack/harness";
import { instantiateHarness, type HarnessDefinition, type HarnessContext, type CompiledHarnessOptions } from "@little-stack/harness/compiled";
declare const host: HarnessHost;
type Context = { chatSessionId: string; onResult: () => void };
const context: Context = { chatSessionId: "chat", onResult: () => {} };
create({ host, context });
loadHarness("support", { host, context });
loadHarness("legacy", { host });
nodeLoad<Context>("agents/support", { host, context });
// @ts-expect-error typed Node context required
nodeLoad<Context>("agents/support", { host });
// @ts-expect-error required factory context omitted
create({ host });
// @ts-expect-error wrong factory context
create({ host, context: { chatSessionId: 123 } });
// @ts-expect-error required workspace factory context omitted
loadHarness("support", { host });
// @ts-expect-error wrong workspace context
loadHarness("support", { host, context: { chatSessionId: 123 } });
const legacyOptions: CompiledHarnessOptions = { host };
declare const legacyDefinition: HarnessDefinition;
instantiateHarness(legacyDefinition, host);
const typedOptions: CompiledHarnessOptions<Context> = { host, context };
declare const typedDefinition: HarnessDefinition<Context>;
instantiateHarness(typedDefinition, host, context);
declare const optionalDefinition: HarnessDefinition<Context | undefined>;
instantiateHarness(optionalDefinition, host);
instantiateHarness(optionalDefinition, host, undefined);
instantiateHarness(optionalDefinition, host, context);
// @ts-expect-error optional contracts still reject malformed supplied context
instantiateHarness(optionalDefinition, host, { chatSessionId: 123 });
// @ts-expect-error context required for typed helper
instantiateHarness(typedDefinition, host);
// @ts-expect-error context required for typed options
const missing: CompiledHarnessOptions<Context> = { host };
// Untyped exports stay permissive without recursive inference failures.
const untypedContext: HarnessContext<any> = 123;
const untypedOptions: CompiledHarnessOptions<HarnessContext<any>> = { host };
type Harness = import("@little-stack/harness").Harness;
const valueOptions: CompiledHarnessOptions<HarnessContext<Harness>> = { host };
declare function genericFactory<T extends Context>(host: HarnessHost, context: T): Harness;
const genericOptions: CompiledHarnessOptions<HarnessContext<typeof genericFactory>> = { host, context };
// @ts-expect-error generic context constraint remains checked
const wrongGeneric: CompiledHarnessOptions<HarnessContext<typeof genericFactory>> = { host, context: { chatSessionId: 123 } };
declare function genericOptionalHost<T extends Context>(host?: HarnessHost, context?: T): Harness;
const optionalGeneric: CompiledHarnessOptions<HarnessContext<typeof genericOptionalHost>> = { host, context };
const omittedGeneric: CompiledHarnessOptions<HarnessContext<typeof genericOptionalHost>> = { host };
// @ts-expect-error optional generic constraints remain checked
const wrongOptionalGeneric: CompiledHarnessOptions<HarnessContext<typeof genericOptionalHost>> = { host, context: { chatSessionId: 123 } };
type EitherFactory = ((host: HarnessHost, context: Context) => Harness) | ((host: HarnessHost, context: { auditId: string }) => Harness);
const eitherOptions: CompiledHarnessOptions<HarnessContext<EitherFactory>> = { host, context: { ...context, auditId: "audit" } };
// @ts-expect-error a factory union needs context valid for either runtime selection
const wrongEither: CompiledHarnessOptions<HarnessContext<EitherFactory>> = { host, context };
`);
  const program = ts.createProgram([path], { noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" })).toBe("");
});


// An explicit application contract adapts supplied-context inference while the
// original export remains available for released raw host-only call checks.
async function declaredFixture(root: string, context: string, body: string) {
  const dir = join(root, "agents/declared");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent.ts"), `import type { HarnessDefinition } from "@little-stack/harness/compiled";
import source from "../support/agent.js";
type Context = { chatSessionId: string; onResult: () => void };
async function declared(): Promise<HarnessDefinition<${context}>> {
  const definition = await source;
  return (host, context) => { ${body} };
}
export default declared();`);
  await writeFile(join(root, "declared.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  return dir;
}

it.each([
  ["HarnessDefinition union", `function definition(): HarnessDefinition<Context> { return (host, context) => make(host); }\nexport default definition();`, true],
  ["promised HarnessDefinition union", `function definition(): HarnessDefinition<Context> { return (host, context) => make(host); }\nexport default Promise.resolve(definition());`, true],
  ["promised factory", `export default Promise.resolve((host: HarnessHost, context: Context) => make(host));`, true],
  ["host-first overload", `function definition(host: HarnessHost): Harness;\nfunction definition(host: HarnessHost, context: Context): Harness;\nfunction definition(host: HarnessHost, context?: Context) { return make(host); }\nexport default definition;`, false],
  ["context-first overload", `function definition(host: HarnessHost, context: Context): Harness;\nfunction definition(host: HarnessHost): Harness;\nfunction definition(host: HarnessHost, context?: Context) { return make(host); }\nexport default definition;`, false],
] as const)("wrapped factories and explicit overload contracts retain their generated contract: %s", async (name, definition, required) => {
  const { dir, root } = await fixture();
  await rm(join(dir, "tools"), { recursive: true });
  await rm(join(dir, "workflows"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await rm(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@little-stack"), { recursive: true });
  await symlink(process.cwd(), join(root, "node_modules/@little-stack/harness"));
  await symlink(join(process.cwd(), "node_modules/@types"), join(root, "node_modules/@types"));
  await writeFile(join(dir, "agent.ts"), `import { createHarness, type Harness, type HarnessHost } from "@little-stack/harness";
import type { HarnessDefinition } from "@little-stack/harness/compiled";
type Context = { chatSessionId: string; onResult: () => void };
const make = (host: HarnessHost) => createHarness({ host, model: {} as never });
${definition}`);
  const overloaded = name.includes("overload");
  if (overloaded) await declaredFixture(root, "Context | undefined", "if (context === undefined) return definition(host); return definition(host, context);");
  await writeFile(join(root, "generated.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  await writeFile(join(root, "workspace.ts"), await compileHarnessWorkspace(root, { moduleDir: root }));
  const path = join(root, "typecheck.ts");
  await writeFile(path, `import create from "./${overloaded ? "declared" : "generated"}.js";
import raw from "./generated.js";
import { loadHarness } from "./workspace.js";
import type { HarnessHost } from "@little-stack/harness";
declare const host: HarnessHost;
${overloaded ? 'raw({ host });\nloadHarness("support", { host });' : ""}
const context = { chatSessionId: "chat", onResult: () => {} };
create({ host, context });
loadHarness("${overloaded ? "declared" : "support"}", { host, context });
${required ? "// @ts-expect-error context remains required" : ""}
create({ host });
${required ? "// @ts-expect-error context remains required" : ""}
loadHarness("${overloaded ? "declared" : "support"}", { host });
// @ts-expect-error context type must not widen to unknown
create({ host, context: { chatSessionId: 123 } });
// @ts-expect-error context type must not widen to unknown
loadHarness("${overloaded ? "declared" : "support"}", { host, context: { chatSessionId: 123 } });
`);
  const program = ts.createProgram([path], { noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" })).toBe("");
});

const overloadOrders = [
  ...["hab", "hba", "ahb", "bha", "abh", "bah", "abc", "acb", "bac", "bca", "cab", "cba"].map(order => ({ order: [...order].map(key => key === "h" ? "host" : key), promised: false })),
  ...[0, 6, 12].map(index => { const order = [..."abcdefghijkl"]; order.splice(index, 0, "host"); return { order, promised: false }; }),
  { order: ["a", "host", "b"], promised: true },
  { order: ["a", "a", "a", "host", "b", "b"], promised: false },
  { order: ["host", "host", "a", "a", "b", "b"], promised: false },
  { order: ["a", "b", "a", "host", "host"], promised: false },
];
it.each(overloadOrders)("explicit overload contracts preserve every supported context: $order (promised=$promised)", async ({ order, promised }) => {
  const { dir, root } = await fixture();
  await rm(join(dir, "tools"), { recursive: true });
  await rm(join(dir, "workflows"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await rm(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@little-stack"), { recursive: true });
  await symlink(process.cwd(), join(root, "node_modules/@little-stack/harness"));
  await symlink(join(process.cwd(), "node_modules/@types"), join(root, "node_modules/@types"));
  const isHost = (key: string) => key === "host";
  const contexts = order.filter(key => !isHost(key));
  const signatures = order.map(key => `function definition(host: HarnessHost${isHost(key) ? "" : `, context: { kind: "${key}"; value: string }`}): Harness;`).join("\n");
  await writeFile(join(dir, "agent.ts"), `import { createHarness, type Harness, type HarnessHost } from "@little-stack/harness";
${signatures}
function definition(host: HarnessHost, context?: { kind: string; value: string }) { return createHarness({ host, model: {} as never }); }
export default ${promised ? "Promise.resolve(definition)" : "definition"};`);
  const kinds = [...new Set(contexts)];
  const contract = kinds.map(key => `{ kind: "${key}"; value: string }`).join(" | ") + (order.some(isHost) ? " | undefined" : "");
  const dispatch = (order.some(isHost) ? "if (context === undefined) return definition(host);" : "") +
    `switch (context.kind) { ${kinds.map(key => `case "${key}": return definition(host, context);`).join(" ")} } throw new Error("Unexpected context");`;
  await declaredFixture(root, contract, dispatch);
  await writeFile(join(root, "generated.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  await writeFile(join(root, "workspace.ts"), await compileHarnessWorkspace(root, { moduleDir: root }));
  const path = join(root, "typecheck.ts");
  await writeFile(path, `import create from "./declared.js";
import raw from "./generated.js";
import { loadHarness } from "./workspace.js";
import authored from "./agents/declared/agent.js";
import rawAuthored from "./agents/support/agent.js";
import { instantiateHarness } from "@little-stack/harness/compiled";
import type { HarnessHost } from "@little-stack/harness";
declare const host: HarnessHost;
const definition = await authored;
const rawDefinition = await rawAuthored;
${order.some(isHost) ? "" : "// @ts-expect-error no raw host-only overload"}
raw({ host });
${order.some(isHost) ? "" : "// @ts-expect-error no raw host-only overload"}
loadHarness("support", { host });
${order.some(isHost) ? "" : "// @ts-expect-error no raw host-only overload"}
instantiateHarness(rawDefinition, host);
${contexts.map(key => `create({ host, context: { kind: "${key}", value: "live" } });\nloadHarness("declared", { host, context: { kind: "${key}", value: "live" } });\ninstantiateHarness(definition, host, { kind: "${key}", value: "live" });`).join("\n")}
${order.some(isHost) ? "" : "// @ts-expect-error no host-only overload"}
create({ host });
${order.some(isHost) ? "" : "// @ts-expect-error no host-only overload"}
loadHarness("declared", { host });
// @ts-expect-error no overload accepts this context
create({ host, context: { kind: "missing", value: "live" } });
// @ts-expect-error no overload accepts this context
loadHarness("declared", { host, context: { kind: "missing", value: "live" } });
// @ts-expect-error the first context signature's required field is still checked
create({ host, context: { kind: "${contexts[0]}" } });
// @ts-expect-error the first context signature's required field is still checked
loadHarness("declared", { host, context: { kind: "${contexts[0]}" } });
// @ts-expect-error the helper cannot accept an undeclared context
instantiateHarness(definition, host, { kind: "missing", value: "live" });
// @ts-expect-error the helper retains required context fields
instantiateHarness(definition, host, { kind: "${contexts[0]}" });
${order.some(isHost) ? "" : "// @ts-expect-error no host-only overload"}
instantiateHarness(definition, host);
`);
  const program = ts.createProgram([path], { noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" })).toBe("");
});

it.each([
  ["generic host-only", `export default <H extends HarnessHost>(host: H) => createHarness({ host, model: {} as never });`, false],
  ["generic context", `export default <H extends HarnessHost>(host: H, context: Context) => make(host);`, true],
  ["generic-dependent return", `export default <H extends HarnessHost>(host: H, context: Context) => Object.assign(make(host), { suppliedHost: host });`, true],
  ["generic host-first overload", `function definition<H extends HarnessHost>(host: H): Harness;\nfunction definition<H extends HarnessHost>(host: H, context: Context): Harness;\nfunction definition(host: HarnessHost, context?: Context) { return make(host); }\nexport default definition;`, false],
  ["generic host-last overload", `function definition<H extends HarnessHost>(host: H, context: Context): Harness;\nfunction definition<H extends HarnessHost>(host: H): Harness;\nfunction definition(host: HarnessHost, context?: Context) { return make(host); }\nexport default definition;`, false],
  ["generic overload-dependent return", `function definition<H extends HarnessHost>(host: H): Harness & { suppliedHost: H };\nfunction definition<H extends HarnessHost>(host: H, context: Context): Harness & { suppliedHost: H };\nfunction definition(host: HarnessHost, context?: Context) { return Object.assign(make(host), { suppliedHost: host }); }\nexport default Promise.resolve(definition);`, false],
  ["annotated generic overload", `function definition<H extends HarnessHost>(host: H): Harness & { suppliedHost: H };\nfunction definition<H extends HarnessHost>(host: H, context: Context): Harness & { suppliedHost: H };\nfunction definition(host: HarnessHost, context?: Context) { return Object.assign(make(host), { suppliedHost: host }); }\nfunction annotated(): import("@little-stack/harness/compiled").HarnessDefinition<Context> { return definition; }\nexport default annotated();`, true],
  ["generic alternative contexts", `function definition<H extends HarnessHost>(host: H, context: Context): Harness & { suppliedHost: H };\nfunction definition<H extends HarnessHost>(host: H, context: { auditId: string }): Harness & { suppliedHost: H };\nfunction definition(host: HarnessHost, context: Context | { auditId: string }) { return Object.assign(make(host), { suppliedHost: host }); }\nexport default definition;`, true],
] as const)("generic factory inference terminates and executes: %s", async (name, definition, required) => {
  const { dir, root } = await fixture();
  await rm(join(dir, "tools"), { recursive: true });
  await rm(join(dir, "workflows"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await rm(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@little-stack"), { recursive: true });
  await symlink(process.cwd(), join(root, "node_modules/@little-stack/harness"));
  await symlink(join(process.cwd(), "node_modules/@types"), join(root, "node_modules/@types"));
  await writeFile(join(dir, "agent.ts"), `import { createHarness, type Harness, type HarnessHost } from "@little-stack/harness";
type Context = { chatSessionId: string; onResult: () => void };
const make = (host: HarnessHost) => createHarness({ host, model: {} as never });
${definition}`);
  const alternate = name === "generic alternative contexts";
  const declaredDir = alternate ? await declaredFixture(root, "Context | { auditId: string }", 'if ("auditId" in context) return definition(host, context); return definition(host, context);') : undefined;
  await writeFile(join(root, "generated.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  await writeFile(join(root, "workspace.ts"), (await compileHarnessWorkspace(root, { moduleDir: root })) + "\nexport default loadHarness;");
  const path = join(root, "typecheck.ts");
  await writeFile(path, `import create from "./${alternate ? "declared" : "generated"}.js";
import { loadHarness } from "./workspace.js";
import type { HarnessHost } from "@little-stack/harness";
declare const host: HarnessHost;
const context = { chatSessionId: "chat", onResult: () => {} };
create({ host, context });
loadHarness("${alternate ? "declared" : "support"}", { host, context });
${!required ? `create({ host });\nloadHarness("${alternate ? "declared" : "support"}", { host });` : ""}
${name === "generic alternative contexts" ? 'create({ host, context: { auditId: "audit" } });\nloadHarness("declared", { host, context: { auditId: "audit" } });' : ""}
${["generic context", "generic-dependent return", "annotated generic overload", "generic alternative contexts"].includes(name) ? `// @ts-expect-error context remains required when its contract is reflectable or explicit
create({ host });
// @ts-expect-error context remains required when its contract is reflectable or explicit
loadHarness("${alternate ? "declared" : "support"}", { host });
// @ts-expect-error contextual generic constraints remain checked
create({ host, context: { chatSessionId: 123 } });
// @ts-expect-error contextual generic constraints remain checked
loadHarness("${alternate ? "declared" : "support"}", { host, context: { chatSessionId: 123 } });` : ""}
`);
  const program = ts.createProgram([path], { noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" })).toBe("");
  const folder = await importDefault<(options: CompiledHarnessOptions) => Promise<Harness>>(join(root, "generated.ts"));
  const workspace = await importDefault<(name: string, options: CompiledHarnessOptions) => Promise<Harness>>(join(root, "workspace.ts"));
  const typedFolder = declaredDir === undefined ? undefined : await importDefault<(options: CompiledHarnessOptions) => Promise<Harness>>(join(root, "declared.ts"));
  const suppliedHost = host();
  const context = { chatSessionId: "chat", onResult: () => {} };
  for (const instance of await Promise.all([folder({ host: suppliedHost, context }), workspace("support", { host: suppliedHost, context }), loadHarness(dir, { host: suppliedHost, context }), ...(typedFolder === undefined ? [] : [typedFolder({ host: suppliedHost, context }), workspace("declared", { host: suppliedHost, context }), loadHarness(declaredDir!, { host: suppliedHost, context })])])) {
    expect(instance.config.host).toBe(suppliedHost);
    expect(instance.sessions).toBe(suppliedHost.sessions);
  }
});

it("raw overload inference uses the last signature, preserves host calls, and supports explicit contracts", async () => {
  const { dir, root } = await fixture();
  await rm(join(dir, "tools"), { recursive: true });
  await rm(join(dir, "workflows"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await rm(join(root, "node_modules"));
  await mkdir(join(root, "node_modules/@little-stack"), { recursive: true });
  await symlink(process.cwd(), join(root, "node_modules/@little-stack/harness"));
  await symlink(join(process.cwd(), "node_modules/@types"), join(root, "node_modules/@types"));
  const preamble = `import { createHarness, type Harness, type HarnessHost } from "@little-stack/harness";
type A = { kind: "a"; value: string }; type B = { kind: "b"; value: string };
`;
  const body = `function definition(host: HarnessHost, context?: A | B) { return createHarness({ host, model: {} as never }); }\nexport default definition;`;
  await writeFile(join(dir, "agent.ts"), preamble + `function definition(host: HarnessHost): Harness;
function definition(host: HarnessHost, context: A): Harness;
function definition(host: HarnessHost, context: B): Harness;
` + body);
  const lastHost = join(root, "agents/last-host"); await mkdir(lastHost);
  await writeFile(join(lastHost, "agent.ts"), preamble + `function definition(host: HarnessHost, context: A): Harness;
function definition(host: HarnessHost, context: B): Harness;
function definition(host: HarnessHost): Harness;
` + body);
  await declaredFixture(root, '{ kind: "a"; value: string } | { kind: "b"; value: string } | undefined', 'if (context === undefined) return definition(host); if (context.kind === "a") return definition(host, context); return definition(host, context);');
  await writeFile(join(root, "generated.ts"), await compileHarnessFolder(dir, { moduleDir: root }));
  await writeFile(join(root, "last-host.ts"), await compileHarnessFolder(lastHost, { moduleDir: root }));
  await writeFile(join(root, "workspace.ts"), await compileHarnessWorkspace(root, { moduleDir: root }));
  const path = join(root, "typecheck.ts");
  await writeFile(path, `import lastContext from "./generated.js";
import lastHost from "./last-host.js";
import declared from "./declared.js";
import { loadHarness } from "./workspace.js";
import type { HarnessHost } from "@little-stack/harness";
declare const host: HarnessHost;
lastContext({ host }); loadHarness("support", { host });
lastContext({ host, context: { kind: "b", value: "ok" } });
loadHarness("support", { host, context: { kind: "b", value: "ok" } });
// @ts-expect-error earlier contextual alternatives need an explicit contract
lastContext({ host, context: { kind: "a", value: "ok" } });
// @ts-expect-error earlier contextual alternatives need an explicit contract
loadHarness("support", { host, context: { kind: "a", value: "ok" } });
// @ts-expect-error the inferred last context still checks required fields
lastContext({ host, context: { kind: "b" } });
lastHost({ host }); loadHarness("last-host", { host });
// A final host-only signature supplies no context shape: context is unknown.
lastHost({ host, context: { arbitrary: 123 } });
loadHarness("last-host", { host, context: { arbitrary: 123 } });
declared({ host }); loadHarness("declared", { host });
declared({ host, context: { kind: "a", value: "ok" } });
declared({ host, context: { kind: "b", value: "ok" } });
// @ts-expect-error explicit contracts restore full supplied-context checks
loadHarness("declared", { host, context: { kind: "a" } });
`);
  const program = ts.createProgram([path], { noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" })).toBe("");
});
