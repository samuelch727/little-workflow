import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeCompiledWorkflowVersionIdentity,
  type WorkflowVersionLockSeed,
} from "./compiler-lock.js";
import {
  appendEvent,
  createLittleWorkflow,
  listEvents,
  localWorld,
  model,
  registerWorkflowVersion,
} from "./index.js";
import { compileWorkflow } from "./compiler.js";
import { runCli } from "./cli-core.js";

const tempDirs: string[] = [];
const srcDir = dirname(fileURLToPath(import.meta.url));
const authoringUrl = pathToFileURL(join(srcDir, "authoring.ts")).href;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validWorkflow() {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "cli.valid" },
    input: { schema: true },
    output: { schema: true },
    permissions: { models: [], tools: ["lookup"], secrets: [], network: [] },
    steps: [
      {
        id: "lookup",
        uses: "tool.call",
        with: { tool: "lookup", args: "{{ input }}" },
        output: { mode: "json", schema: true },
      },
    ],
  };
}

async function lockedWorkflowVersionFor(input: unknown) {
  const workflow = createLittleWorkflow({
    id: "cli.valid",
    description: "Compile CLI fixture.",
    inputSchema: true,
    outputSchema: true,
    models: [model({ provider: "test", modelId: "cli-worker-model" })],
  } as unknown as Parameters<typeof createLittleWorkflow>[0]);
  const draft = {
    ...validWorkflow(),
    permissions: { models: [], tools: [], secrets: [], network: [] },
    steps: [],
  };
  return compileWorkflow(workflow, {
    input,
    planner: { draft: async () => draft },
  });
}

function legacyUnlockedInputWorkflowVersion(
  workflowVersion: Awaited<ReturnType<typeof lockedWorkflowVersionFor>>["workflowVersion"],
) {
  const {
    workflowVersionId: _workflowVersionId,
    workflowVersionHash: _workflowVersionHash,
    inputBinding: _inputBinding,
    ...lockSeed
  } = workflowVersion.lock;
  const identity = computeCompiledWorkflowVersionIdentity({
    canonicalizer: workflowVersion.canonicalizer,
    lwirVersionId: workflowVersion.lwirVersionId,
    lwirHash: workflowVersion.lwirHash,
    lockSeed: lockSeed as WorkflowVersionLockSeed,
  });
  return {
    ...workflowVersion,
    id: identity.workflowVersionId,
    hash: identity.workflowVersionHash,
    lock: {
      workflowVersionId: identity.workflowVersionId,
      workflowVersionHash: identity.workflowVersionHash,
      ...lockSeed,
    },
  };
}

