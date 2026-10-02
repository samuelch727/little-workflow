/**
 * `lwir-input-cone@v1` — a canonical hash of the transitive *input cone* of an LWIR step.
 *
 * ## Why
 *
 * An eval item is authored against one step under one LWIR. When the workflow later changes we
 * must decide, deterministically and without running anything, whether that item still tests the
 * same thing. The rule this hash serves: an item whose label was inherited from a replay survives
 * only if the step's input cone is unchanged.
 *
 * ## The cone rule (v1)
 *
 * **Membership.** The cone of step `S` is `S` plus the transitive closure of `influencers`, where
 * the direct influencers of a step `B` are:
 *
 *   1. every id in `B.needs` (needs-edge: the dependency runs before `B`);
 *   2. every step id reachable from a `{{ steps.X … }}` expression in `B.with`, `B.input` or
 *      `B.cache` — including back-edge `lastOutput` / `allVisits` references that LWIR
 *      deliberately allows *without* a matching `needs` entry (see the comment at lwir.ts
 *      ~L492-499), and including such expressions inside a `parallel` step's nested `steps`;
 *   3. every `decision` step that routes to `B` (decision-transition-edge). A decision controls
 *      *whether* and *how many times* `B` runs, so in a loop it determines which visit's values
 *      `B` sees. A `needs`-only walk misses this, which is why decision steps get their own edge.
 *
 * Steps that are downstream of `S`, or on an unrelated branch, are not in the cone at all — that
 * is where the invalidation savings come from.
 *
 * **What is hashed for each member.** The whole step object, canonicalised — *every* member,
 * including the target, with no field dropped. v1 uses a deny-list, not an allow-list: a step field
 * added to LWIR later is automatically *in* the cone, because under-invalidation (silently keeping
 * a stale eval item alive) is the unrecoverable direction.
 *
 * An earlier draft dropped `output`, `onFailure` and `sensitive` from the *target*'s projection, on
 * the theory that fields describing how a result is shaped, repaired and redacted cannot flow
 * backwards into that step's own input. That theory was wrong on at least three counts, and the
 * exclusion is gone rather than patched:
 *
 *   - the `step` expression root binds to the raw `LwirStep` (`expressionContextFor` in runtime.ts),
 *     so `input: "{{ step.sensitive }}"` reads the target's own excluded fields straight into the
 *     value `resolveStepInput` hands the worker;
 *   - `augmentAiStepForRepair` (runtime.ts) embeds `output.schema` and `output.mode` verbatim in the
 *     repair turn, and `resolveRepairPolicy` makes self-repair *default-on* for every `ai.generate`
 *     step, so `output` reaches the model with no opt-in at all;
 *   - `onFailure.fixer.system` is consumed directly as the fixer session's system prompt.
 *
 * Enumerating which runtime path reads what is the failure mode itself. Hashing members whole
 * removes the question.
 *
 * **Workflow-level fields.** Everything in the document except `metadata` and `steps`, as a
 * deny-list. `steps` is not an exclusion — it is hashed through the cone projection below, which is
 * the whole point of this module. A future sibling key under `input`, or a new top-level key, is
 * therefore hashed automatically rather than silently dropped.
 *
 * `metadata` is the single genuine exclusion, and it exists only so that a version bump or a
 * description edit does not invalidate every eval item in the workflow. It is sound because no
 * runtime path reads `metadata` into a step's input: the only binding that can reach it is the
 * `workflow` expression root, and that root is hatched below.
 *
 * **Escape hatches.** Two, both forcing `scope: "whole-document"` — the whole canonical document is
 * hashed and no narrowing is claimed:
 *
 *   1. *A cone member reads the `workflow` or `step` expression root.* `workflow` resolves to the
 *      entire LWIR document, so `{{ workflow.metadata.description }}` reads the one excluded field
 *      and `{{ workflow.steps[3].with.prompt }}` reads steps outside the cone. `step` resolves to
 *      the member's own raw step; members are hashed whole so this is belt-and-braces today, but it
 *      is the binding that defeated the previous target projection, and it costs nothing.
 *   2. *A cone member contains an unscannable string* — one where a `{{` or `}}` survives after
 *      every well-formed match is stripped (`lwirContainsUnscannableExpression` in lwir.ts). The
 *      reference scanner reports such a string as containing *no* expressions, while the runtime
 *      resolves it normally whenever the `{{` and `}}` counts happen to match. Narrowing on a scan
 *      that admits it could not read the string would let a `{{ steps.X … }}` edge hide behind a
 *      stray delimiter. `validateLwir` rejects these documents, but this module does not assume its
 *      input was validated (see `inputConeHash`), and the runtime does execute them.
 *
 * ## Cycles
 *
 * LWIR is *not* a DAG. `validateCycles` (lwir.ts ~L2503) explicitly permits a cycle whose members
 * all declare `maxVisits >= 2` and that contains at least one `decision` step. This function
 * therefore does not treat a cycle as an error: the transitive closure over a cyclic graph is
 * well-defined, the walk terminates on a visited set, and the result is order-independent. Cycle
 * membership is surfaced as `cyclic` for callers that care; it no longer changes what is hashed,
 * because the target is hashed whole either way.
 *
 * ## Determinism
 *
 * Under `scope: "steps"` the hash is independent of the order steps appear in `steps[]`, of object
 * key insertion order (`canonicalJson` sorts keys), and of the order of `needs` entries — at every
 * level, including the `needs` of steps nested inside a `parallel` body (normalised to a sorted,
 * deduped set; an empty `needs` is normalised away so `needs: []` and an absent `needs` agree).
 * Nested `steps` themselves keep document order — reordering branch bodies over-invalidates, which
 * is the safe direction.
 *
 * Under `scope: "whole-document"` only key order is normalised: the document is hashed as it stands,
 * so reordering `steps[]` or a `needs` list does change the digest. That is deliberate — the hatch
 * fired precisely because this module could not establish what the document means, so it stops
 * claiming that any rearrangement of it is cosmetic.
 *
 * ## What the hash cannot see
 *
 * The cone is computed from the LWIR alone. The LWIR names things the harness supplies:
 * `with.model` and `with.tools` are *slot names* whose implementations live outside the document,
 * and a harness may inject turns the LWIR does not contain at all (memory, skills, a system
 * prompt). An unchanged cone hash therefore means "the workflow still specifies the same input for
 * this step", not "the model will receive the same bytes". Comparing eval items across a harness
 * change needs a separate harness identity; this hash does not provide one.
 *
 * ## Versioning
 *
 * The algorithm id is both returned *and* mixed into the hashed payload. Callers comparing two
 * cone hashes MUST refuse the comparison unless both carry the same `algorithm`; a future
 * `lwir-input-cone@v2` will produce different digests for identical inputs by construction.
 *
 * The soundness fixes above changed every digest this module produces, and the id nevertheless
 * stays at `@v1`: no caller has persisted a hash. The module has one consumer — the re-export in
 * `index.ts` — no stored field, migration or manifest names a cone hash, and no released version of
 * the package contains this file. A `@v2` bump exists to protect *stored* comparisons, so once a
 * hash is written down anywhere, any change to what is hashed must bump instead of editing v1.
 */

