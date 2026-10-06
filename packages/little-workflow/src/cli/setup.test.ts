import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupCommand } from "./setup-command.js";
import { planSetup, type SetupOptions } from "./setup-plan.js";
import { applySetupPlan, rollbackSetup } from "./setup-transaction.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "little-setup-test-")); dirs.push(dir); return dir; }
const options = (override: Partial<SetupOptions> = {}): SetupOptions => ({ template: "node", provider: "openai", workflow: false, route: "api/little/chat", page: "little", ...override });
async function next(src = false, changes: Record<string, unknown> = {}) {
  const root = await temp();
  await mkdir(join(root, src ? "src/app" : "app"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "existing", private: true, scripts: { dev: "custom-dev", build: "custom-build" }, dependencies: { next: "^16.2.9", react: "^19.2.7", ai: "^7.0.126" }, ...changes }));
  await writeFile(join(root, "tsconfig.json"), '{ // JSONC aliases\n "compilerOptions": { "moduleResolution": "bundler", "paths": { "~/*": ["./src/*"] } },\n}');
  return root;
}

describe("unified setup planner", () => {
  for (const template of ["node", "next"] as const) for (const workflow of [false, true]) {
    it(`plans and idempotently creates ${template}, workflow=${workflow}`, async () => {
      const root = await temp();
      const input = options({ template, workflow });
      const plan = await planSetup(root, input);
      expect(plan.conflicts).toEqual([]);
      expect(await readdir(root)).toEqual([]); // preview is read-only
      await applySetupPlan(plan);
      expect((await planSetup(root, input)).files).toEqual([]);
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      expect(pkg.dependencies.ai).toBe("^7.0.0");
      expect(Boolean(pkg.dependencies["little-workflow"])).toBe(workflow);
      expect(JSON.stringify(pkg)).not.toMatch(/workspace:|latest|littledb|little-compute/);
    });
  }
  for (const src of [false, true]) it(`preserves existing Next files (src=${src})`, async () => {
    const root = await next(src);
    await writeFile(join(root, ".env.local"), "PRIVATE=unchanged\n");
    await writeFile(join(root, "next.config.mjs"), "export default { custom: true };");
    const plan = await planSetup(root, options({ template: "existing-next", workflow: true }));
    expect(plan.conflicts).toEqual([]);
    expect(plan.files.some(f => f.path === `${src ? "src/" : ""}agents/support/agent.ts`)).toBe(true);
    await applySetupPlan(plan);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.dev).toBe("custom-dev");
    expect(pkg.scripts.build).toBe("custom-build");
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe("PRIVATE=unchanged\n");
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe("export default { custom: true };");
    expect(await readFile(join(root, "tsconfig.json"), "utf8")).toMatch(/JSONC aliases/);
    expect((await planSetup(root, options({ template: "existing-next", workflow: true }))).files).toEqual([]);
  });
  it("reports a colliding route before any writes", async () => {
    const root = await next();
    await mkdir(join(root, "app/api/little/chat"), { recursive: true });
    await writeFile(join(root, "app/api/little/chat/route.ts"), "user route");
    const plan = await planSetup(root, options({ template: "existing-next" }));
    expect(plan.conflicts.join(" ")).toMatch(/route.ts/);
    await expect(applySetupPlan(plan)).rejects.toThrow(/conflicts/);
    expect(await readFile(join(root, "app/api/little/chat/route.ts"), "utf8")).toBe("user route");
  });
  it("supports explicit alternative route/page", async () => {
    const root = await next();
    const plan = await planSetup(root, options({ template: "existing-next", route: "api/my-little", page: "little-demo" }));
    expect(plan.conflicts).toEqual([]);
    expect(plan.files.some(f => f.path === "app/api/my-little/route.ts")).toBe(true);
  });
  it("refuses user-edited generated files", async () => {
    const root = await temp();
    await applySetupPlan(await planSetup(root, options()));
    await writeFile(join(root, "agents/support/agent.ts"), "user edit");
    expect((await planSetup(root, options())).conflicts.join(" ")).toMatch(/agent.ts/);
  });
  it("preserves additional package scripts on rerun", async () => {
    const root = await temp();
    await applySetupPlan(await planSetup(root, options()));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    pkg.scripts.user = "echo hi";
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const plan = await planSetup(root, options());
    expect(plan.conflicts).toEqual([]);
    await applySetupPlan(plan);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).scripts.user).toBe("echo hi");
  });
  it("reruns identically when the package manager is detected instead of explicit", async () => {
    const root = await temp();
    await applySetupPlan(await planSetup(root, options({ packageManager: "npm" })));
    expect((await planSetup(root, options())).files).toEqual([]);
  });
  it("detects route.js and page/route segment collisions", async () => {
    const root = await next();
    await mkdir(join(root, "app/api/little/chat"), { recursive: true });
    await writeFile(join(root, "app/api/little/chat/route.js"), "existing route");
    expect((await planSetup(root, options({ template: "existing-next" }))).conflicts.join(" ")).toMatch(/route.js/);
  });
  it("refuses changed template choices on rerun", async () => {
    const root = await temp();
    await applySetupPlan(await planSetup(root, options()));
    await expect(planSetup(root, options({ workflow: true }))).rejects.toThrow(/options differ/);
  });
  it("rejects invalid package JSON without mutation", async () => {
    const root = await next();
    await writeFile(join(root, "package.json"), "{broken");
    await expect(planSetup(root, options({ template: "existing-next" }))).rejects.toThrow(/Invalid JSON/);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{broken");
  });
  it("reports legacy or implicit TypeScript resolution without rewriting config", async () => {
    for (const moduleResolution of ["node", undefined]) {
      const root = await next();
      const config = JSON.stringify({ compilerOptions: { moduleResolution } });
      await writeFile(join(root, "tsconfig.json"), config);
      const plan = await planSetup(root, options({ template: "existing-next" }));
      expect(plan.conflicts.join(" ")).toMatch(/moduleResolution "bundler"/);
      await expect(applySetupPlan(plan)).rejects.toThrow(/conflicts/);
      expect(await readFile(join(root, "tsconfig.json"), "utf8")).toBe(config);
    }
  });
  it("refuses AI SDK 6 rather than upgrading", async () => {
    const root = await next(false, { dependencies: { next: "^16", react: "^19", ai: "^6" } });
    expect((await planSetup(root, options({ template: "existing-next" }))).conflicts.join(" ")).toMatch(/Dependency ai/);
  });
  it("refuses incompatible provider majors", async () => {
    const root = await next(false, { dependencies: { next: "^16", react: "^19", "@ai-sdk/openai": "^3" } });
    expect((await planSetup(root, options({ template: "existing-next" }))).conflicts.join(" ")).toMatch(/@ai-sdk\/openai/);
  });
  it("detects ambiguous routers and lockfiles", async () => {
    const root = await next();
    await mkdir(join(root, "src/app"), { recursive: true });
    await expect(planSetup(root, options({ template: "existing-next" }))).rejects.toThrow(/exactly one/);
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await expect(planSetup(root, options({ template: "existing-next" }))).rejects.toThrow(/Multiple lockfiles/);
  });
  for (const manager of ["npm", "pnpm", "yarn"] as const) it(`detects ${manager} lockfile`, async () => {
    const root = await next();
    await writeFile(join(root, { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" }[manager]), "{}");
    expect((await planSetup(root, options({ template: "existing-next" }))).options.packageManager).toBe(manager);
    await expect(planSetup(root, options({ template: "existing-next", packageManager: manager === "npm" ? "pnpm" : "npm" }))).rejects.toThrow(/conflicts/);
  });
  it("refuses path traversal and symlink targets", async () => {
    const root = await next();
    await expect(planSetup(root, options({ template: "existing-next", route: "api/../bad" }))).rejects.toThrow(/plain App Router/);
    await symlink(await temp(), join(root, "agents"));
    await expect(planSetup(root, options({ template: "existing-next" }))).rejects.toThrow(/Symlink conflict/);
  });
});

describe("transactions and command", () => {
  it("rolls back an interrupted generation", async () => {
    const root = await next();
    const before = await readFile(join(root, "package.json"), "utf8");
    const plan = await planSetup(root, options({ template: "existing-next" }));
    await expect(applySetupPlan(plan, { afterWrite: async i => { if (i === 5) throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
    expect(await readdir(join(root, "app"))).toEqual([]);
  });
  it("rolls back when install/verify fails", async () => {
    const root = await temp();
    await expect(applySetupPlan(await planSetup(root, options()), { complete: async () => { throw new Error("install interrupted"); } })).rejects.toThrow("install interrupted");
    expect(await readdir(root)).toEqual([".little"]);
  });
  it("retains concurrent edits during rollback", async () => {
    const root = await temp();
    const plan = await planSetup(root, options());
    await expect(applySetupPlan(plan, { complete: async () => { await writeFile(join(root, "agents/support/agent.ts"), "user edit"); throw new Error("failure"); } })).rejects.toThrow(/preserved concurrent/);
    expect(await readFile(join(root, "agents/support/agent.ts"), "utf8")).toBe("user edit");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/agent.ts/);
  });
  it("recovers a killed process journal without deleting unrelated files", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, "owned"), "after");
    await writeFile(join(root, "unrelated"), "keep");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({ schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [] }));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("before");
    expect(await readFile(join(root, "unrelated"), "utf8")).toBe("keep");
  });
  it("detects concurrent edits between preview and apply", async () => {
    const root = await next();
    const plan = await planSetup(root, options({ template: "existing-next" }));
    await writeFile(join(root, "package.json"), "{}");
    await expect(applySetupPlan(plan)).rejects.toThrow(/Changed since preview/);
  });
  it("documents help and unavailable Compute without writes", async () => {
    const root = await temp(); const messages: string[] = [];
    const io = { cwd: root, stdout: (s: string) => { messages.push(s); }, stderr: (s: string) => { messages.push(s); }, isTTY: false };
    expect(await setupCommand(["--help"], io)).toBe(0);
    expect(messages.join(" ")).toMatch(/--plan/);
    expect(await setupCommand(["--compute"], io)).toBe(0);
    expect(messages.join(" ")).toMatch(/not qualified/);
    expect(await readdir(root)).toEqual([]);
  });
  it("requires noninteractive apply consent", async () => {
    const root = await temp();
    expect(await setupCommand([root, "--template", "node"], { stdout: () => {}, stderr: () => {}, isTTY: false })).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(await setupCommand([root, "--yes", "--no-install"], { stdout: () => {}, stderr: () => {}, isTTY: false })).toBe(0);
  });
  it("requires scoped native-build consent before writes", async () => {
    const root = await temp();
    expect(await setupCommand([root, "--yes", "--workflow", "--install"], { stdout: () => {}, stderr: () => {}, isTTY: false })).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });
});
