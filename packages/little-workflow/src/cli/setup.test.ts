import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupCommand } from "./setup-command.js";
import { planSetup, type SetupOptions } from "./setup-plan.js";
import { applySetupPlan, applySetupPlanWithHooks, recoverSetup, rollbackSetup } from "./setup-transaction.js";
import { liveModelSource } from "./setup-templates.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "little-setup-test-")); dirs.push(dir); return dir; }
const options = (override: Partial<SetupOptions> = {}): SetupOptions => ({ template: "node", provider: "openai", workflow: false, route: "api/little/chat", page: "little", ...override });

describe("setup recovery diagnostics", () => {
  it("requires an explicit recovery target and reports a missing journal truthfully", async () => {
    const root = await temp();
    const output: string[] = [];
    const errors: string[] = [];
    const io = { cwd: root, stdout: (s: string) => { output.push(s); }, stderr: (s: string) => { errors.push(s); } };
    expect(await setupCommand(["--rollback"], io)).toBe(1);
    expect(errors.join("")).toMatch(/directory or --here/);
    expect(await setupCommand(["--here", "--rollback"], io)).toBe(0);
    expect(output.join("")).toContain(`No setup transaction found in ${root}; nothing to recover.`);
    expect(output.join("")).not.toContain("Recovered");
    expect(await recoverSetup(root)).toEqual({ status: "nothing-to-recover", retained: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it("names and recovers the child project when invoked from its parent", async () => {
    const parent = await temp();
    const root = join(parent, "sam's project");
    await mkdir(join(root, ".little"), { recursive: true });
    await writeFile(join(root, "owned.txt"), "after");
    await writeFile(join(root, "user.txt"), "user edit");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, directories: [],
      files: [{ path: "owned.txt", before: "before", after: "after" }],
    }));
    await expect(planSetup(root, options())).rejects.toThrow(
      `little setup '${root.replaceAll("'", "'\\''")}' --rollback`,
    );
    const output: string[] = [];
    const io = { cwd: parent, stdout: (s: string) => { output.push(s); } };
    expect(await setupCommand(["--here", "--rollback"], io)).toBe(0);
    expect(output.join("")).toContain("nothing to recover");
    expect(await readFile(join(root, "owned.txt"), "utf8")).toBe("after");
    expect(await setupCommand([root, "--rollback"], io)).toBe(0);
    expect(output.join("")).toContain("Recovered unchanged CLI-owned files");
    expect(await readFile(join(root, "owned.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "user.txt"), "utf8")).toBe("user edit");
    expect(await recoverSetup(root)).toEqual({ status: "nothing-to-recover", retained: [] });
  });

  it("distinguishes committed cleanup from rollback and preserves generated files", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, "owned.txt"), "generated");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, committed: true, directories: [],
      files: [{ path: "owned.txt", before: "before", after: "generated" }],
    }));
    const output: string[] = [];
    expect(await setupCommand([root, "--rollback"], { stdout: (s) => { output.push(s); } })).toBe(0);
    expect(output.join("")).toContain("Completed cleanup of the committed setup");
    expect(output.join("")).not.toContain("Recovered unchanged");
    expect(await readFile(join(root, "owned.txt"), "utf8")).toBe("generated");
    expect(await recoverSetup(root)).toEqual({ status: "nothing-to-recover", retained: [] });
  });
});
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
      expect(Boolean(pkg.dependencies["@little-stack/workflow"])).toBe(workflow);
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
    await expect(applySetupPlanWithHooks(plan, { afterWrite: async i => { if (i === 5) throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
    expect(await readdir(join(root, "app"))).toEqual([]);
  });
  it("rolls back when install/verify fails", async () => {
    const root = await temp();
    await expect(applySetupPlan(await planSetup(root, options()), { complete: async () => { throw new Error("install interrupted"); } })).rejects.toThrow("install interrupted");
    expect(await readdir(root)).toEqual([]);
    expect((await planSetup(root, options())).conflicts).toEqual([]);
  });
  it("preserves a pre-existing recovery directory on rollback", async () => {
    const root = await next();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, ".little/user.json"), "user settings");
    const plan = await planSetup(root, options({ template: "existing-next" }));
    await expect(applySetupPlan(plan, { complete: async () => { throw new Error("install failed"); } })).rejects.toThrow("install failed");
    expect(await readdir(join(root, ".little"))).toEqual(["user.json"]);
    expect(await readFile(join(root, ".little/user.json"), "utf8")).toBe("user settings");
  });
  it("recovers a temporary write before rename and allows fresh-project retry", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const path = "package.json.little-99999999.tmp";
    await writeFile(join(root, path), "generated package");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999,
      files: [{ path: "package.json", before: null, after: "generated package" }],
      directories: [".little"],
      temporaryFiles: [{ path, after: "generated package" }],
    }));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect((await planSetup(root, options())).conflicts).toEqual([]);
  });
  it("retains an edited temporary write and its recovery journal", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const path = "package.json.little-99999999.tmp";
    await writeFile(join(root, path), "user edit");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [], directories: [".little"],
      temporaryFiles: [{ path, after: "generated package" }],
    }));
    expect(await rollbackSetup(root)).toEqual([path]);
    expect(await readFile(join(root, path), "utf8")).toBe("user edit");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/temporaryFiles/);
  });
  for (const legacy of [false, true]) it(`recovers an interrupted ${legacy ? "legacy" : "owned"} journal update`, async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const path = legacy ? ".little/setup-transaction.json.tmp" :
      ".little/setup-transaction.json.11111111-1111-4111-8111-111111111111.tmp";
    const journal = {
      schema: 1, pid: 99999999, files: [], directories: [".little"],
      ...(legacy ? {} : { journalTemporaryFile: path }),
    };
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify(journal));
    await writeFile(join(root, path), JSON.stringify({ ...journal, directories: [".little", "agents"] }, null, 2));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect((await planSetup(root, options())).conflicts).toEqual([]);
  });
  it("retains an unrecognized journal temporary write for manual recovery", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const path = ".little/setup-transaction.json.11111111-1111-4111-8111-111111111111.tmp";
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [], directories: [".little"], journalTemporaryFile: path,
    }));
    await writeFile(join(root, path), "user edit");
    expect(await rollbackSetup(root)).toEqual([path]);
    expect(await readFile(join(root, path), "utf8")).toBe("user edit");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/journalTemporaryFile/);
  });
  for (const collision of ["temporary file", "directory"] as const) it(`applies a complete ownership-revocation snapshot after a ${collision} collision`, async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const journalTemporaryFile = ".little/setup-transaction.json.11111111-1111-4111-8111-111111111111.tmp";
    const temporaryPath = "owned.little-99999999.tmp";
    const original = {
      schema: 1, pid: 99999999, files: [], journalTemporaryFile,
      directories: collision === "directory" ? [".little", "agents"] : [".little"],
      temporaryFiles: collision === "temporary file" ? [{ path: temporaryPath, after: "after" }] : [],
    };
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify(original));
    if (collision === "directory") await mkdir(join(root, "agents"));
    else await writeFile(join(root, temporaryPath), "after");
    await writeFile(join(root, journalTemporaryFile), JSON.stringify({ ...original, directories: [".little"], temporaryFiles: [] }, null, 2));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readdir(root)).toEqual([collision === "directory" ? "agents" : temporaryPath]);
    if (collision === "temporary file") expect(await readFile(join(root, temporaryPath), "utf8")).toBe("after");
  });
  it("retries after interruption before the initial recovery journal is written", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    expect(await rollbackSetup(root)).toEqual([]);
    const plan = await planSetup(root, options());
    expect(plan.conflicts).toEqual([]);
    await applySetupPlan(plan);
    expect((await planSetup(root, options())).files).toEqual([]);
  });
  it("refuses a nonempty or symlinked journal-less recovery directory", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, ".little/user.txt"), "user data");
    await expect(planSetup(root, options())).rejects.toThrow(/must be empty/);
    expect(await readFile(join(root, ".little/user.txt"), "utf8")).toBe("user data");
    const linked = await temp();
    await symlink(await temp(), join(linked, ".little"));
    await expect(planSetup(linked, options())).rejects.toThrow(/Symlink conflict/);
  });
  it("journals parent-directory ownership before a generated file is written", async () => {
    const root = await temp();
    await expect(applySetupPlanWithHooks({ root, files: [{ path: "agents/support/agent.ts", before: null, after: "generated" }], conflicts: [], warnings: [] }, {
      afterDirectory: async path => {
        if (path !== "agents") return;
        const journal = JSON.parse(await readFile(join(root, ".little/setup-transaction.json"), "utf8"));
        expect(journal.directories).toEqual([".little", "agents"]);
        expect(journal.files).toEqual([]);
        throw new Error("interrupted");
      },
    })).rejects.toThrow("interrupted");
    expect(await readdir(root)).toEqual([]);
  });
  it("recovers a directory created after its ownership intent was saved", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [], directories: [".little", "agents"],
    }));
    await mkdir(join(root, "agents"));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
  it("preserves a colliding temporary file before applying a write", async () => {
    const root = await temp();
    const path = `owned.little-${process.pid}.tmp`;
    await writeFile(join(root, path), "after");
    await expect(applySetupPlan({ root, files: [{ path: "owned", before: null, after: "after" }], conflicts: [], warnings: [] })).rejects.toThrow(/Temporary file conflict/);
    expect(await readFile(join(root, path), "utf8")).toBe("after");
    expect(await readdir(root)).toEqual([path]);
  });
  it("retains concurrent edits during rollback", async () => {
    const root = await temp();
    const plan = await planSetup(root, options());
    await expect(applySetupPlan(plan, { complete: async () => { await writeFile(join(root, "agents/support/agent.ts"), "user edit"); throw new Error("failure"); } })).rejects.toThrow(/preserved concurrent/);
    expect(await readFile(join(root, "agents/support/agent.ts"), "utf8")).toBe("user edit");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/agent.ts/);
  });
  it("preserves an existing destination edited after the final preimage check", async () => {
    const root = await temp();
    await writeFile(join(root, "owned"), "before");
    await expect(applySetupPlanWithHooks({ root, files: [{ path: "owned", before: "before", after: "after" }], conflicts: [], warnings: [] }, {
      beforeReplace: async () => {
        const journal = JSON.parse(await readFile(join(root, ".little/setup-transaction.json"), "utf8"));
        expect(journal.schema).toBe(2); // First-alpha CLIs reject newer ownership semantics.
        await writeFile(join(root, "owned"), "user edit");
      },
    })).rejects.toThrow(/Concurrent edit/);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("user edit");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/preimage/);
  });
  it("preserves an independently created destination even when its bytes match the generated file", async () => {
    const root = await temp();
    await expect(applySetupPlanWithHooks({ root, files: [{ path: "owned", before: null, after: "after" }], conflicts: [], warnings: [] }, {
      beforeReplace: async () => { await writeFile(join(root, "owned"), "after"); },
    })).rejects.toThrow(/Concurrent edit/);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("after");
    expect(await readFile(join(root, ".little/setup-transaction.json"), "utf8")).toMatch(/linkedWrites/);
  });
  it("recovers interruption after capturing the preimage and before placing the new file", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const captured = "owned.little-preimage.capture";
    const generated = "owned.little-99999999.tmp";
    await writeFile(join(root, captured), "before");
    await writeFile(join(root, generated), "after");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [".little"], linkedWrites: true,
      temporaryFiles: [{ path: generated, after: "after" }], captures: [{ path: captured, target: "owned", expected: "before", role: "preimage" }],
    }));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("before");
    expect(await readdir(root)).toEqual(["owned"]);
  });
  it("restarts legacy rollback after capturing the destination without truncating its bytes", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, "owned"), "after");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [".little"],
    }));
    await expect(rollbackSetup(root, false, { afterCapture: async () => { throw new Error("interrupted rollback"); } })).rejects.toThrow("interrupted rollback");
    const journal = JSON.parse(await readFile(join(root, ".little/setup-transaction.json"), "utf8"));
    expect(journal.schema).toBe(2); // Updating a legacy recovery upgrades its ownership format.
    expect(await readFile(join(root, journal.captures[0].path), "utf8")).toBe("after");
    expect(await readFile(join(root, journal.temporaryFiles[0].path), "utf8")).toBe("before");
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("before");
    expect(await readdir(root)).toEqual(["owned"]);
  });
  it("restores and reports an edit to the actual destination captured by rollback", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    await writeFile(join(root, "owned"), "after");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [".little"],
    }));
    const retained = await rollbackSetup(root, false, { afterCapture: async () => {
      const journal = JSON.parse(await readFile(join(root, ".little/setup-transaction.json"), "utf8"));
      await writeFile(join(root, journal.captures[0].path), "user edit");
    } });
    expect(retained).toContain("owned");
    expect(await readFile(join(root, "owned"), "utf8")).toBe("user edit");
  });
  it("retains a replaced destination with identical bytes during linked-write recovery", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const generated = "owned.little-99999999.tmp";
    await writeFile(join(root, generated), "after");
    await writeFile(join(root, "owned"), "after");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: null, after: "after" }], directories: [".little"], linkedWrites: true,
      temporaryFiles: [{ path: generated, after: "after" }],
    }));
    expect(await rollbackSetup(root)).toEqual(["owned"]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("after");
  });
  for (const before of [null, "before"]) it(`preserves an independent file captured by interrupted rollback (preimage=${before})`, async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const generated = "owned.little-99999999.tmp";
    const captured = "owned.little-rollback.capture";
    const preimage = "owned.little-preimage.capture";
    await writeFile(join(root, generated), "after");
    await writeFile(join(root, captured), "after"); // Same bytes, independently owned inode.
    if (before !== null) await writeFile(join(root, preimage), before);
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before, after: "after" }], directories: [".little"], linkedWrites: true,
      temporaryFiles: [{ path: generated, after: "after" }], captures: [
        ...(before === null ? [] : [{ path: preimage, target: "owned", expected: before, role: "preimage" }]),
        { path: captured, target: "owned", expected: "after", role: "rollback" },
      ],
    }));
    expect(await rollbackSetup(root)).toEqual(["owned"]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("after");
  });
  it("finishes committed cleanup after an ownership link was already removed", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const captured = "owned.little-preimage.capture";
    await writeFile(join(root, captured), "before");
    await writeFile(join(root, "owned"), "after");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [".little"], linkedWrites: true, committed: true,
      temporaryFiles: [{ path: "owned.little-99999999.tmp", after: "after" }], captures: [{ path: captured, target: "owned", expected: "before", role: "preimage" }],
    }));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("after");
    expect(await readdir(root)).toEqual(["owned"]);
  });
  it("rolls back owned links to restore existing files", async () => {
    const root = await temp();
    await mkdir(join(root, ".little"));
    const generated = "owned.little-99999999.tmp";
    const captured = "owned.little-preimage.capture";
    await writeFile(join(root, generated), "after");
    await link(join(root, generated), join(root, "owned"));
    await writeFile(join(root, captured), "before");
    await writeFile(join(root, ".little/setup-transaction.json"), JSON.stringify({
      schema: 1, pid: 99999999, files: [{ path: "owned", before: "before", after: "after" }], directories: [".little"], linkedWrites: true,
      temporaryFiles: [{ path: generated, after: "after" }], captures: [{ path: captured, target: "owned", expected: "before", role: "preimage" }],
    }));
    expect(await rollbackSetup(root)).toEqual([]);
    expect(await readFile(join(root, "owned"), "utf8")).toBe("before");
    expect(await readdir(root)).toEqual(["owned"]);
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

describe("setup vocabulary", () => {
  it("treats --here as the current directory only; existing Next needs --template existing-next", async () => {
    const root = await next();
    const output: string[] = [];
    const errors: string[] = [];
    const io = { cwd: root, stdout: (s: string) => { output.push(s); }, stderr: (s: string) => { errors.push(s); }, isTTY: false };
    expect(await setupCommand(["--here", "--plan"], io)).toBe(1);
    expect(errors.join("")).toMatch(/must be empty.*--template existing-next/);
    expect(await setupCommand(["--here", "--template", "existing-next", "--plan"], io)).toBe(0);
    expect(JSON.parse(output.join("")).options.template).toBe("existing-next");
  });
  it("fills the documented defaults inside planSetup", async () => {
    const root = await temp();
    const plan = await planSetup(root);
    expect(plan.options).toEqual({
      template: "node",
      provider: "openai",
      model: plan.options.model,
      workflow: false,
      packageManager: "npm",
      route: "api/little/chat",
      page: "little",
    });
    expect(plan.options.model.length).toBeGreaterThan(0);
  });
  it("keeps the transaction test hooks and rollbackSetup off the public scaffold entry", async () => {
    const scaffold = await import("../scaffold.js");
    expect(Object.keys(scaffold).sort()).toEqual([
      "addHarnessToWorkflowProject",
      "addWorkflowToProject",
      "applySetupPlan",
      "initWorkflowProject",
      "planSetup",
      "recoverSetup",
    ]);
  });
});

describe("generated starter", () => {
  const text = (plan: Awaited<ReturnType<typeof planSetup>>, path: string) => {
    const file = plan.files.find(f => f.path === path);
    if (file === undefined) throw new Error(`not generated: ${path}`);
    return file.after;
  };
  it("builds one harness from the provider module's model and the folder workflow", async () => {
    const plan = await planSetup(await temp(), options({ workflow: true }));
    const agent = text(plan, "agents/support/agent.ts");
    expect(agent.match(/createHarness\(/g)).toHaveLength(1);
    expect(agent).toContain('(await import("./live-model.ts")).model');
    expect(agent).toContain('loadWorkflow(new URL("./workflows/starter_echo", import.meta.url), { executionMode: "durable" })');
    expect(agent).not.toMatch(/definitionIdentity|asHarnessWorkflow|config\.|system:/);
    const live = text(plan, "agents/support/live-model.ts");
    expect(live).toContain('export const model = openai(');
    expect(live).not.toMatch(/createHarness|localHost|export default/);
  });
  it("writes the starter workflow as a fixed plan with no model and one input schema", async () => {
    const plan = await planSetup(await temp(), options({ workflow: true }));
    const workflow = text(plan, "agents/support/workflows/starter_echo/workflow.ts");
    expect(workflow).toContain('id: "starter_echo"');
    expect(workflow).toContain("plan: {");
    expect(workflow.match(/z\.object\(/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/\bmodels?:|harnessId|apiVersion|permissions|definitionIdentity/);
    expect(JSON.parse(text(plan, "little-workflow.json")).workflows).toEqual({ starter_echo: "./agents/support/workflows/starter_echo" });
    expect(text(plan, "LITTLE.md")).not.toMatch(/increment definitionIdentity/);
  });
  it("smoke-tests the folder agent on a temporary host without rebuilding the harness", async () => {
    const plan = await planSetup(await temp(), options({ workflow: true }));
    const smoke = text(plan, "scripts/little-smoke.mts");
    expect(smoke).toContain('loadHarness(agentDir, { host: localHost({ dataDir: join(dir, "harness") }) })');
    expect(smoke).not.toMatch(/sessions: host\.sessions|config: \{/);
    expect(smoke).toContain('assert.deepEqual(run.output, { echoed: "hello" })');
  });
  it("loads Harness in the Next server module from the package root", async () => {
    const plan = await planSetup(await temp(), options({ template: "next", workflow: true }));
    const server = text(plan, "src/agents/server.ts");
    expect(server).toContain('requirePackage("@little-stack/harness")');
    expect(server).toContain('import type { Harness, StreamHarnessOptions } from "@little-stack/harness";');
    expect(server).not.toMatch(/@little-stack\/harness\/(execution|workspace)/);
  });
  for (const provider of ["openai", "anthropic", "gateway", "openai-compatible", "open-responses"]) {
    it(`renders a model-only provider module for ${provider}`, () => {
      const source = liveModelSource(provider, "some-model");
      expect(source).toMatch(/export const model = .+\("some-model"\);\n$/);
      expect(source).not.toMatch(/createHarness|@little-stack\/harness/);
    });
  }
});