import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  lwirContainsUnscannableExpression,
  lwirReferencesExpressionRoot,
  lwirStepReferenceIdsIn,
} from "./lwir.js";

/** The algorithm this module implements. Mixed into the hashed payload for domain separation. */
export const LWIR_INPUT_CONE_ALGORITHM = "lwir-input-cone@v1";

export type LwirInputConeAlgorithm = typeof LWIR_INPUT_CONE_ALGORITHM;

/**
 * `"steps"` — the cone was narrowed to the target step and its transitive influencers.
 * `"whole-document"` — an escape hatch fired (a cone member reads the `workflow` or `step`
 * expression root, or contains a string the expression scanner cannot read), so the whole LWIR is
 * hashed and no narrowing is sound.
 */
export type LwirInputConeScope = "steps" | "whole-document";

export type LwirInputConeStepProjection = Readonly<Record<string, unknown>>;

/** The exact value that gets hashed. Exported for LWIR diffing (LIT-15) and for debugging. */
export type LwirInputConeSnapshot =
  | {
      readonly algorithm: LwirInputConeAlgorithm;
      readonly scope: "steps";
      readonly stepId: string;
      readonly cyclic: boolean;
      /**
       * The whole canonical document minus `steps` (hashed via `target`/`influencers`) and minus
       * `metadata` (the single exclusion). A deny-list, so a new top-level key is hashed by default.
       */
      readonly workflow: Readonly<Record<string, unknown>>;
      readonly target: LwirInputConeStepProjection;
      readonly influencers: readonly LwirInputConeStepProjection[];
    }
  | {
      readonly algorithm: LwirInputConeAlgorithm;
      readonly scope: "whole-document";
      readonly stepId: string;
      readonly document: unknown;
    };

