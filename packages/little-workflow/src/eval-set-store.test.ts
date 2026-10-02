import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  EVAL_ITEM_API_VERSION,
  EVAL_SET_API_VERSION,
  evalItemBodySha,
  evalItemSha,
  registerEvalItemBody,
  registerEvalSet,
  type EvalItemBody,
  type EvalSetVersion,
  type PiiPolicy,
} from "./eval-set.js";
import {
  checkStoredEvalSetLineage,
  EvalItemBodyIntegrityError,
  EvalSetStoreConflictError,
  listKnownEvalSetLineages,
  listStoredEvalSetIds,
  readStoredEvalItemBody,
  readStoredEvalSet,
  registerStoredEvalItemBody,
  registerStoredEvalSet,
  registerStoredEvalSetWithLineageCheck,
} from "./eval-set-store.js";
import { localWorld, registerWorkflowVersion, WorldPathError, type LwirWorkflow } from "./index.js";
import { LWIR_INPUT_CONE_ALGORITHM } from "./lwir-input-cone.js";
import { registerStoredWorkflowVersion } from "./workflow-version-store.js";

type Record_ = Record<string, unknown>;

const SEAL_KEY_ID = `hmac-sha256-id:${sha256Digest("seal-key").slice("sha256:".length)}`;
const SYNTHETIC: PiiPolicy = { status: "synthetic", retentionClass: "evidence-5y" };
const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-eval-set-store-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function body(overrides: Record_ = {}): EvalItemBody {
  return {
    apiVersion: EVAL_ITEM_API_VERSION,
    kind: "EvalItem",
    target: "summarize",
    input: { kind: "inline", value: { ticket: "the printer is on fire" } },
    label: { provenance: "human_labeled", value: { severity: "high" } },
    rubric: [{ criterionId: "names-severity", expected: true }],
    provenance: [{ runId: "run_a", sequence: 3 }],
    ...overrides,
  } as EvalItemBody;
}

function entryFor(item: EvalItemBody): Record_ {
  return {
    itemSha: evalItemSha(item),
    bodySha: evalItemBodySha(item),
    target: item.target,
    role: "gate",
    replayValidity: "pure",
    labelProvenance: item.label.provenance,
    clusterId: "trace-1",
    referencedFields: ["$.output.severity"],
    inputConeHash: sha256Digest("cone"),
    inputConeAlgorithm: LWIR_INPUT_CONE_ALGORITHM,
    createdAt: "2026-08-01T09:00:00Z",
  };
}

