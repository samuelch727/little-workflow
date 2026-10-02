import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessWorkflow } from "little-harness";
import { getWorkflowDefinitionHash } from "../workflow-definition-hash.js";
import type { ToolRegistry } from "../tool-registry.js";
import { hashImportGraph } from "./import-graph.js";
import { loadWorkflow } from "./load-workflow.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const authoringUrl = pathToFileURL(join(srcDir, "authoring.ts")).href;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.doUnmock("../runtime.js");
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `little-workflow-${prefix}-`));
  tempDirs.push(dir);
  await writeFile(join(dir, "little-workflow.json"), "{}\n");
  return dir;
}

async function write(p: string, contents: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, contents);
}

function workflowSource(extra: string = ""): string {
  return `
    import { createLittleWorkflow, model } from ${JSON.stringify(authoringUrl)};
    ${extra}
    export default createLittleWorkflow({
      id: "demo.${Math.random().toString(36).slice(2)}",
      description: typeof description === "string" ? description : "Demo workflow",
      models: [model({ provider: "test", modelId: "worker" })],
      planner: { model: model({ provider: "test", modelId: "planner" }) },
    });
  `;
}

async function writeBasicWorkflow(dir: string, extra: string = ""): Promise<void> {
  await write(join(dir, "workflow.ts"), workflowSource(extra));
}

async function symlinkPackage(workspace: string, name: string, target: string): Promise<void> {
  const packageDir = join(workspace, "node_modules", name);
  await mkdir(dirname(packageDir), { recursive: true });
  await symlink(target, packageDir, "dir");
}

