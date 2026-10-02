import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localWorld } from "./authoring.js";
import { createToolRegistry } from "./tool-registry.js";
import { appendEvent } from "./world.js";
import {
  CapabilityDriftError,
  checkHarnessManifestDrift,
  fixerManifest,
  hashHarnessManifest,
  orchestratorManifest,
  plannerManifest,
  workerManifest,
} from "./manifests.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-manifests-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("manifest builders", () => {
  it("computes stable planner hashes for identical input", () => {
    const toolRegistry = createToolRegistry({
      lookup: {
        description: "Lookup customer",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        execute: async () => null,
      },
    });
    const base = {
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      systemPrompt: "Plan safely.",
      skills: [{ name: "batch-fan-out", frontmatterHash: "sha256:skill" }],
      workflowDefinitionHash: "sha256:wf",
      toolRegistry,
      memoryStoreIds: ["org", "workflow:support.summarize"],
    } as const;

    const first = plannerManifest(base);
    const second = plannerManifest(base);

    expect(hashHarnessManifest(first)).toBe(hashHarnessManifest(second));
  });

  it("includes remote skill commit identity in manifest skill hashes", () => {
    const base = {
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      skills: [
        {
          name: "remote-skill",
          frontmatterHash: "sha256:frontmatter",
          remote: {
            normalizedSource: "https://github.com/org/repo.git",
            commitSha: "1111111111111111111111111111111111111111",
            selectedSkill: "remote-skill",
            skillPath: "skills/remote-skill",
            contentHash: "sha256:content-a",
          },
        },
      ],
    } as const;

    const first = plannerManifest(base);
    const second = plannerManifest({
      ...base,
      skills: [
        {
          ...base.skills[0],
          remote: {
            ...base.skills[0].remote,
            commitSha: "2222222222222222222222222222222222222222",
            contentHash: "sha256:content-b",
          },
        },
      ],
    });

    expect(first.skillsHash).not.toBe(second.skillsHash);
    expect(hashHarnessManifest(first)).not.toBe(hashHarnessManifest(second));
  });

  it("sorts available workflows and memory store ids", () => {
    const manifest = orchestratorManifest({
      harnessId: "workflowHarness@1.0.0",
      orchestratorModelSlotId: "gpt-5",
      systemPrompt: "Orchestrate.",
      skills: [],
      availableWorkflows: [
        { id: "zeta", definitionHash: "sha256:z" },
        { id: "alpha", definitionHash: "sha256:a" },
      ],
      memoryStoreIds: ["workflow:zeta", "org", "workflow:alpha"],
      maxConcurrentSubRuns: 4,
    });

    expect(manifest.availableWorkflows.map((workflow) => workflow.id)).toEqual(["alpha", "zeta"]);
    expect(manifest.memoryStoreIds).toEqual(["org", "workflow:alpha", "workflow:zeta"]);
  });

  it("changes tools hash when the registry snapshot changes", () => {
    const toolsV1 = createToolRegistry({
      lookup: {
        description: "Lookup customer",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        execute: async () => null,
      },
    });
    const toolsV2 = createToolRegistry({
      lookup: {
        description: "Lookup customer and entitlements",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        execute: async () => null,
      },
    });

    const first = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      toolRegistry: toolsV1,
    });
    const second = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      toolRegistry: toolsV2,
    });

    expect(first.globalToolsHash).not.toBe(second.globalToolsHash);
  });

  it("hashes bash capabilities into role manifests", () => {
    const first = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      bashCapabilities: { network: false },
    });
    const second = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      bashCapabilities: {
        network: {
          allow: ["https://api.example.com/*"],
          methods: ["GET"],
        },
      },
    });

    expect(first.bashCapabilitiesHash).toMatch(/^sha256:/u);
    expect(first.bashCapabilitiesHash).not.toBe(second.bashCapabilitiesHash);
    expect(hashHarnessManifest(first)).not.toBe(hashHarnessManifest(second));
  });

  it("hashes sanitized MCP capability manifests without serializing the raw manifest", () => {
    const mcpCapabilities = {
      gateway: { listToolName: "mcp_list_tools", callToolName: "mcp_call_tool" },
      servers: [
        {
          id: "figma",
          description: "Figma.",
          transport: { type: "http", url: "https://mcp.example.test/figma" },
          guide: {
            name: "figma-mcp",
            description: "Use Figma.",
            bodyHash: "sha256:guide-a",
          },
          tools: [
            {
              serverId: "figma",
              sourceName: "search",
              visibleName: "search",
              description: "Search Figma files.",
              inputSchemaHash: "sha256:input-a",
            },
          ],
        },
      ],
    };
    const first = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      mcpCapabilities,
    });
    const second = plannerManifest({
      harnessId: "workflowHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      workflowDefinitionHash: "sha256:wf",
      mcpCapabilities: {
        ...mcpCapabilities,
        servers: [
          {
            ...mcpCapabilities.servers[0],
            tools: [
              {
                ...mcpCapabilities.servers[0].tools[0],
                description: "Search Figma files and comments.",
              },
            ],
          },
        ],
      },
    });

    expect(first.mcpCapabilitiesHash).toMatch(/^sha256:/u);
    expect(first.mcpCapabilitiesHash).not.toBe(second.mcpCapabilitiesHash);
    expect(hashHarnessManifest(first)).not.toBe(hashHarnessManifest(second));
    expect(JSON.stringify(first)).not.toContain("mcp.example.test");
    expect(JSON.stringify(first)).not.toContain("Search Figma files");
  });

  it("omits absent MCP capability hashes from orchestrator manifests", () => {
    const manifest = orchestratorManifest({
      harnessId: "workflowHarness@1.0.0",
      orchestratorModelSlotId: "gpt-5",
      availableWorkflows: [{ id: "support.mcp", definitionHash: "sha256:wf" }],
      maxConcurrentSubRuns: 2,
    });

    expect(Object.hasOwn(manifest, "mcpCapabilitiesHash")).toBe(false);
    expect(() => hashHarnessManifest(manifest)).not.toThrow();
  });
});

