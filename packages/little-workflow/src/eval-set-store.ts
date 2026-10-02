/**
 * Local content-addressed store for eval-set bundles and item bodies.
 *
 * Local is the source of truth. A control plane holds the manifest, the index projection and the
 * mutable state and is only the query surface; item bodies never have to leave the machine that
 * authored them. This module is that truth.
 *
 * ## The write pattern, copied not reinvented
 *
 * Every write is `temp file → fsync(file) → link() → fsync(dir)`, with an `EEXIST` compare that
 * makes a re-write of identical bytes a no-op and a re-write of different bytes a typed conflict.
 * This is `workflow-version-store.ts` verbatim, for the same reasons:
 *
 *   - `link()` is atomic, so the final path never holds a partially written file — a reader either
 *     sees nothing or sees the whole thing, with no torn-read window and no lock;
 *   - the file is fsynced *before* it is linked and the directory is fsynced *after*, so a crash
 *     cannot leave a name pointing at unflushed bytes;
 *   - `EEXIST` is not an error condition, it is the idempotency path: re-registering the same
 *     content-addressed object is expected and must succeed silently;
 *   - a per-path in-process write chain serialises concurrent writers in this process, and the
 *     `EEXIST` compare handles the ones in other processes.
 *
 * ## Two addresses, and why bodies are keyed by `bodySha`
 *
 * - bundles: `<dataDir>/eval-sets/<evset_id>.json`
 * - bodies: `<dataDir>/eval-items/<first 2 hex of bodySha>/<bodySha hex>.json`
 *
 * Bodies are addressed by `bodySha`, **not** by `itemSha`. Two bodies can share an `itemSha` and
 * differ — that is the whole point of the identity/integrity split: the same item mined from two
 * different traces has one identity and two provenances. An `itemSha`-keyed store would have to
 * declare that legal pair a conflict and refuse to hold both. `bodySha` is the hash of the bytes
 * actually being stored, which is what "content-addressed" means; `itemSha` is an identity used for
 * dedup, role disjointness and seal membership, and the bundle's index is what maps one to the
 * other.
 *
 * A stored body file is exactly `canonicalJson(body) + "\n"`, so its address is verifiable from its
 * own bytes by anything that can compute sha256 over the canonical form — including a verifier that
 * is not JavaScript. {@link readStoredEvalItemBody} re-verifies on every read.
 *
 * This is deliberately not `writeArtifact`: an artifact requires a `runId`, and an eval set is not
 * run-scoped.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LocalWorld } from "./authoring.js";
import { canonicalJson, sha256Digest } from "./canonical.js";
import type {
  EvalItemBody,
  EvalSetValidationFinding,
  EvalSetVersion,
  RegisteredEvalItemBody,
} from "./eval-set.js";
import { readStoredWorkflowVersion } from "./workflow-version-store.js";
import { WorldPathError } from "./world.js";

const EVAL_SET_ID_PATTERN = /^evset_[A-Za-z0-9_-]{1,80}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_PREFIX = "sha256:";
const EVAL_SETS_DIRECTORY = "eval-sets";
const EVAL_ITEMS_DIRECTORY = "eval-items";

const writeChains = new Map<string, Promise<unknown>>();

export class EvalSetStoreConflictError extends Error {
  readonly address: string;

  constructor(address: string) {
    super(`Stored eval set conflict for address: ${address}`);
    this.name = "EvalSetStoreConflictError";
    this.address = address;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EvalItemBodyIntegrityError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Stored eval item body hashes to ${actual}, not to its address ${expected}.`);
    this.name = "EvalItemBodyIntegrityError";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Persist a registered eval-set bundle. Idempotent for identical bytes; throws
 * {@link EvalSetStoreConflictError} when the same id already holds different bytes (which, for a
 * content-addressed id, means a hash collision or a hand-edited file).
 */
export async function registerStoredEvalSet(
  world: LocalWorld,
  version: EvalSetVersion,
): Promise<void> {
  validateEvalSetId(version.id);
  const directory = join(world.dataDir, EVAL_SETS_DIRECTORY);
  await writeOnce(directory, evalSetPath(world, version.id), `${canonicalJson(version)}\n`, version.id);
}

export async function readStoredEvalSet(
  world: LocalWorld,
  evalSetId: string,
): Promise<EvalSetVersion> {
  return JSON.parse(await readFile(evalSetPath(world, evalSetId), "utf8")) as EvalSetVersion;
}

/** Ids of every locally stored eval set, in directory order. */
export async function listStoredEvalSetIds(world: LocalWorld): Promise<readonly string[]> {
  const entries = await readdirIfPresent(join(world.dataDir, EVAL_SETS_DIRECTORY));
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((id) => EVAL_SET_ID_PATTERN.test(id));
}