function bundleOf(cardOverrides: Record_ = {}, items: readonly EvalItemBody[] = [body()]): Record_ {
  return {
    apiVersion: EVAL_SET_API_VERSION,
    kind: "EvalSet",
    manifest: {
      metadata: { name: "support.summarize.gate", createdAt: "2026-08-01T09:00:00Z" },
      workflowName: "support.summarize",
      workflowLwirSha: sha256Digest("lwir"),
      constructs: [
        {
          target: "summarize",
          passCriterion: "The summary names the severity.",
          criteria: [{ id: "names-severity", text: "Severity is stated explicitly." }],
          resampleK: 3,
          authoredAt: "2026-07-30T12:00:00Z",
        },
      ],
      sampling: { strategy: "stratified", strata: [{ id: "p1", definition: "p=1", count: 40 }] },
      sealPolicy: {
        algorithm: "HMAC-SHA256",
        sealKeyId: SEAL_KEY_ID,
        custody: "dev_local",
        cutoff: "9223372036854775808",
        domain: "evalset-seal/v1/support.summarize",
      },
      desiderata: {
        difficultyBand: { targetLow: "0.30", targetHigh: "0.70", achieved: "0.52" },
        coverage: { target: "0.90", achieved: "0.93", basis: "contract fields" },
        diversityClusters: { target: 20, achieved: 24 },
      },
      generation: {
        candidatesGenerated: 210,
        admitted: 100,
        rejectedByStage: [{ stage: "dedup", count: 60 }],
        authorModel: { providerId: "deepseek", modelId: "deepseek-chat", family: "deepseek" },
      },
      audit: {
        nAudited: 30,
        raters: [{ ref: "rater-7", kind: "human" }],
        labelErrorEstimate: { point: "0.04", ciLow: "0.01", ciHigh: "0.09" },
      },
      judge: {
        modelPin: { providerId: "anthropic", modelId: "judge-1", family: "claude" },
        rubricSha: sha256Digest("rubric"),
        calibrationSetSha: sha256Digest("calibration"),
        tpr: "0.93",
        tnr: "0.88",
      },
      independence: {
        evalAuthorFamily: "claude",
        workflowAuthorFamily: "deepseek",
        distinct: true,
      },
      noiseFloor: {
        method: "incumbent_rerun",
        runs: 5,
        deltaPpP50: "0.4",
        deltaPpP95: "1.9",
        measuredAt: "2026-07-31T18:00:00Z",
      },
      canaryGuid: "canary-3f9a1c2b4d5e6f70",
      lifecycle: {
        refresh: { policy: "rotate_fraction", numerator: 1, denominator: 6, cadence: "P30D" },
        gateQueryBudget: 12,
      },
      pii: SYNTHETIC,
      ...cardOverrides,
    },
    index: [...items]
      .map((item) => entryFor(item))
      .sort((left, right) => (String(left.itemSha) < String(right.itemSha) ? -1 : 1)),
  };
}

function lwir(name: string): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name, version: "0.1.0-alpha" },
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
  };
}

describe("eval set bundle store", () => {
  it("persists and reads a bundle as canonical JSON at its content-addressed id", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());

    await registerStoredEvalSet(world, version);

    await expect(readStoredEvalSet(world, version.id)).resolves.toEqual(version);
    await expect(
      readFile(join(world.dataDir, "eval-sets", `${version.id}.json`), "utf8"),
    ).resolves.toBe(`${canonicalJson(version)}\n`);
    await expect(listStoredEvalSetIds(world)).resolves.toEqual([version.id]);
  });

  it("is idempotent for identical bytes and conflicts on differing bytes", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());
    const conflicting: EvalSetVersion = {
      ...version,
      bundle: { ...version.bundle, index: [] },
    };

    await registerStoredEvalSet(world, version);
    await expect(registerStoredEvalSet(world, version)).resolves.toBeUndefined();
    await expect(registerStoredEvalSet(world, conflicting)).rejects.toBeInstanceOf(
      EvalSetStoreConflictError,
    );
    await expect(readStoredEvalSet(world, version.id)).resolves.toEqual(version);
  });

  it("allows concurrent identical registrations", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());

    await expect(
      Promise.all(Array.from({ length: 50 }, () => registerStoredEvalSet(world, version))),
    ).resolves.toHaveLength(50);
    await expect(
      readFile(join(world.dataDir, "eval-sets", `${version.id}.json`), "utf8"),
    ).resolves.toBe(`${canonicalJson(version)}\n`);
  });

  it("rejects concurrent conflicting registrations without mutating the stored bundle", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());
    const conflicting: EvalSetVersion = {
      ...version,
      bundle: { ...version.bundle, index: [] },
    };

    const results = await Promise.allSettled([
      registerStoredEvalSet(world, version),
      registerStoredEvalSet(world, conflicting),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(EvalSetStoreConflictError),
    });
    await expect(readStoredEvalSet(world, version.id)).resolves.toEqual(version);
  });

  it("rejects unsafe ids rather than joining them into a path", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());

    await expect(
      registerStoredEvalSet(world, { ...version, id: "evset_../../escape" }),
    ).rejects.toBeInstanceOf(WorldPathError);
    await expect(readStoredEvalSet(world, "bad")).rejects.toBeInstanceOf(WorldPathError);
  });
});

