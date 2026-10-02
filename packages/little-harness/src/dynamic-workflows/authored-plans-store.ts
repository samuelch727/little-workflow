import { localDir, type LocalDirSource } from "../local-host/local-dir.js";
import { canonicalizePersistentHarnessDir } from "../memory/memory.js";
import type { PersistentDir } from "../types.js";

/**
 * Mount point for the durable authored-plans store. Lives under `/persistent/...` so that,
 * once registered as a Persistent Dir (see {@link authoredPlansPersistentDir}), writes survive
 * across runs and are recallable by later harnesses that share the same host data dir.
 */
export const AUTHORED_PLANS_HARNESS_DIR = "/persistent/dynamic-plans";

/**
 * Folder name (relative to the Local Host `dataDir`) that backs {@link AUTHORED_PLANS_HARNESS_DIR}.
 * A constant, run-independent path so that two harnesses sharing a `dataDir` recall each other's
 * authored plans (proven by Task 12's two-harness recall test).
 */
export const AUTHORED_PLANS_SOURCE_DIR = "dynamic-plans";

export type AuthoredPlanRecord = {
  readonly runId: string;
  readonly purpose: string;
  readonly reason?: string;
  readonly plan: unknown;
  readonly definitionHash: string;
  readonly capabilitySnapshot: unknown;
  readonly outputSchema: unknown;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly outputSummary?: string;
  readonly createdAt: string;
  readonly steps: number;
};

/**
 * The subset of the harness `FileWriter` surface (`types.ts` — `writeText`/`read`/`list`) that the
 * store depends on. Kept structurally assignable from the real `FileWriter`: `read` resolves to a
 * `FileData` (whose `.text()` yields the UTF-8 body) and `list` resolves to `FileEntry[]` whose
 * `.path` is the full, directly-readable harness path.
 */
type FilesLike = {
  writeText(path: string, text: string): Promise<unknown>;
  read(path: string): Promise<{ text(): string }>;
  list(
    path: string,
  ): Promise<readonly { readonly path: string; readonly kind?: "file" | "directory" }[]>;
};

function plansPrefix(harnessDir: string): string {
  return `${harnessDir}/plans/`;
}

function planPath(harnessDir: string, runId: string): string {
  return `${plansPrefix(harnessDir)}${runId}.json`;
}

/**
 * Persist a single authored one-shot plan as `plans/<runId>.json`. Writing the same `runId` again
 * overwrites in place (e.g. transitioning `running` → `completed`), so each run has exactly one record.
 */
export async function writeAuthoredPlan(
  files: FilesLike,
  harnessDir: string,
  record: AuthoredPlanRecord,
): Promise<void> {
  await files.writeText(planPath(harnessDir, record.runId), JSON.stringify(record, null, 2));
}

/**
 * Recall authored plans whose `purpose` contains `query` (case-insensitive substring). Successful
 * plans (`status === "completed"`) sort first so callers prefer proven prior work. An empty/whitespace
 * query returns every stored record.
 */
export async function searchAuthoredPlans(
  files: FilesLike,
  harnessDir: string,
  query: string,
): Promise<readonly AuthoredPlanRecord[]> {
  const prefix = plansPrefix(harnessDir);
  let entries: readonly { readonly path: string; readonly kind?: "file" | "directory" }[];
  try {
    entries = await files.list(prefix);
  } catch (error) {
    // The plans directory may not exist yet (no plan authored). Treat as empty rather than throw.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: AuthoredPlanRecord[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      continue;
    }
    try {
      const text = (await files.read(entry.path)).text();
      const parsed = JSON.parse(text) as { purpose?: unknown; status?: unknown };
      // Skip shape-invalid records: without these a bogus file (e.g. `null` or `{purpose: 5}`)
      // would throw inside the filter/sort below and break ALL recall.
      if (typeof parsed?.purpose === "string" && typeof parsed?.status === "string") {
        records.push(parsed as AuthoredPlanRecord);
      }
    } catch {
      // Skip unreadable or corrupt records rather than failing the whole search.
    }
  }

  const q = query.trim().toLowerCase();
  const matched =
    q.length === 0 ? records : records.filter((r) => r.purpose.toLowerCase().includes(q));
  // Completed-first ordering so callers prefer proven prior work, then cap the payload to a
  // sane, model-friendly ceiling.
  return matched
    .sort((a, b) => Number(b.status === "completed") - Number(a.status === "completed"))
    .slice(0, 10);
}

/**
 * Register {@link AUTHORED_PLANS_HARNESS_DIR} as a Persistent Dir so that plans written through the
 * harness `FileWriter` are committed to disk and survive across runs. Mirrors `memoryLocalDir`: it
 * backs the harness mount with a {@link localDir} under the Local Host `dataDir`, committing
 * `after-turn`. The `dataDir` is supplied per-turn by the host via `sessionHostPaths` (not the
 * `HarnessHost` object, which carries no data dir), so the factory needs no host argument.
 *
 * Compose it like memory's dirs — add the result to `createHarness({ persistentDirs: [...] })`.
 */
export function authoredPlansPersistentDir<TExtraBody = unknown>(
  options: {
    readonly sourceDir?: LocalDirSource<TExtraBody>;
    readonly commit?: "after-turn" | "manual" | "read-only";
  } = {},
): PersistentDir<TExtraBody> {
  return localDir<TExtraBody>({
    harnessDir: canonicalizePersistentHarnessDir(AUTHORED_PLANS_HARNESS_DIR),
    sourceDir: options.sourceDir ?? AUTHORED_PLANS_SOURCE_DIR,
    commit: options.commit ?? "after-turn",
  });
}