export type LwirInputConeResult = {
  readonly algorithm: LwirInputConeAlgorithm;
  /** `sha256:<hex>`, matching the little-workflow digest convention (`sha256Digest`). */
  readonly hash: string;
  readonly stepId: string;
  readonly scope: LwirInputConeScope;
  /**
   * Cone membership (the target plus every transitive influencer), sorted by code point.
   * Empty when `scope` is `"whole-document"` — no narrowing was possible.
   */
  readonly stepIds: readonly string[];
  /** True when the target step is inside its own influencer closure (a decision loop). */
  readonly cyclic: boolean;
};

export type LwirInputConeErrorCode =
  /** The document is not a hashable LWIR shape (not an object, no `steps` array, bad step id …). */
  | "invalid_lwir"
  /** The requested step id is not a top-level step of this workflow. */
  | "step_not_found"
  /** Two top-level steps share an id, so the cone would be ambiguous. */
  | "duplicate_step_id"
  /** A cone member depends on, references, or routes to a step that does not exist. */
  | "missing_reference"
  /** The requested step id exists only inside a `parallel` body; v1 addresses top-level steps. */
  | "nested_step_unsupported";

export class LwirInputConeError extends TypeError {
  readonly code: LwirInputConeErrorCode;
  readonly stepId: string;