/**
 * Persist an item body at its `bodySha` address. Idempotent for identical bytes.
 *
 * The stored bytes are the canonical body itself, so the file verifies against its own address.
 */
export async function registerStoredEvalItemBody(
  world: LocalWorld,
  registered: RegisteredEvalItemBody,
): Promise<void> {
  const hex = digestHex(registered.bodySha);
  const directory = join(world.dataDir, EVAL_ITEMS_DIRECTORY, hex.slice(0, 2));
  await writeOnce(
    directory,
    evalItemBodyPath(world, registered.bodySha),
    `${registered.canonicalJson}\n`,
    registered.bodySha,
  );
}

/** Read a body by its `bodySha` address, re-verifying the hash before handing it back. */
export async function readStoredEvalItemBody(
  world: LocalWorld,
  bodySha: string,
): Promise<EvalItemBody> {
  const contents = await readFile(evalItemBodyPath(world, bodySha), "utf8");
  const body = JSON.parse(contents) as EvalItemBody;
  const actual = sha256Digest(body);
  if (actual !== bodySha) {
    throw new EvalItemBodyIntegrityError(bodySha, actual);
  }
  return body;
}

/**
 * Every workflow lineage the local corpus has seen: the `workflowName` of each stored eval set, plus
 * the `metadata.name` of each stored workflow version.
 *
 * Both halves matter. Eval sets answer "has this lineage ever been evaluated"; workflow versions
 * answer "does this lineage exist at all", which is what distinguishes a first eval set for a real
 * workflow from an eval set authored against a name that nothing else in the repo knows.
 */
export async function listKnownEvalSetLineages(world: LocalWorld): Promise<ReadonlySet<string>> {
  const lineages = new Set<string>();
  for (const id of await listStoredEvalSetIds(world)) {
    try {
      const stored = await readStoredEvalSet(world, id);
      const name = stored.bundle?.manifest?.workflowName;
      if (typeof name === "string" && name.length > 0) {
        lineages.add(name);
      }
    } catch {
      // A file we cannot read cannot establish a lineage. Skip it rather than fail registration.
    }
  }
  for (const name of await listStoredWorkflowNames(world)) {
    lineages.add(name);
  }
  return lineages;
}

/**
 * The lineage check, as findings rather than exceptions.
 *
 * A lineage is `(project, workflowName)`, so renaming a workflow silently starts a *new* lineage and
 * orphans every eval set authored under the old name. Nothing local can distinguish that from a
 * genuinely new workflow, so both produce a **warning**, never an error — but a warning that names
 * the lineages already on disk, which is enough for the author to spot a rename or a typo.
 *
 * Two findings:
 *
 * - `evalset.unknown_lineage` — no stored eval set and no stored workflow version carries this name.
 * - `evalset.lineage_workflow_mismatch` — the LWIR this bundle pins *is* stored locally and its
 *   `metadata.name` is something else. That is the rename, caught red-handed.
 */
export async function checkStoredEvalSetLineage(
  world: LocalWorld,
  version: EvalSetVersion,
): Promise<readonly EvalSetValidationFinding[]> {
  const findings: EvalSetValidationFinding[] = [];
  const workflowName = version.bundle?.manifest?.workflowName;
  if (typeof workflowName !== "string" || workflowName.length === 0) {
    return findings;
  }

  const known = await listKnownEvalSetLineages(world);
  if (!known.has(workflowName)) {
    findings.push({
      severity: "warning",
      code: "evalset.unknown_lineage",
      path: "$.manifest.workflowName",
      message: `Lineage '${workflowName}' has not been seen in ${world.dataDir}${
        known.size === 0 ? "" : ` (known: ${[...known].sort().join(", ")})`
      }. If this workflow was renamed, its existing eval sets are now orphaned under the old name — migrate them rather than starting a new lineage.`,
    });
  }

  const pinnedName = await storedWorkflowNameFor(world, version.bundle.manifest.workflowLwirSha);
  if (pinnedName !== undefined && pinnedName !== workflowName) {
    findings.push({
      severity: "warning",
      code: "evalset.lineage_workflow_mismatch",
      path: "$.manifest.workflowName",
      message: `This bundle declares lineage '${workflowName}' but the workflow version it pins (${version.bundle.manifest.workflowLwirSha}) is stored locally under the name '${pinnedName}'. The workflow was renamed: eval sets under '${pinnedName}' will not be found by a lineage query for '${workflowName}'.`,
    });
  }

  return findings;
}

/**
 * Check the lineage, then store the bundle. Returns the lineage warnings so the caller decides what
 * to do with them — this never prints and never throws on a warning.
 *
 * The check runs *before* the write, so a bundle cannot make its own lineage look known.
 */
