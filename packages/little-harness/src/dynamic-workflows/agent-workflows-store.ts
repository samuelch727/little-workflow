import type { AgentWorkflowRecord } from "./types.js";

export type { AgentWorkflowRecord } from "./types.js";

type FilesLike = {
  writeText(path: string, text: string): Promise<unknown>;
  read(path: string): Promise<{ text(): string }>;
  list(
    path: string,
  ): Promise<readonly { readonly path: string; readonly kind?: "file" | "directory" }[]>;
};

function workflowsPrefix(harnessDir: string): string {
  return `${harnessDir}/workflows/`;
}

function currentPath(harnessDir: string, handle: string): string {
  return `${workflowsPrefix(harnessDir)}${handle}.json`;
}

function revisionPath(harnessDir: string, handle: string, revision: number): string {
  return `${historyPrefix(harnessDir)}${handle}.r${revision}.json`;
}

function historyPrefix(harnessDir: string): string {
  return `${workflowsPrefix(harnessDir)}history/`;
}

/**
 * Store a revision: `workflows/<handle>.json` is the current definition, and every revision is
 * also kept as `workflows/history/<handle>.r<revision>.json`.
 */
export async function writeAgentWorkflow(
  files: FilesLike,
  harnessDir: string,
  record: AgentWorkflowRecord,
): Promise<void> {
  const text = JSON.stringify(record, null, 2);
  await files.writeText(revisionPath(harnessDir, record.handle, record.revision), text);
  await files.writeText(currentPath(harnessDir, record.handle), text);
}

/**
 * The revision the next `define_workflow` call for `handle` writes: one more than the highest kept
 * in `history/` or in the current definition, so a current file that cannot be read never makes a
 * new definition overwrite an earlier revision.
 */
export async function nextAgentWorkflowRevision(
  files: FilesLike,
  harnessDir: string,
  handle: string,
  storedRevision = 0,
): Promise<number> {
  let entries: readonly { readonly path: string }[];
  try {
    entries = await files.list(historyPrefix(harnessDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  let highest = storedRevision;
  for (const entry of entries) {
    // A handle is `[A-Za-z0-9_]+`, so `<handle>.r` never matches another handle's revisions.
    const name = entry.path.split("/").at(-1) ?? "";
    if (!name.startsWith(`${handle}.r`) || !name.endsWith(".json")) continue;
    const revision = Number(name.slice(handle.length + 2, -".json".length));
    if (Number.isSafeInteger(revision) && revision > highest) highest = revision;
  }
  return highest + 1;
}

/** The current definition of every agent-defined workflow, by handle. Unreadable files are skipped. */
export async function readAgentWorkflows(
  files: FilesLike,
  harnessDir: string,
): Promise<readonly AgentWorkflowRecord[]> {
  let entries: readonly { readonly path: string; readonly kind?: "file" | "directory" }[];
  try {
    entries = await files.list(workflowsPrefix(harnessDir));
  } catch (error) {
    // No workflow defined yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = workflowsPrefix(harnessDir);
  const records: AgentWorkflowRecord[] = [];
  for (const entry of entries) {
    // Current definitions only: `history/` holds every earlier revision.
    const name = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path.split("/").at(-1) ?? "";
    if (entry.kind === "directory" || name.includes("/") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse((await files.read(entry.path)).text()) as unknown;
      if (isAgentWorkflowRecord(record)) records.push(record);
    } catch {
      // A corrupt file must not take every other workflow down with it.
    }
  }
  return records.sort((a, b) => a.handle.localeCompare(b.handle));
}

function isAgentWorkflowRecord(value: unknown): value is AgentWorkflowRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.handle === "string" &&
    typeof record.description === "string" &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 1 &&
    isStringArray(record.tools) &&
    (record.policy === undefined || typeof record.policy === "string") &&
    (record.models === undefined || isStringArray(record.models))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
