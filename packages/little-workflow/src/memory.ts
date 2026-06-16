import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocalWorld, MemoryConfig } from "./authoring.js";
import { sha256Digest } from "./canonical.js";

export type MemoryAccessMode = "rw" | "ro";

export type WorkflowMemorySnapshot = {
  readonly id: string;
  readonly [key: string]: unknown;
};

export type MemoryMount = {
  readonly storeId: string;
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: MemoryAccessMode;
};

/**
 * Create the backing directories for memory mounts so the harness bash tool can
 * resolve and access them. Memory stores are advertised to the model in the
 * system prompt; without the directory on disk, any bash access (even an `ls`)
 * fails with ENOENT during path validation. Both rw and ro mounts are created —
 * an empty store is a valid, just-initialized store.
 */
export async function ensureMemoryMounts(
  mounts: readonly MemoryMount[],
): Promise<void> {
  await Promise.all(
    mounts.map((mount) => mkdir(mount.backingPath, { recursive: true })),
  );
}

export function workflowMemoryMounts(options: {
  readonly world: LocalWorld;
  readonly workflowId: string;
  readonly memory?: MemoryConfig;
}): readonly MemoryMount[] {
  const workflowId = memoryStoreKey(options.workflowId);
  const mounts: MemoryMount[] = [];
  const workflowMode = options.memory?.workflow ?? "rw";
  const orgMode = options.memory?.org ?? "ro";

  if (workflowMode !== "none") {
    mounts.push({
      storeId: workflowStoreId(workflowId),
      mountPath: "/mnt/memory/workflow/",
      backingPath: workflowMemoryPath(options.world, workflowId),
      mode: workflowMode,
    });
  }

  if (orgMode !== "none") {
    mounts.push(orgMemoryMount(options.world, orgMode));
  }

  const attached = uniqueMemoryKeys(
    options.memory?.attach ?? [],
    (attachment) => attachment.id,
    "attached workflow",
  ).sort((left, right) => left.key.localeCompare(right.key));
  for (const attachment of attached) {
    const attachedId = attachment.key;
    mounts.push({
      storeId: workflowStoreId(attachedId),
      mountPath: `/mnt/memory/peer-workflows/${attachedId}/`,
      backingPath: workflowMemoryPath(options.world, attachedId),
      mode: "ro",
    });
  }

  return mounts;
}

export function pipelineMemoryMounts(options: {
  readonly world: LocalWorld;
  readonly workflowDefinitionHashes: readonly string[];
  readonly mode?: MemoryAccessMode;
  readonly includeOrg?: boolean;
}): readonly MemoryMount[] {
  const pipelineKey = pipelineKeyForWorkflowDefinitions(options.workflowDefinitionHashes);
  const mounts: MemoryMount[] = [
    {
      storeId: `pipeline:${pipelineKey}`,
      mountPath: "/mnt/memory/pipeline/",
      backingPath: join(options.world.dataDir, "memory", "pipelines", pipelineKey),
      mode: options.mode ?? "rw",
    },
  ];
  if (options.includeOrg ?? true) {
    mounts.push(orgMemoryMount(options.world, "ro"));
  }
  return mounts;
}

export function orchestratorAvailableWorkflowMemoryMounts(options: {
  readonly world: LocalWorld;
  readonly workflows: readonly WorkflowMemorySnapshot[];
}): readonly MemoryMount[] {
  return uniqueMemoryKeys(options.workflows, (workflow) => workflow.id, "available workflow")
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((workflow) => {
      const workflowId = workflow.key;
      return {
        storeId: workflowStoreId(workflowId),
        mountPath: `/mnt/memory/available-workflows/${workflowId}/`,
        backingPath: workflowMemoryPath(options.world, workflowId),
        mode: "ro",
      };
    });
}

export function pipelineKeyForWorkflowDefinitions(hashes: readonly string[]): string {
  return sha256Digest([...hashes].sort());
}

function orgMemoryMount(world: LocalWorld, mode: MemoryAccessMode): MemoryMount {
  return {
    storeId: "org",
    mountPath: "/mnt/memory/org/",
    backingPath: join(world.dataDir, "memory", "org"),
    mode,
  };
}

function workflowStoreId(workflowId: string): string {
  return `workflow:${workflowId}`;
}

function workflowMemoryPath(world: LocalWorld, workflowId: string): string {
  return join(world.dataDir, "memory", "workflows", workflowId);
}

function uniqueMemoryKeys<T extends object>(
  values: readonly T[],
  idFor: (value: T) => string,
  label: string,
): Array<T & { readonly key: string }> {
  const seen = new Set<string>();
  return values.map((value) => {
    const key = memoryStoreKey(idFor(value));
    if (seen.has(key)) {
      throw new TypeError(`Duplicate ${label} memory key: ${key}.`);
    }
    seen.add(key);
    return { ...value, key };
  });
}

function memoryStoreKey(id: string): string {
  const sanitized = asciiLowercase(id)
    .replace(/[/.:_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (sanitized.length === 0) {
    throw new TypeError("Memory store id must contain at least one ASCII letter or number.");
  }
  return sanitized;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