describe("eval item body store", () => {
  it("addresses a body by its bodySha and verifies it on read", async () => {
    const world = await tempWorld();
    const registered = registerEvalItemBody(body(), { pii: SYNTHETIC });
    const hex = registered.bodySha.slice("sha256:".length);

    await registerStoredEvalItemBody(world, registered);

    await expect(readStoredEvalItemBody(world, registered.bodySha)).resolves.toEqual(
      registered.body,
    );
    await expect(
      readFile(join(world.dataDir, "eval-items", hex.slice(0, 2), `${hex}.json`), "utf8"),
    ).resolves.toBe(`${registered.canonicalJson}\n`);
  });

  it("holds two bodies that share an itemSha but differ in provenance", async () => {
    const world = await tempWorld();
    const fromTraceA = registerEvalItemBody(body({ provenance: [{ runId: "run_a", sequence: 3 }] }), {
      pii: SYNTHETIC,
    });
    const fromTraceB = registerEvalItemBody(
      body({ provenance: [{ runId: "run_b", sequence: 41 }] }),
      { pii: SYNTHETIC },
    );

    expect(fromTraceA.itemSha).toBe(fromTraceB.itemSha);
    expect(fromTraceA.bodySha).not.toBe(fromTraceB.bodySha);

    await registerStoredEvalItemBody(world, fromTraceA);
    await registerStoredEvalItemBody(world, fromTraceB);

    await expect(readStoredEvalItemBody(world, fromTraceA.bodySha)).resolves.toEqual(
      fromTraceA.body,
    );
    await expect(readStoredEvalItemBody(world, fromTraceB.bodySha)).resolves.toEqual(
      fromTraceB.body,
    );
  });

  it("is idempotent for identical bodies and detects a tampered file", async () => {
    const world = await tempWorld();
    const registered = registerEvalItemBody(body(), { pii: SYNTHETIC });
    const hex = registered.bodySha.slice("sha256:".length);
    const path = join(world.dataDir, "eval-items", hex.slice(0, 2), `${hex}.json`);

    await registerStoredEvalItemBody(world, registered);
    await expect(registerStoredEvalItemBody(world, registered)).resolves.toBeUndefined();

    await rm(path);
    await writeFile(path, `${canonicalJson({ ...registered.body, target: "classify" })}\n`, "utf8");

    await expect(readStoredEvalItemBody(world, registered.bodySha)).rejects.toBeInstanceOf(
      EvalItemBodyIntegrityError,
    );
  });

  it("rejects a digest that is not a sha256 address", async () => {
    const world = await tempWorld();

    for (const digest of ["../../escape", "sha256:zz", "deadbeef", "sha256:"]) {
      await expect(readStoredEvalItemBody(world, digest)).rejects.toBeInstanceOf(WorldPathError);
    }
  });
});

describe("eval set store durability", () => {
  it("survives a process killed the instant the write returns", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());
    const versionPath = join(world.dataDir, "version.json");
    await writeFile(versionPath, JSON.stringify(version), "utf8");

    const result = await runCrashChild(world.dataDir, versionPath);

    // SIGKILL: no unwinding, no flush, no graceful exit path ran.
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBeNull();
    await expect(
      readFile(join(world.dataDir, "eval-sets", `${version.id}.json`), "utf8"),
    ).resolves.toBe(`${canonicalJson(version)}\n`);
    await expect(readStoredEvalSet(world, version.id)).resolves.toEqual(version);
    expect(await tempFilesIn(join(world.dataDir, "eval-sets"))).toEqual([]);
  });

  it("never exposes the residue of a write that crashed before link()", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());
    const directory = join(world.dataDir, "eval-sets");
    const path = join(directory, `${version.id}.json`);

    // Exactly what a crash between writeFileDurably() and link() leaves behind: a complete or
    // partial temp file, and no entry at the final path.
    await registerStoredEvalSet(world, registerEvalSet(bundleOf({ canaryGuid: "canary-other-1" })));
    await writeFile(`${path}.999.crashed.tmp`, canonicalJson(version).slice(0, 40), "utf8");

    await expect(readStoredEvalSet(world, version.id)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listStoredEvalSetIds(world)).not.toContain(version.id);

    await registerStoredEvalSet(world, version);

    await expect(readFile(path, "utf8")).resolves.toBe(`${canonicalJson(version)}\n`);
    await expect(readStoredEvalSet(world, version.id)).resolves.toEqual(version);
  });
});