  constructor(
    code: LwirInputConeErrorCode,
    message: string,
    options: { readonly stepId: string; readonly cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LwirInputConeError";
    this.code = code;
    this.stepId = options.stepId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Hash the transitive input cone of `stepId` within `lwir`.
 *
 * Pure: no I/O, no clock, no randomness. Throws {@link LwirInputConeError} rather than returning a
 * partial result — `lwir` is not assumed to have passed `validateLwir`.
 */
export function inputConeHash(lwir: unknown, stepId: string): LwirInputConeResult {
  const { snapshot, stepIds, cyclic } = analyzeInputCone(lwir, stepId);
  return {
    algorithm: LWIR_INPUT_CONE_ALGORITHM,
    hash: sha256Digest(snapshot),
    stepId,
    scope: snapshot.scope,
    stepIds,
    cyclic,
  };
}

/**
 * The canonical payload `inputConeHash` digests, without hashing it. Useful when a caller needs to
 * explain *why* two cones differ (LIT-15 lineage) rather than only that they do.
 */
export function inputConeSnapshot(lwir: unknown, stepId: string): LwirInputConeSnapshot {
  return analyzeInputCone(lwir, stepId).snapshot;
}

type StepRecord = Record<string, unknown>;

type ConeAnalysis = {
  readonly snapshot: LwirInputConeSnapshot;
  readonly stepIds: readonly string[];
  readonly cyclic: boolean;
};

/**
 * Top-level document keys kept out of the hashed workflow envelope.
 *
 * `steps` is *not* an exclusion: it is hashed through the cone projection (target + influencers).
 * `metadata` is the one field genuinely dropped — see the module header for why that is sound and
 * which escape hatch guards it.
 */
const WORKFLOW_ENVELOPE_OMITTED_FIELDS = ["metadata", "steps"] as const;

/**
 * Step fields scanned for `{{ steps.X … }}` edges.
 *
 * `with` and `input` are where the runtime resolves expressions: `resolveStepInput` resolves
 * `step.input`, falling back to `with.args`; a `decision` resolves `with.cases[].when`; a `parallel`
 * resolves `with.items` and `with.itemKey`. `cache` is included because LWIR validation treats it as
 * expression-bearing (`stepReferencesIn` in lwir.ts) even though no runtime path reads it today —
 * scanning a field the runtime ignores only over-approximates cone membership.
 *
 * This list bounds *membership* only. The escape hatches, and everything that is hashed, are
 * computed over the whole step object, so a field the runtime starts resolving later cannot open an
 * under-invalidation hole — at worst it costs an edge, which shows up as over-invalidation.
 */
const EXPRESSION_BEARING_FIELDS = ["with", "input", "cache"] as const;

function analyzeInputCone(lwir: unknown, stepId: string): ConeAnalysis {
  if (typeof stepId !== "string" || stepId.length === 0) {
    throw new LwirInputConeError(
      "step_not_found",
      "Input cone requires a non-empty step id.",
      { stepId: String(stepId) },
    );
  }

  const document = canonicalClone(lwir, stepId);
  if (!isRecord(document)) {
    throw new LwirInputConeError(
      "invalid_lwir",
      "LWIR document must be an object.",
      { stepId },
    );
  }
  const rawSteps = document.steps;
  if (!Array.isArray(rawSteps)) {
    throw new LwirInputConeError("invalid_lwir", "LWIR steps must be an array.", { stepId });
  }

  const stepsById = indexTopLevelSteps(rawSteps, stepId);
  const target = stepsById.get(stepId);
  if (target === undefined) {
    throw missingTargetError(rawSteps, stepId);
  }

  const routersByTarget = decisionRoutersByTarget(stepsById);

  const visited = new Set<string>([stepId]);
  const queue: string[] = [stepId];
  let cyclic = false;
  let wholeDocument = false;

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const current = stepsById.get(currentId) as StepRecord;
    const scan = scanStep(current, currentId, stepsById);
    wholeDocument = wholeDocument || scan.forcesWholeDocument;
    for (const influencerId of [...scan.stepIds, ...(routersByTarget.get(currentId) ?? [])]) {
      if (influencerId === stepId) {
        cyclic = true;
      }
      if (visited.has(influencerId)) {
        continue;
      }
      visited.add(influencerId);
      queue.push(influencerId);
    }
  }

  const stepIds = [...visited].sort(compareCodePoints);

  if (wholeDocument) {
    return {
      snapshot: {
        algorithm: LWIR_INPUT_CONE_ALGORITHM,
        scope: "whole-document",
        stepId,
        document,
      },
      stepIds: [],
      cyclic,
    };
  }

  const influencers = stepIds
    .filter((id) => id !== stepId)
    .map((id) => projectStep(stepsById.get(id) as StepRecord));

  return {
    snapshot: {
      algorithm: LWIR_INPUT_CONE_ALGORITHM,
      scope: "steps",
      stepId,
      cyclic,
      workflow: workflowEnvelopeOf(document),
      target: projectStep(target),
      influencers,
    },
    stepIds,
    cyclic,
  };
}

/**
 * Canonicalise the whole document up front so that (a) unhashable values fail with a typed error
 * instead of surfacing later from inside `sha256Digest`, and (b) object key order is already
 * normalised in the snapshot a caller may inspect.
 */
function canonicalClone(lwir: unknown, stepId: string): unknown {
  try {
    return JSON.parse(canonicalJson(lwir)) as unknown;
  } catch (error) {
    throw new LwirInputConeError(
      "invalid_lwir",
      error instanceof Error ? error.message : "LWIR is not hashable.",
      { stepId, cause: error },
    );
  }
}

function indexTopLevelSteps(
  steps: readonly unknown[],
  stepId: string,
): ReadonlyMap<string, StepRecord> {
  const stepsById = new Map<string, StepRecord>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step)) {
      throw new LwirInputConeError(
        "invalid_lwir",
        `LWIR step $.steps[${index}] must be an object.`,
        { stepId },
      );
    }
    const id = step.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new LwirInputConeError(
        "invalid_lwir",
        `LWIR step $.steps[${index}].id must be a non-empty string.`,
        { stepId },
      );
    }
    if (stepsById.has(id)) {
      throw new LwirInputConeError(
        "duplicate_step_id",
        `Duplicate top-level step id '${id}' makes the input cone ambiguous.`,
        { stepId },
      );
    }
    stepsById.set(id, step);
  }
  return stepsById;
}

function missingTargetError(steps: readonly unknown[], stepId: string): LwirInputConeError {
  if (nestedStepIds(steps).has(stepId)) {
    return new LwirInputConeError(
      "nested_step_unsupported",
      `Step '${stepId}' is declared inside a parallel branch body. ${LWIR_INPUT_CONE_ALGORITHM} addresses top-level steps only.`,
      { stepId },
    );
  }
  return new LwirInputConeError(
    "step_not_found",
    `Step '${stepId}' is not a top-level step of this workflow.`,
    { stepId },
  );
}

function nestedStepIds(steps: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const collect = (list: readonly unknown[]): void => {
    for (const step of list) {
      if (!isRecord(step)) {
        continue;
      }
      const nested = step.steps;
      if (!Array.isArray(nested)) {
        continue;
      }
      for (const child of nested) {
        if (isRecord(child) && typeof child.id === "string") {
          ids.add(child.id);
        }
      }
      collect(nested);
    }
  };
  collect(steps);
  return ids;
}