describe("loadWorkflow", () => {
  it("loads workflow.ts, applies instructions.md, and produces a sha256 definitionIdentity", async () => {
    const dir = await fixture("basic");
    await writeBasicWorkflow(dir);
    await write(join(dir, "instructions.md"), "Plan from the folder instructions.\n");

    const loaded = await loadWorkflow(dir);

    expect(loaded.workflow.planner.system).toBe("Plan from the folder instructions.");
    expect(loaded.definitionIdentity).toMatch(/^sha256:/u);
    expect(loaded.inputSchema).toEqual({ kind: "untyped", allowUntypedInput: false });
    const structural: HarnessWorkflow = loaded;
    expect(typeof structural.runForHarness).toBe("function");
  });

  it("exposes Harness input schema markers while keeping the raw workflow schema", async () => {
    const dir = await fixture("input-marker");
    await write(join(dir, "workflow.ts"), `
      import { createLittleWorkflow, model } from ${JSON.stringify(authoringUrl)};
      const inputSchema = {
        type: "object",
        properties: { ticketId: { type: "string" } },
        required: ["ticketId"],
        additionalProperties: false,
      };
      export default createLittleWorkflow({
        id: "demo.input_marker",
        inputSchema,
        models: [model({ provider: "test", modelId: "worker" })],
        planner: { model: model({ provider: "test", modelId: "planner" }) },
      });
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.inputSchema).toEqual({
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { ticketId: { type: "string" } },
        required: ["ticketId"],
        additionalProperties: false,
      },
    });
    expect(loaded.workflow.inputSchema).toEqual({
      type: "object",
      properties: { ticketId: { type: "string" } },
      required: ["ticketId"],
      additionalProperties: false,
    });
  });

  it("marks unconvertible input schemas instead of exposing raw schema values", async () => {
    const dir = await fixture("input-unconvertible");
    await write(join(dir, "workflow.ts"), `
      import { createLittleWorkflow, model } from ${JSON.stringify(authoringUrl)};
      export default createLittleWorkflow({
        id: "demo.input_unconvertible",
        inputSchema: { parse: () => ({}) },
        models: [model({ provider: "test", modelId: "worker" })],
        planner: { model: model({ provider: "test", modelId: "planner" }) },
      });
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.inputSchema).toMatchObject({ kind: "unconvertible" });
  });

  it("changes definitionIdentity when a workflow local dependency changes", async () => {
    const dir = await fixture("workflow-dep");
    await write(join(dir, "description.ts"), "export const description = 'first';\n");
    await writeBasicWorkflow(dir, "import { description } from './description.js';");
    const first = await loadWorkflow(dir);

    await write(join(dir, "description.ts"), "export const description = 'second';\n");
    const second = await loadWorkflow(dir);

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("changes definitionIdentity when a tool dependency is outside the explicit workspaceRoot", async () => {
    const root = await fixture("outside-workspace-dep");
    const dir = join(root, "workflows", "candidate");
    await writeBasicWorkflow(dir);
    await write(join(root, "shared.ts"), "export const label = 'first';\n");
    await write(join(dir, "tools", "lookup.ts"), `
      import { label } from '../../../shared.js';
      export default { description: "Lookup", inputSchema: true, execute: async () => label };
    `);
    const first = await loadWorkflow(dir, { workspaceRoot: dir });

    await write(join(root, "shared.ts"), "export const label = 'second';\n");
    const second = await loadWorkflow(dir, { workspaceRoot: dir });

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("durable mode accepts static CommonJS require dependencies and hashes them", async () => {
    const dir = await fixture("static-require");
    await write(join(dir, "description.ts"), "exports.description = 'first';\n");
    await write(join(dir, "workflow.ts"), `
      import { createLittleWorkflow, model } from ${JSON.stringify(authoringUrl)};
      const { description } = require("./description.js");
      export default createLittleWorkflow({
        id: "demo.static_require",
        description,
        models: [model({ provider: "test", modelId: "worker" })],
        planner: { model: model({ provider: "test", modelId: "planner" }) },
      });
    `);

    const first = await loadWorkflow(dir, { executionMode: "durable" });
    await write(join(dir, "description.ts"), "exports.description = 'second';\n");
    const second = await loadWorkflow(dir, { executionMode: "durable" });

    expect(first.sourceIdentity).toBeUndefined();
    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("changes definitionIdentity when a discovered tool dependency changes", async () => {
    const dir = await fixture("tool-dep");
    await writeBasicWorkflow(dir);
    await write(join(dir, "lib", "shared.ts"), "export const label = 'first';\n");
    await write(join(dir, "tools", "lookup.ts"), `
      import { label } from '../lib/shared.js';
      export default { description: label, inputSchema: true, execute: async () => label };
    `);
    const first = await loadWorkflow(dir);

    await write(join(dir, "lib", "shared.ts"), "export const label = 'second';\n");
    const second = await loadWorkflow(dir);

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("changes definitionIdentity when a skill.ts dependency changes", async () => {
    const dir = await fixture("skill-dep");
    await writeBasicWorkflow(dir);
    await write(join(dir, "skills", "review", "identity.ts"), "export const hash = 'first';\n");
    await write(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview skill.\n");
    await write(join(dir, "skills", "review", "skill.ts"), `
      import { hash } from './identity.js';
      export default { kind: "skill", source: "./SKILL.md", name: "review", frontmatterHash: hash };
    `);
    const first = await loadWorkflow(dir);

    await write(join(dir, "skills", "review", "identity.ts"), "export const hash = 'second';\n");
    const second = await loadWorkflow(dir);

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("uses tsconfig path aliases for workflow and skill imports", async () => {
    const dir = await fixture("aliases");
    await write(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@workflow/*": ["src/*"],
          "@skills/*": ["skill-shared/*"],
        },
      },
    }));
    await write(join(dir, "src", "description.ts"), "export const description = 'From alias';\n");
    await writeBasicWorkflow(dir, "import { description } from '@workflow/description';");
    await write(join(dir, "skill-shared", "identity.ts"), "export const frontmatterHash = 'alias-hash';\n");
    await write(join(dir, "skills", "alias", "skill.ts"), `
      import { frontmatterHash } from '@skills/identity';
      export default { kind: "skill", source: "./SKILL.md", name: "alias", frontmatterHash };
    `);
    await write(join(dir, "skills", "alias", "SKILL.md"), "---\nname: alias\n---\nUse alias skill.\n");

    const loaded = await loadWorkflow(dir);

    expect(loaded.workflow.description).toBe("From alias");
    expect(loaded.workflow.planner.skills?.[0]?.name).toBe("alias");
  });

  it("changes definitionIdentity when a tsconfig alias dependency is outside the explicit workspaceRoot", async () => {
    const root = await fixture("outside-alias-dep");
    const dir = join(root, "workflows", "candidate");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@shared/*": ["../../shared/*"] },
      },
    }));
    await write(join(root, "shared", "value.ts"), "export const label = 'first';\n");
    await write(join(dir, "tools", "lookup.ts"), `
      import { label } from '@shared/value';
      export default { description: "Lookup", inputSchema: true, execute: async () => label };
    `);
    const first = await loadWorkflow(dir, { workspaceRoot: dir });

    await write(join(root, "shared", "value.ts"), "export const label = 'second';\n");
    const second = await loadWorkflow(dir, { workspaceRoot: dir });

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("changes definitionIdentity when a workspace package export target changes", async () => {
    const dir = await fixture("package-export");
    await writeBasicWorkflow(dir);
    await write(join(dir, "node_modules", "@local", "pkg", "package.json"), JSON.stringify({
      name: "@local/pkg",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./target.ts" },
    }));
    await write(join(dir, "node_modules", "@local", "pkg", "target.ts"), "export const label = 'first';\n");
    await write(join(dir, "tools", "lookup.ts"), `
      import { label } from '@local/pkg';
      export default { description: label, inputSchema: true, execute: async () => label };
    `);
    const first = await loadWorkflow(dir);

    await write(join(dir, "node_modules", "@local", "pkg", "target.ts"), "export const label = 'second';\n");
    const second = await loadWorkflow(dir);

    expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
  });

  it("durable mode rejects dynamic imports unless sourceIdentity is supplied", async () => {
    const dir = await fixture("dynamic");
    await writeBasicWorkflow(dir, "export async function later() { return import('./later.js'); }");

    await expect(loadWorkflow(dir, { executionMode: "durable" })).rejects.toThrow(/sourceIdentity/i);
    await expect(loadWorkflow(dir, { executionMode: "durable", sourceIdentity: "manual:v1" }))
      .resolves.toMatchObject({ executionMode: "durable", sourceIdentity: "manual:v1" });
  });

  it("discovers tools and adds them to loaded.tools and workflow.globalTools", async () => {
    const dir = await fixture("tools");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "lookup.ts"), `
      export default { description: "Lookup", inputSchema: true, execute: async () => "ok" };
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.tools.has("lookup")).toBe(true);
    expect(loaded.workflow.globalTools).toContain("lookup");
  });

  it("allows underscore tool ids from discovered filenames", async () => {
    const dir = await fixture("underscore");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "lookup_order.ts"), `
      export default { description: "Lookup", inputSchema: true, execute: async () => "ok" };
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.tools.has("lookup_order")).toBe(true);
    expect(loaded.workflow.globalTools).toContain("lookup_order");
  });

  it("rejects a non-tool default export under tools/", async () => {
    const dir = await fixture("bad-tool");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "bad.ts"), "export default 42;\n");

    await expect(loadWorkflow(dir)).rejects.toThrow(/bad.*must default-export an AI SDK tool/iu);
  });

  it("skips a directory entry whose name ends in a source extension under tools/", async () => {
    const dir = await fixture("dir-stem");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "real.ts"), `
      export default { description: "Real", inputSchema: true, execute: async () => "ok" };
    `);
    // a DIRECTORY whose name ends in .ts must not be treated as a tool file
    await write(join(dir, "tools", "nested.ts", "inner.ts"), "export default 1;\n");

    const loaded = await loadWorkflow(dir);

    expect(loaded.tools.names()).toEqual(["real"]);
  });

  it("rejects same-stem tool files with different extensions", async () => {
    const dir = await fixture("collision");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "foo.ts"), `
      export default { description: "TS tool", inputSchema: true, execute: async () => "ts" };
    `);
    await write(join(dir, "tools", "foo.js"), `
      export default { description: "JS tool", inputSchema: true, execute: async () => "js" };
    `);

    await expect(loadWorkflow(dir)).rejects.toThrow(/multiple files/u);
  });

  it("hashes a nameless out-of-workspace bare dependency portably across absolute roots", async () => {
    async function build(prefix: string): Promise<{ workspace: string; entry: string }> {
      const root = await mkdtemp(join(tmpdir(), prefix));
      tempDirs.push(root);
      // nameless package in node_modules ABOVE the workspace -> resolves outside workspace
      await write(join(root, "node_modules", "nameless-dep", "package.json"),
        JSON.stringify({ version: "1.0.0", type: "module", exports: { ".": "./index.js" } }));
      await write(join(root, "node_modules", "nameless-dep", "index.js"), "export const x = 1;\n");
      const workspace = join(root, "app");
      await write(join(workspace, "_jiti_root_.js"), "");
      const entry = join(workspace, "entry.ts");
      await write(entry, "import { x } from 'nameless-dep';\nexport default x;\n");
      return { workspace, entry };
    }
    const a = await build("wf-repro-A-");
    const b = await build("wf-repro-B-");
    const ha = await hashImportGraph({ workspaceRoot: a.workspace, entries: [a.entry] });
    const hb = await hashImportGraph({ workspaceRoot: b.workspace, entries: [b.entry] });
    expect(ha.hash).toBe(hb.hash);
  });

  it("loaded.run defaults to the discovered ToolRegistry", async () => {
    const runtimeSpy = vi.fn(async (options: { tools?: ToolRegistry }) => ({
      status: "completed",
      output: { hasLookup: options.tools?.has("lookup") },
      runId: "run",
      workflowVersionId: "version",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
      artifacts: [],
    }));
    vi.doMock("../runtime.js", () => ({ runWorkflow: runtimeSpy }));
    const { loadWorkflow: loadWithMockedRuntime } = await import("./load-workflow.js");
    const dir = await fixture("run-defaults");
    await writeBasicWorkflow(dir);
    await write(join(dir, "tools", "lookup.ts"), `
      export default { description: "Lookup", inputSchema: true, execute: async () => "ok" };
    `);

    const loaded = await loadWithMockedRuntime(dir);
    const result = await loaded.run({});

    expect(result.output).toEqual({ hasLookup: true });
    expect(runtimeSpy).toHaveBeenCalledWith(expect.objectContaining({ tools: loaded.tools }));
  });

  it("module loading is rooted at workspaceRoot instead of ambient cwd", async () => {
    const dir = await fixture("rooted");
    await write(join(dir, "packages", "dep", "package.json"), JSON.stringify({
      name: "root-only-dep",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.ts" },
    }));
    await write(join(dir, "packages", "dep", "index.ts"), "export const description = 'Rooted dependency';\n");
    await symlinkPackage(dir, "root-only-dep", join(dir, "packages", "dep"));
    await writeBasicWorkflow(dir, "import { description } from 'root-only-dep';");

    const loaded = await loadWorkflow(dir, { workspaceRoot: dir });

    expect(loaded.workflow.description).toBe("Rooted dependency");
  });

  it("accepts URL folders and durable/untyped options", async () => {
    const dir = await fixture("url");
    await writeBasicWorkflow(dir);

    const loaded = await loadWorkflow(pathToFileURL(`${dir}/`), {
      executionMode: "durable",
      allowUntypedInput: true,
      sourceIdentity: "manual:url",
    });

    expect(loaded.executionMode).toBe("durable");
    expect(loaded.inputSchema).toEqual({ kind: "untyped", allowUntypedInput: true });
  });

  it("uses skill.ts before sibling SKILL.md", async () => {
    const dir = await fixture("skill-precedence");
    await writeBasicWorkflow(dir);
    await write(join(dir, "skills", "guide", "SKILL.md"), "---\nname: markdown-guide\n---\nMarkdown skill.\n");
    await write(join(dir, "skills", "guide", "skill.ts"), `
      export default { kind: "skill", source: "./SKILL.md", name: "module-guide", frontmatterHash: "module-hash" };
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.workflow.planner.skills?.[0]?.name).toBe("module-guide");
  });

  it("hashes a bare skill.ts-only folder by synthesizing local skill identity", async () => {
    const dir = await fixture("bare-skill");
    await writeBasicWorkflow(dir);
    await write(join(dir, "skills", "local", "skill-body.md"), "No frontmatter here.\n");
    await write(join(dir, "skills", "local", "skill.ts"), "export default './skill-body.md';\n");

    const loaded = await loadWorkflow(dir);

    expect(() => getWorkflowDefinitionHash(loaded.workflow, loaded.tools)).not.toThrow();
    expect(loaded.workflow.planner.skills?.[0]).toMatchObject({ name: "local" });
  });

  it("hashes name and frontmatterHash skill.ts exports without rewriting identity", async () => {
    const dir = await fixture("explicit-skill");
    await writeBasicWorkflow(dir);
    await write(join(dir, "skills", "remote", "skill.ts"), `
      export default { kind: "skill", source: "https://example.com/skills/remote", name: "remote", frontmatterHash: "explicit-hash" };
    `);

    const loaded = await loadWorkflow(dir);

    expect(() => getWorkflowDefinitionHash(loaded.workflow, loaded.tools)).not.toThrow();
    expect(loaded.workflow.planner.skills?.[0]).toMatchObject({ name: "remote", frontmatterHash: "explicit-hash" });
  });

  it("accepts workflow.ts exports that are already LoadedWorkflow wrappers", async () => {
    const dir = await fixture("already-loaded");
    await write(join(dir, "workflow.ts"), `
      export default {
        id: "already.loaded",
        description: "Already loaded",
        executionMode: "inline",
        definitionIdentity: "sha256:inner",
        workflow: {
          id: "already.loaded",
          models: [{ aiSdkModel: { provider: "test", modelId: "worker" }, metadata: {} }],
          planner: { model: { aiSdkModel: { provider: "test", modelId: "planner" }, metadata: {} } },
        },
        tools: { get: () => undefined, list: () => [], names: () => [], has: () => false, toRecord: () => ({}), snapshotForManifest: () => [], register: () => {}, attachMcpTools: () => {} },
        source: { type: "folder", folder: ${JSON.stringify(dir)} },
        run: async () => ({ status: "completed" }),
      };
    `);

    const loaded = await loadWorkflow(dir);

    expect(loaded.id).toBe("already.loaded");
    expect(loaded.definitionIdentity).toBe("sha256:inner");
    expect(typeof loaded.runForHarness).toBe("function");
  });

  it("rewraps already loaded workflows when stricter input options are explicit", async () => {
    const dir = await fixture("already-loaded-strict-input");
    await write(join(dir, "workflow.ts"), `
      export default {
        id: "already.loaded.strict",
        description: "Already loaded",
        inputSchema: { kind: "untyped", allowUntypedInput: true },
        executionMode: "inline",
        definitionIdentity: "sha256:inner",
        workflow: {
          id: "already.loaded.strict",
          models: [{ aiSdkModel: { provider: "test", modelId: "worker" }, metadata: {} }],
          planner: { model: { aiSdkModel: { provider: "test", modelId: "planner" }, metadata: {} } },
        },
        tools: { get: () => undefined, list: () => [], names: () => [], has: () => false, toRecord: () => ({}), snapshotForManifest: () => [], register: () => {}, attachMcpTools: () => {} },
        source: { type: "folder", folder: ${JSON.stringify(dir)} },
        run: async () => ({ status: "completed" }),
      };
    `);

    const loaded = await loadWorkflow(dir, { allowUntypedInput: false });

    expect(loaded.definitionIdentity).not.toBe("sha256:inner");
    expect(loaded.inputSchema).toEqual({ kind: "untyped", allowUntypedInput: false });
  });

  it("merges an inner LoadedWorkflow wrapper with sibling folder composition deterministically", async () => {
    const dir = await fixture("merge-wrapper");
    await write(join(dir, "workflow.ts"), `
      export default {
        id: "merge.loaded",
        description: "Merge loaded",
        executionMode: "inline",
        definitionIdentity: "sha256:inner",
        workflow: {
          id: "merge.loaded",
          models: [{ aiSdkModel: { provider: "test", modelId: "worker" }, metadata: {} }],
          planner: { model: { aiSdkModel: { provider: "test", modelId: "planner" }, metadata: {} } },
          globalTools: ["inner"],
        },
        tools: { get: (name) => name === "inner" ? { description: "Inner", inputSchema: true } : undefined, list: () => ["inner"], names: () => ["inner"], has: (name) => name === "inner", toRecord: () => ({ inner: { description: "Inner", inputSchema: true } }), snapshotForManifest: () => [], register: () => {}, attachMcpTools: () => {} },
        source: { type: "folder", folder: ${JSON.stringify(dir)} },
        run: async () => ({ status: "completed" }),
      };
    `);
    await write(join(dir, "instructions.md"), "Outer instructions.\n");
    await write(join(dir, "tools", "outer.ts"), "export default { description: 'Outer', inputSchema: true };\n");
    await write(join(dir, "skills", "outer", "SKILL.md"), "---\nname: outer\n---\nOuter skill.\n");

    const loaded = await loadWorkflow(dir);

    expect(loaded.workflow.planner.system).toBe("Outer instructions.");
    expect(loaded.workflow.globalTools).toEqual(["inner", "outer"]);
    expect(loaded.workflow.planner.skills?.map((entry) => entry.name)).toEqual(["outer"]);
    expect(loaded.tools.names()).toEqual(["inner", "outer"]);
  });

  it("includes an inner LoadedWorkflow definitionIdentity when rewrapping with sibling composition", async () => {
    const dir = await fixture("merge-wrapper-identity");
    await write(join(dir, "instructions.md"), "Outer instructions.\n");
    await write(join(dir, "workflow.ts"), `
      const innerIdentity = process.env.LW_TEST_INNER_IDENTITY ?? "sha256:inner-a";
      export default {
        id: "merge.identity",
        description: "Merge identity",
        executionMode: "inline",
        definitionIdentity: innerIdentity,
        workflow: {
          id: "merge.identity",
          models: [{ aiSdkModel: { provider: "test", modelId: "worker" }, metadata: {} }],
          planner: { model: { aiSdkModel: { provider: "test", modelId: "planner" }, metadata: {} } },
        },
        tools: { get: () => undefined, list: () => [], names: () => [], has: () => false, toRecord: () => ({}), snapshotForManifest: () => [], register: () => {}, attachMcpTools: () => {} },
        source: { type: "folder", folder: ${JSON.stringify(dir)} },
        run: async () => ({ status: "completed" }),
      };
    `);

    const previous = process.env.LW_TEST_INNER_IDENTITY;
    try {
      process.env.LW_TEST_INNER_IDENTITY = "sha256:inner-a";
      const first = await loadWorkflow(dir);
      process.env.LW_TEST_INNER_IDENTITY = "sha256:inner-b";
      const second = await loadWorkflow(dir);

      expect(second.definitionIdentity).not.toBe(first.definitionIdentity);
    } finally {
      if (previous === undefined) {
        delete process.env.LW_TEST_INNER_IDENTITY;
      } else {
        process.env.LW_TEST_INNER_IDENTITY = previous;
      }
    }
  });
});