describe("eval set lineage warnings", () => {
  it("warns the first time a lineage is seen and stays quiet afterwards", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());

    const first = await registerStoredEvalSetWithLineageCheck(world, version);

    expect(first.map((finding) => finding.code)).toEqual(["evalset.unknown_lineage"]);
    expect(first[0]?.severity).toBe("warning");
    expect(first[0]?.message).toContain("renamed");

    const second = registerEvalSet(bundleOf({ canaryGuid: "canary-second-set-1" }));
    await expect(checkStoredEvalSetLineage(world, second)).resolves.toEqual([]);
    await expect(listKnownEvalSetLineages(world)).resolves.toEqual(new Set(["support.summarize"]));
  });

  it("treats a stored workflow version as an existing lineage", async () => {
    const world = await tempWorld();
    await registerStoredWorkflowVersion(world, registerWorkflowVersion(lwir("support.summarize")));

    await expect(checkStoredEvalSetLineage(world, registerEvalSet(bundleOf()))).resolves.toEqual([]);
  });

  it("catches a rename: the pinned workflow version is stored under a different name", async () => {
    const world = await tempWorld();
    const workflowVersion = registerWorkflowVersion(lwir("support.summarize"));
    await registerStoredWorkflowVersion(world, workflowVersion);
    const renamed = registerEvalSet(
      bundleOf({ workflowName: "support.triage", workflowLwirSha: workflowVersion.hash }),
    );

    const findings = await checkStoredEvalSetLineage(world, renamed);

    expect(findings.map((finding) => finding.code)).toEqual([
      "evalset.unknown_lineage",
      "evalset.lineage_workflow_mismatch",
    ]);
    expect(findings[1]?.message).toContain("support.summarize");
    expect(findings.every((finding) => finding.severity === "warning")).toBe(true);
  });

  it("checks the lineage before writing, so a bundle cannot vouch for itself", async () => {
    const world = await tempWorld();
    const version = registerEvalSet(bundleOf());

    await registerStoredEvalSet(world, version);
    // Registered first: now the corpus does know the lineage, and the same check is silent.
    await expect(checkStoredEvalSetLineage(world, version)).resolves.toEqual([]);
  });
});

async function tempFilesIn(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

/**
 * Register a bundle in a child process that SIGKILLs itself the moment the write resolves. Nothing
 * downstream of `registerStoredEvalSet` runs — no flush, no exit handler — so what the parent then
 * reads is what the fsync/link sequence actually committed.
 */
async function runCrashChild(
  dataDir: string,
  versionPath: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const loaderPath = join(dataDir, "ts-src-loader.mjs");
  const scriptPath = join(dataDir, "register-and-die.mjs");
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
import { readFile } from "node:fs/promises";
import { registerStoredEvalSet } from ${
      JSON.stringify(new URL("./eval-set-store.ts", import.meta.url).href)
    };

const [dataDir, versionPath] = process.argv.slice(2);
const version = JSON.parse(await readFile(versionPath, "utf8"));
await registerStoredEvalSet({ dataDir }, version);
process.kill(process.pid, "SIGKILL");
`,
    "utf8",
  );

  const child = spawn(
    process.execPath,
    ["--experimental-loader", loaderPath, scriptPath, dataDir, versionPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`crash child exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });
}