/**
 * Reverse decision-transition edges: `target id -> ids of the decision steps routing to it`.
 *
 * Built over the whole document, because a decision that is otherwise unrelated to the target can
 * still route to it. Dangling targets are ignored here and reported by `scanStep` only if the
 * decision itself turns out to be a cone member.
 */
function decisionRoutersByTarget(
  stepsById: ReadonlyMap<string, StepRecord>,
): ReadonlyMap<string, readonly string[]> {
  const routers = new Map<string, string[]>();
  for (const [id, step] of stepsById) {
    if (step.uses !== "decision") {
      continue;
    }
    for (const targetId of decisionTargetsOf(step)) {
      if (!stepsById.has(targetId)) {
        continue;
      }
      const existing = routers.get(targetId);
      if (existing === undefined) {
        routers.set(targetId, [id]);
      } else if (!existing.includes(id)) {
        existing.push(id);
      }
    }
  }
  return routers;
}

/** Routed-to step ids declared by a decision step. `"end"` terminates the run and is not a step. */
function decisionTargetsOf(step: StepRecord): readonly string[] {
  const config = step.with;
  if (!isRecord(config)) {
    return [];
  }
  const targets: string[] = [];
  const fallback = config.default;
  if (typeof fallback === "string" && fallback !== "end") {
    targets.push(fallback);
  }
  const cases = config.cases;
  if (Array.isArray(cases)) {
    for (const branch of cases) {
      if (isRecord(branch) && typeof branch.to === "string" && branch.to !== "end") {
        targets.push(branch.to);
      }
    }
  }
  return targets;
}

type StepScan = {
  readonly stepIds: readonly string[];
  /** True when this member defeats narrowing — see `stepForcesWholeDocument`. */
  readonly forcesWholeDocument: boolean;
};

/**
 * Both escape hatches, evaluated over the *entire* step object rather than over the three
 * expression-bearing fields, so a runtime path that starts resolving some other field later cannot
 * quietly reopen the hole. Nested `parallel` bodies are covered because they are part of the object.
 *
 *   - the `workflow` root reaches the excluded `metadata` and every step outside the cone;
 *   - the `step` root reaches the member's own raw `LwirStep`;
 *   - an unscannable string means the scanner could not read it, which must never be reported as
 *     "it contains no expressions".
 *
 * `expressionBodyReferencesRoot` requires a terminator after the root, so `steps.a.output` does not
 * match the `step` root.
 */
function stepForcesWholeDocument(step: StepRecord): boolean {
  return (
    lwirReferencesExpressionRoot(step, "workflow") ||
    lwirReferencesExpressionRoot(step, "step") ||
    lwirContainsUnscannableExpression(step)
  );
}

/** Direct influencers contributed by a cone member's own declarations (needs + expressions + routing). */
function scanStep(
  step: StepRecord,
  id: string,
  stepsById: ReadonlyMap<string, StepRecord>,
): StepScan {
  const stepIds = new Set<string>();

  for (const need of needsOf(step, id)) {
    if (!stepsById.has(need)) {
      throw new LwirInputConeError(
        "missing_reference",
        `Step '${id}' declares a dependency on missing step '${need}'.`,
        { stepId: id },
      );
    }
    stepIds.add(need);
  }

  // A decision routing to a step that does not exist cannot be resolved into an edge; the cone of
  // anything it controls is therefore not computable.
  if (step.uses === "decision") {
    for (const targetId of decisionTargetsOf(step)) {
      if (!stepsById.has(targetId)) {
        throw new LwirInputConeError(
          "missing_reference",
          `Decision step '${id}' routes to missing step '${targetId}'.`,
          { stepId: id },
        );
      }
    }
  }

  collectSubtreeInfluencers(step, id, stepsById, [], stepIds);
  return { stepIds: [...stepIds], forcesWholeDocument: stepForcesWholeDocument(step) };
}

/**
 * Walk `with`/`input`/`cache` of `step` and of every nested branch body, adding referenced
 * top-level step ids to `into`. Ids that resolve to a nested sibling (an enclosing `parallel` body's
 * own step) are local, not cone members.
 *
 * The escape hatches are *not* evaluated here — `stepForcesWholeDocument` covers the whole step
 * object in one pass, including these nested bodies.
 */