export async function registerStoredEvalSetWithLineageCheck(
  world: LocalWorld,
  version: EvalSetVersion,
): Promise<readonly EvalSetValidationFinding[]> {
  const warnings = await checkStoredEvalSetLineage(world, version);
  await registerStoredEvalSet(world, version);
  return warnings;
}

// ───────────────────────────────────── paths and I/O ─────────────────────────────────────

function evalSetPath(world: LocalWorld, evalSetId: string): string {
  validateEvalSetId(evalSetId);
  return join(world.dataDir, EVAL_SETS_DIRECTORY, `${evalSetId}.json`);
}

function evalItemBodyPath(world: LocalWorld, bodySha: string): string {
  const hex = digestHex(bodySha);
  return join(world.dataDir, EVAL_ITEMS_DIRECTORY, hex.slice(0, 2), `${hex}.json`);
}

function validateEvalSetId(evalSetId: string): void {
  if (typeof evalSetId !== "string" || !EVAL_SET_ID_PATTERN.test(evalSetId)) {
    throw new WorldPathError(`Invalid eval set id: ${String(evalSetId)}`);
  }
}

/**
 * `sha256:<hex>` in, bare `<hex>` out — a colon is not a path character on every filesystem, and the
 * pattern check is what keeps `..` out of a joined path.
 */
function digestHex(digest: string): string {
  if (typeof digest !== "string" || !digest.startsWith(SHA256_PREFIX)) {
    throw new WorldPathError(`Invalid eval item body digest: ${String(digest)}`);
  }
  const hex = digest.slice(SHA256_PREFIX.length);
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new WorldPathError(`Invalid eval item body digest: ${digest}`);
  }
  return hex;
}

async function writeOnce(
  directory: string,
  path: string,
  contents: string,
  address: string,
): Promise<void> {
  await withWriteChain(resolve(path), async () => {
    await ensureDirectory(directory);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFileDurably(tempPath, contents);
    try {
      await link(tempPath, path);
      await syncDirectory(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const existing = await readIfPresent(path);
      if (existing === contents) {
        return;
      }
      throw new EvalSetStoreConflictError(address);
    } finally {
      await unlinkIfPresent(tempPath);
      await syncDirectory(directory);
    }
  });
}

async function listStoredWorkflowNames(world: LocalWorld): Promise<readonly string[]> {
  const entries = await readdirIfPresent(join(world.dataDir, "workflow-versions"));
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const name = await storedWorkflowName(world, entry.slice(0, -".json".length));
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * The stored workflow version for an LWIR hash, if there is one. The id is derivable from the hash —
 * `wfver_` plus the first 16 hex characters — so this is a single stat-and-read, not a scan.
 */
async function storedWorkflowNameFor(
  world: LocalWorld,
  workflowLwirSha: unknown,
): Promise<string | undefined> {
  if (typeof workflowLwirSha !== "string" || !workflowLwirSha.startsWith(SHA256_PREFIX)) {
    return undefined;
  }
  const hex = workflowLwirSha.slice(SHA256_PREFIX.length);
  if (!SHA256_HEX_PATTERN.test(hex)) {
    return undefined;
  }
  return storedWorkflowName(world, `wfver_${hex.slice(0, 16)}`);
}

async function storedWorkflowName(
  world: LocalWorld,
  workflowVersionId: string,
): Promise<string | undefined> {
  try {
    const stored = await readStoredWorkflowVersion(world, workflowVersionId);
    const metadata = (stored.lwir as { readonly metadata?: { readonly name?: unknown } } | undefined)
      ?.metadata;
    return typeof metadata?.name === "string" && metadata.name.length > 0
      ? metadata.name
      : undefined;
  } catch {
    return undefined;
  }
}

async function readdirIfPresent(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function writeFileDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const missingDirectories = await findMissingDirectories(path);
  await mkdir(path, { recursive: true });
  await syncDirectory(path);
  await syncDirectory(dirname(path));
  await Promise.all(
    missingDirectories.map((directory) => syncDirectory(dirname(directory))),
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function findMissingDirectories(path: string): Promise<readonly string[]> {
  const missingDirectories: string[] = [];
  for (const directory of directoryChain(path)) {
    try {
      const entry = await stat(directory);
      if (!entry.isDirectory()) {
        throw new WorldPathError(`Expected directory path, received file path: ${directory}`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      missingDirectories.push(directory);
    }
  }
  return missingDirectories;
}

function directoryChain(path: string): readonly string[] {
  const directories: string[] = [];
  let current = resolve(path);
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function withWriteChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  writeChains.set(key, next);
  return next.finally(() => {
    if (writeChains.get(key) === next) {
      writeChains.delete(key);
    }
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