async function invoke(
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

async function writeFolderWorkflow(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "tools"), { recursive: true });
  await writeFile(join(dir, "tools", "echo.ts"), `
    export default { description: "Echo.", inputSchema: true, execute: async () => ({ ok: true }) };
  `);
  await writeFile(join(dir, "workflow.ts"), `
    import { createLittleWorkflow, model } from ${JSON.stringify(authoringUrl)};
    export default createLittleWorkflow({
      id: ${JSON.stringify(id)},
      models: [model({ provider: "test", modelId: "worker" })],
      globalTools: ["echo"],
      planner: {
        model: model({ provider: "test", modelId: "planner" }),
        harness: {
          harnessId: "cli-folder-planner@1.0.0",
          async run() {
            return {
              kind: "plan",
              lwir: {
                apiVersion: "littleworkflow.dev/v0.1",
                kind: "Workflow",
                metadata: { name: ${JSON.stringify(id)} },
                input: { schema: true },
                output: { schema: true },
                permissions: { models: [], tools: ["echo"], secrets: [], network: [] },
                steps: [{ id: "echo", uses: "tool.call", with: { tool: "echo", args: {} }, output: { mode: "json", schema: true } }]
              }
            };
          }
        }
      },
    });
  `);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("little CLI", () => {
  it("validates LWIR JSON and exits non-zero with compact findings for invalid documents", async () => {
    const dir = await tempDir("little-workflow-cli-");
    const validPath = join(dir, "workflow.json");
    const invalidPath = join(dir, "broken.json");
    await writeJson(validPath, validWorkflow());
    await writeJson(invalidPath, {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "broken" },
      input: {},
      output: { schema: true },
      steps: "not-an-array",
    });

    const valid = await invoke(["validate", validPath]);
    const invalid = await invoke(["validate", invalidPath]);

    expect(valid).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ valid: true, findings: [] })}\n`,
      stderr: "",
    });
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toEqual({
      valid: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ path: "$.input", severity: "error" }),
        expect.objectContaining({ path: "$.steps", severity: "error" }),
      ]),
    });
    expect(invalid.stderr).toBe("");
  });

  it("dumps run events as NDJSON from a configured Local World directory", async () => {
    const dataDir = await tempDir("little-workflow-cli-world-");
    const world = localWorld({ dataDir });
    await appendEvent(world, "run_cli_events", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_cli" },
    });
    await appendEvent(world, "run_cli_events", {
      type: "RunCompleted",
      payload: { workflowVersionId: "wfver_cli", output: { ok: true } },
    });

    const result = await invoke(["--data-dir", dataDir, "events", "run_cli_events"]);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events).toEqual([
      expect.objectContaining({ sequence: 1, type: "RunStarted" }),
      expect.objectContaining({ sequence: 2, type: "RunCompleted" }),
    ]);
  });

  it("filters run events by dotted harness event type and caller", async () => {
    const dataDir = await tempDir("little-workflow-cli-filtered-events-");
    const world = localWorld({ dataDir });
    await appendEvent(world, "run_cli_filtered_events", {
      type: "harness.session.started",
      payload: { runId: "run_cli_filtered_events", role: "worker", task: { kind: "execute_step" } },
    });
    await appendEvent(world, "run_cli_filtered_events", {
      type: "harness.tool_call.started",
      payload: { runId: "run_cli_filtered_events", caller: "model", toolName: "lookup" },
    });
    await appendEvent(world, "run_cli_filtered_events", {
      type: "harness.tool_call.started",
      payload: { runId: "run_cli_filtered_events", caller: "code", toolName: "lookup" },
    });
    await appendEvent(world, "run_cli_filtered_events", {
      type: "harness.tool_call.succeeded",
      payload: { runId: "run_cli_filtered_events", caller: "code", toolName: "lookup", output: {} },
    });

    const result = await invoke([
      "--data-dir",
      dataDir,
      "events",
      "run_cli_filtered_events",
      "--type",
      "harness.tool_call.*",
      "--caller",
      "code",
    ]);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events).toEqual([
      expect.objectContaining({
        sequence: 3,
        type: "harness.tool_call.started",
        payload: expect.objectContaining({ caller: "code" }),
      }),
      expect.objectContaining({
        sequence: 4,
        type: "harness.tool_call.succeeded",
        payload: expect.objectContaining({ caller: "code" }),
      }),
    ]);
  });

  it("describes reserved orchestration with harness terminology", async () => {
    const result = await invoke(["orchestrate"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a harness-backed planner");
    expect(result.stderr).not.toContain("planner adapter");
  });

  it("replays a run into materialized state without appending events", async () => {
    const dataDir = await tempDir("little-workflow-cli-replay-");
    const world = localWorld({ dataDir });
    await appendEvent(world, "run_cli_replay", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_cli" },
    });
    await appendEvent(world, "run_cli_replay", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });

    const before = await listEvents(world, "run_cli_replay");
    const result = await invoke(["replay", "run_cli_replay", "--data-dir", dataDir]);
    const after = await listEvents(world, "run_cli_replay");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        runId: "run_cli_replay",
        status: "running",
        eventCount: 2,
        steps: {
          summarize: expect.objectContaining({ status: "pending" }),
        },
      }),
    );
    // Replay is non-mutating: the committed event log is identical before and
    // after, asserted through the World API rather than on-disk bytes.
    expect(after).toEqual(before);
  });

  it("runs compiled LWIR against Local World and prints a terminal summary", async () => {
    const dir = await tempDir("little-workflow-cli-run-");
    const dataDir = join(dir, "world");
    const workflowPath = join(dir, "workflow.json");
    const inputPath = join(dir, "input.json");
    await writeJson(workflowPath, registerWorkflowVersion(validWorkflow()).lwir);
    await writeJson(inputPath, { ticketId: "TCK-1" });

    const result = await invoke([
      "run",
      workflowPath,
      "--input",
      inputPath,
      "--run-id",
      "run_cli_run",
      "--data-dir",
      dataDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        runId: "run_cli_run",
        status: "failed",
        workflowVersionId: expect.stringMatching(/^wfver_[0-9a-f]{16}$/),
        eventCount: expect.any(Number),
      }),
    );
  });

  it("runs a folder workflow through little test", async () => {
    const dir = await tempDir("little-workflow-cli-folder-");
    await writeJson(join(dir, "input.json"), { value: "x" });
    await writeFolderWorkflow(dir, "folder.echo");

    const result = await invoke(["test", dir, "--input", join(dir, "input.json")], { cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      workflowId: "folder.echo",
      status: "completed",
      output: { ok: true },
    }));
  });

  it("runs a named workflow from little-workflow.json", async () => {
    const root = await tempDir("little-workflow-cli-named-");
    const workflowDir = join(root, "workflows", "candidate-review");
    await mkdir(workflowDir, { recursive: true });
    await writeJson(join(root, "input.json"), { value: "x" });
    await writeJson(join(root, "little-workflow.json"), {
      workflows: { "candidate-review": "./workflows/candidate-review" },
    });
    await writeFolderWorkflow(workflowDir, "candidate.review");

    const result = await invoke(["test", "candidate-review", "--input", join(root, "input.json")], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      workflowId: "candidate.review",
      status: "completed",
    }));
  });

  it("routes init and add commands through the top-level little CLI", async () => {
    const root = await tempDir("little-workflow-cli-scaffold-");

    const init = await invoke(["init", "--here", "--workflow", "alpha", "--yes", "--no-install"], { cwd: root });
    const addWorkflow = await invoke(["add", "workflow", "beta"], { cwd: root });
    const addHarness = await invoke(["add", "harness", "--agent", "support", "--new-workflow", "gamma"], { cwd: root });

    expect(init.exitCode).toBe(0);
    expect(addWorkflow.exitCode).toBe(0);
    expect(addHarness.exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, "little-workflow.json"), "utf8"));
    expect(manifest.workflows).toMatchObject({
      alpha: "./workflows/alpha",
      beta: "./workflows/beta",
      gamma: "./workflows/gamma",
    });
  });

  it("rejects a locked WorkflowVersion when --input does not match the lock", async () => {
    const dir = await tempDir("little-workflow-cli-lock-");
    const workflowPath = join(dir, "workflow-version.json");
    const inputPath = join(dir, "input.json");
    const compiled = await lockedWorkflowVersionFor({ ticketId: "original" });
    await writeJson(workflowPath, compiled.workflowVersion);
    await writeJson(inputPath, { ticketId: "changed" });

    const result = await invoke([
      "run",
      workflowPath,
      "--input",
      inputPath,
      "--run-id",
      "run_cli_lock_mismatch",
      "--data-dir",
      join(dir, "world"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("WorkflowVersion inputHash does not match --input.");
  });

  it("does not enforce legacy WorkflowVersion inputHash without required input binding", async () => {
    const dir = await tempDir("little-workflow-cli-legacy-lock-");
    const workflowPath = join(dir, "workflow-version.json");
    const inputPath = join(dir, "input.json");
    const compiled = await lockedWorkflowVersionFor({ ticketId: "original" });
    const legacyWorkflowVersion = legacyUnlockedInputWorkflowVersion(
      compiled.workflowVersion,
    );
    await writeJson(workflowPath, legacyWorkflowVersion);
    await writeJson(inputPath, { ticketId: "changed" });

    const result = await invoke([
      "run",
      workflowPath,
      "--input",
      inputPath,
      "--run-id",
      "run_cli_legacy_lock",
      "--data-dir",
      join(dir, "world"),
    ]);

    expect(result.stderr).not.toContain("inputHash");
  });

  it("keeps cli.ts as an unconditional thin binary wrapper", async () => {
    const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toContain('import { runCli } from "./cli-core.js";');
    expect(source).toContain("process.exitCode = await runCli();");
    expect(source).not.toContain("process.argv[1]");
    expect(source).not.toContain("import.meta.url");
  });
});