function collectSubtreeInfluencers(
  step: StepRecord,
  ownerId: string,
  stepsById: ReadonlyMap<string, StepRecord>,
  localScopes: readonly ReadonlySet<string>[],
  into: Set<string>,
): void {
  // A nested branch step may declare an outer step in `needs` (validateParallelStep exposes the
  // parallel's own dependencies to its body). The top-level step's `needs` is handled by
  // `scanStep`, so only nested levels are read here.
  if (localScopes.length > 0) {
    for (const need of needsOf(step, ownerId)) {
      if (localScopes.some((scope) => scope.has(need))) {
        continue;
      }
      if (!stepsById.has(need)) {
        throw new LwirInputConeError(
          "missing_reference",
          `Step '${ownerId}' declares a branch dependency on missing step '${need}'.`,
          { stepId: ownerId },
        );
      }
      into.add(need);
    }
  }

  for (const field of EXPRESSION_BEARING_FIELDS) {
    const value = step[field];
    if (value === undefined) {
      continue;
    }
    for (const referenceId of lwirStepReferenceIdsIn(value)) {
      if (localScopes.some((scope) => scope.has(referenceId))) {
        continue;
      }
      if (!stepsById.has(referenceId)) {
        throw new LwirInputConeError(
          "missing_reference",
          `Step '${ownerId}' references missing step '${referenceId}'.`,
          { stepId: ownerId },
        );
      }
      into.add(referenceId);
    }
  }

  const nested = step.steps;
  if (!Array.isArray(nested)) {
    return;
  }
  const scope = new Set<string>();
  for (const child of nested) {
    if (isRecord(child) && typeof child.id === "string" && child.id.length > 0) {
      scope.add(child.id);
    }
  }
  const nestedScopes = [...localScopes, scope];
  for (const child of nested) {
    if (!isRecord(child)) {
      continue;
    }
    collectSubtreeInfluencers(child, ownerId, stepsById, nestedScopes, into);
  }
}

function needsOf(step: StepRecord, id: string): readonly string[] {
  const needs = step.needs;
  if (needs === undefined) {
    return [];
  }
  if (!Array.isArray(needs)) {
    throw new LwirInputConeError(
      "invalid_lwir",
      `Step '${id}' has a non-array 'needs'.`,
      { stepId: id },
    );
  }
  for (const need of needs) {
    if (typeof need !== "string" || need.length === 0) {
      throw new LwirInputConeError(
        "invalid_lwir",
        `Step '${id}' has a 'needs' entry that is not a non-empty string.`,
        { stepId: id },
      );
    }
  }
  return needs as readonly string[];
}

/**
 * The only normalisation applied to a hashed step: `needs` is a set, so its order carries no
 * meaning and an empty list means the same as no list at all. Normalising both keeps a cosmetic
 * reorder from invalidating eval items.
 *
 * Applied recursively to `parallel` branch bodies too — the determinism claim in the module header
 * covers every level, and a reordered `needs` on a nested step is just as cosmetic as one on a
 * top-level step. Nested step *order* is deliberately preserved (reordering branch bodies
 * over-invalidates, the safe direction).
 *
 * No field is dropped, and the copy is fresh at every level: `analyzeInputCone` hands the same
 * cloned document to the whole-document branch, so mutating a shared step object here would leak
 * across snapshots.
 */
function projectStep(step: StepRecord): LwirInputConeStepProjection {
  const projected: StepRecord = { ...step };
  const needs = step.needs;
  if (Array.isArray(needs) && needs.every((need) => typeof need === "string")) {
    const normalized = [...new Set(needs as readonly string[])].sort(compareCodePoints);
    if (normalized.length === 0) {
      delete projected.needs;
    } else {
      projected.needs = normalized;
    }
  }
  const nested = step.steps;
  if (Array.isArray(nested)) {
    projected.steps = nested.map((child) => (isRecord(child) ? projectStep(child) : child));
  }
  return projected;
}

/** The document minus {@link WORKFLOW_ENVELOPE_OMITTED_FIELDS}. A deny-list, by design. */
function workflowEnvelopeOf(document: Record<string, unknown>): Record<string, unknown> {
  const envelope: Record<string, unknown> = { ...document };
  for (const field of WORKFLOW_ENVELOPE_OMITTED_FIELDS) {
    delete envelope[field];
  }
  return envelope;
}

/**
 * Code-point ordering, matching `workflow-definition-hash.ts`. `localeCompare` is locale-dependent
 * and must never decide the contents of a hash.
 */
function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) ?? 0;
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) ?? 0;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
  return leftCodePoints.length < rightCodePoints.length ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