describe("checkHarnessManifestDrift", () => {
  it("throws CapabilityDriftError with a diff when the stored and current manifests differ", async () => {
    const world = await tempWorld();
    const runId = "run_manifest_drift";
    const stored = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "summarize",
      stepConfig: { uses: "tool.call", with: { tool: "summarize" } },
      allowedTools: ["summarize"],
      memoryStoreIds: ["org"],
    });
    await appendEvent(world, runId, {
      type: "harness.session.started",
      payload: {
        runId,
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest: stored,
        manifestHash: hashHarnessManifest(stored),
      },
    });

    const current = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "summarize",
      stepConfig: { uses: "tool.call", with: { tool: "summarize_v2" } },
      allowedTools: ["summarize"],
      memoryStoreIds: ["org"],
    });

    await expect(checkHarnessManifestDrift(world, runId, current)).rejects.toMatchObject({
      name: "CapabilityDriftError",
      causeCode: "capability_drift",
      diff: expect.arrayContaining([expect.stringContaining("$.stepConfigHash")]),
    } satisfies Partial<CapabilityDriftError>);
  });

  it("does not throw when the stored hash matches the current manifest hash", async () => {
    const world = await tempWorld();
    const runId = "run_manifest_no_drift";
    const manifest = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "summarize",
      stepConfig: { uses: "tool.call", with: { tool: "summarize" } },
      allowedTools: ["summarize"],
      memoryStoreIds: ["org"],
    });
    await appendEvent(world, runId, {
      type: "harness.session.started",
      payload: {
        runId,
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest,
        manifestHash: hashHarnessManifest(manifest),
      },
    });

    await expect(checkHarnessManifestDrift(world, runId, manifest)).resolves.toBeUndefined();
  });

  it("checks legacy HarnessSessionStarted events for manifest drift", async () => {
    const world = await tempWorld();
    const runId = "run_manifest_dotted_drift";
    const stored = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "summarize",
      stepConfig: { uses: "tool.call", with: { tool: "summarize" } },
      allowedTools: ["summarize"],
      memoryStoreIds: ["org"],
    });
    await appendEvent(world, runId, {
      type: "HarnessSessionStarted" as never,
      payload: {
        runId,
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest: stored,
        manifestHash: hashHarnessManifest(stored),
      },
    });

    const current = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "summarize",
      stepConfig: { uses: "tool.call", with: { tool: "summarize_v2" } },
      allowedTools: ["summarize"],
      memoryStoreIds: ["org"],
    });

    await expect(checkHarnessManifestDrift(world, runId, current)).rejects.toMatchObject({
      name: "CapabilityDriftError",
      causeCode: "capability_drift",
      diff: expect.arrayContaining([expect.stringContaining("$.stepConfigHash")]),
    } satisfies Partial<CapabilityDriftError>);
  });

  it("scopes drift checks by manifest category so fixer and worker sessions do not collide", async () => {
    const world = await tempWorld();
    const runId = "run_manifest_worker_fixer";
    const worker = workerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "compute",
      stepConfig: { uses: "code.run", with: { source: "async () => ({ ok: true })" } },
      allowedTools: [],
      memoryStoreIds: [],
    });
    await appendEvent(world, runId, {
      type: "harness.session.started",
      payload: {
        runId,
        role: "worker.code-run",
        task: { kind: "execute_step" },
        manifest: worker,
        manifestHash: hashHarnessManifest(worker),
      },
    });

    const fixer = fixerManifest({
      harnessId: "workflowHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_abc",
      stepPath: "compute",
      stepConfig: { uses: "code.run", with: { source: "async () => ({ ok: true })" } },
      modelSlotId: "model.fast",
      systemPrompt: "Fix failures.",
      allowedTools: [],
      memoryStoreIds: [],
      fixerModelSlotId: "model.fast",
      fixerSystem: "Fix failures.",
      fixerMaxAttempts: 2,
    });

    await expect(checkHarnessManifestDrift(world, runId, fixer)).resolves.toBeUndefined();
  });
});
