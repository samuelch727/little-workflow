import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  canonicalJson,
  listRunIds,
  localWorld,
  registerWorkflowVersion,
  WorldPathError,
  type LwirWorkflow,
} from "./index.js";
import {
  readStoredWorkflowVersion,
  registerStoredWorkflowVersion,
  WorkflowVersionStoreConflictError,
} from "./workflow-version-store.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-version-store-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lwir(overrides: Partial<LwirWorkflow> = {}): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "support.summarize", version: "0.1.0-alpha" },
    input: { schema: true },
    output: { schema: true },
    permissions: { tools: ["noop"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "done",
        uses: "tool.call",
        with: { tool: "noop", args: { ok: true } },
        output: { mode: "json", schema: true },
      },
    ],
    ...overrides,
  };
}

describe("workflow version store", () => {
  it("persists and reads full workflow versions as canonical JSON", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());

    await registerStoredWorkflowVersion(world, version);

    await expect(readStoredWorkflowVersion(world, version.id)).resolves.toEqual(version);
    await expect(
      readFile(join(world.dataDir, "workflow-versions", `${version.id}.json`), "utf8"),
    ).resolves.toBe(`${canonicalJson(version)}\n`);
  });

  it("is idempotent for identical existing content and rejects conflicting content", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());
    const conflicting = {
      ...version,
      lwir: {
        ...version.lwir,
        metadata: { ...version.lwir.metadata, description: "Different." },
      },
    };

    await registerStoredWorkflowVersion(world, version);
    await expect(registerStoredWorkflowVersion(world, version)).resolves.toBeUndefined();
    await expect(registerStoredWorkflowVersion(world, conflicting)).rejects.toBeInstanceOf(
      WorkflowVersionStoreConflictError,
    );
  });

  it("allows concurrent identical registrations for the same workflow version", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());

    await expect(
      Promise.all(
        Array.from({ length: 50 }, () => registerStoredWorkflowVersion(world, version)),
      ),
    ).resolves.toHaveLength(50);
    await expect(readStoredWorkflowVersion(world, version.id)).resolves.toEqual(version);
    await expect(
      readFile(join(world.dataDir, "workflow-versions", `${version.id}.json`), "utf8"),
    ).resolves.toBe(`${canonicalJson(version)}\n`);
  });

  it("rejects concurrent conflicting registrations without mutating the stored version", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());
    const conflicting = {
      ...version,
      lwir: {
        ...version.lwir,
        metadata: { ...version.lwir.metadata, description: "Conflicting content." },
      },
    };

    const results = await Promise.allSettled([
      registerStoredWorkflowVersion(world, version),
      registerStoredWorkflowVersion(world, conflicting),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(WorkflowVersionStoreConflictError),
    });
    await expect(readStoredWorkflowVersion(world, version.id)).resolves.toEqual(version);
  });

  it("rejects conflicting registrations racing from separate processes", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());
    const scriptPath = join(world.dataDir, "register-child.mjs");
    const loaderPath = join(world.dataDir, "ts-src-loader.mjs");
    const gatePath = join(world.dataDir, "start-race");
    const versions = Array.from({ length: 12 }, (_, index) =>
      index === 0
        ? version
        : {
            ...version,
            lwir: {
              ...version.lwir,
              metadata: {
                ...version.lwir.metadata,
                description: `Cross-process conflict ${index}.`,
              },
            },
          }
    );
    const versionPaths = await Promise.all(
      versions.map(async (entry, index) => {
        const versionPath = join(world.dataDir, `version-${index}.json`);
        await writeFile(versionPath, JSON.stringify(entry), "utf8");
        return versionPath;
      }),
    );
    await writeFile(
      loaderPath,
      `
export async function resolve(specifier, context, defaultResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
    try {
      return await defaultResolve(specifier.replace(/\\.js$/u, ".ts"), context, defaultResolve);
    } catch {
      return defaultResolve(specifier, context, defaultResolve);
    }
  }
  return defaultResolve(specifier, context, defaultResolve);
}
`,
      "utf8",
    );
    await writeFile(
      scriptPath,
      `
import { access, readFile } from "node:fs/promises";
import { registerStoredWorkflowVersion } from ${
        JSON.stringify(new URL("./workflow-version-store.ts", import.meta.url).href)
      };

const [dataDir, versionPath, gatePath] = process.argv.slice(2);
while (true) {
  try {
    await access(gatePath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

try {
  const version = JSON.parse(await readFile(versionPath, "utf8"));
  await registerStoredWorkflowVersion({ dataDir }, version);
  process.stdout.write("registered\\n");
} catch (error) {
  process.stderr.write(\`\${error?.name ?? "Error"}:\${error?.message ?? String(error)}\\n\`);
  process.exit(error?.name === "WorkflowVersionStoreConflictError" ? 23 : 1);
}
`,
      "utf8",
    );
    const children = versionPaths.map((versionPath) =>
      runRegisterChild(loaderPath, scriptPath, world.dataDir, versionPath, gatePath)
    );

    await writeFile(gatePath, "go", "utf8");
    const results = await Promise.all(children);

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 23)).toHaveLength(11);
    expect(results.filter((result) => result.code !== 0 && result.code !== 23)).toEqual([]);
    const stored = await readStoredWorkflowVersion(world, version.id);
    expect(versions.map((entry) => canonicalJson(entry))).toContain(canonicalJson(stored));
  });

  it("rejects unsafe workflow version ids", async () => {
    const world = await tempWorld();
    const version = registerWorkflowVersion(lwir());

    await expect(
      registerStoredWorkflowVersion(world, { ...version, id: "bad" }),
    ).rejects.toBeInstanceOf(WorldPathError);
    await expect(readStoredWorkflowVersion(world, "wfver_../../escape")).rejects.toBeInstanceOf(
      WorldPathError,
    );
  });
});

async function runRegisterChild(
  loaderPath: string,
  scriptPath: string,
  dataDir: string,
  versionPath: string,
  gatePath: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [
    "--experimental-loader",
    loaderPath,
    scriptPath,
    dataDir,
    versionPath,
    gatePath,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("listRunIds", () => {
  it("returns valid run ids from event jsonl files and ignores unrelated files", async () => {
    const world = await tempWorld();

    await appendEvent(world, "run_b", { type: "RunStarted", payload: { workflowVersionId: "wfver_b" } });
    await appendEvent(world, "run_a", { type: "RunStarted", payload: { workflowVersionId: "wfver_a" } });
    await writeFile(join(world.dataDir, "events", "notes.txt"), "ignore me", "utf8");
    await writeFile(join(world.dataDir, "events", "not-a-run.jsonl"), "ignore me", "utf8");

    await expect(listRunIds(world)).resolves.toEqual(["run_a", "run_b"]);
  });

  it("returns an empty list when the event directory does not exist", async () => {
    const world = await tempWorld();
    await mkdir(world.dataDir, { recursive: true });

    await expect(listRunIds(world)).resolves.toEqual([]);
  });
});
