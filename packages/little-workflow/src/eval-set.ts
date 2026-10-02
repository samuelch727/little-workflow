/**
 * Eval-set bundles — content-addressed evidence about what a workflow was tested against.
 *
 * ## The shape of the thing
 *
 * An eval set is split in two, and the split is a *storage* boundary rather than a convention:
 *
 *   1. **The bundle** ({@link EvalSetBundle}) — the eval card ({@link EvalCard}) plus a Merkle
 *      **index** of item hashes with their set-scoped assignments. It contains no item content at
 *      all: every index-entry field is an identifier, an enum, a hash, an integer or a timestamp.
 *      `eval_set_sha = sha256Digest(bundle)`. This half is readable by anything that can render a
 *      card.
 *   2. **Item bodies** ({@link EvalItemBody}) — input, label, reference answer, rubric and
 *      provenance. Fetched separately, addressed by their own hash, never inlined into the bundle.
 *
 * The reason is not tidiness. A gate set only means something if the authoring loop cannot see it;
 * if one blob held every item's input and label, any session that can fetch a bundle by sha sees
 * the whole gate set and sealing buys nothing. Three properties fall out of the split for free: the
 * eval card renders from the manifest alone; a migration pass can compute per-item survival
 * verdicts without ever reading a body; and the relational projection of the index is *structurally*
 * free of item content, so it cannot leak PII no matter what an author writes.
 *
 * That is also why `provenance` lives in the body and not in the index entry. A `(runId, sequence)`
 * pointer is a dereferenceable copy of a replay-derived item's input for anyone with run-history
 * access — which the generating session is deliberately given. An index-side pointer would hand
 * every authoring context the gate and honeypot inputs the split exists to withhold, without it
 * ever reading a body.
 *
 * ## Two hashes per item, two jobs
 *
 * - `itemSha` — **identity**: the body minus `provenance`. Drives dedup, role disjointness, seal
 *   membership and migration re-keying. Deliberately *stable* across provenance differences, and
 *   deliberately excludes the set-scoped assignments (role, cluster, K, createdAt) that live in the
 *   index entry. If role were hashed in, "the same item as optimizer" and "as gate" would have
 *   different hashes and the disjointness constraint that depends on `item_sha` would catch nothing.
 * - `bodySha` — **integrity**: the whole body, provenance included. What a body reader verifies
 *   after fetching. Both are pinned by the index, hence by `eval_set_sha`.
 *
 * ## No JSON floats anywhere in a hashed payload
 *
 * `canonicalJson` serialises numbers with `JSON.stringify`, i.e. ECMA-262 `Number::toString`. That
 * is deterministic inside a conforming JS engine but it is *not* what Rust's `f64` `Display` or
 * Python's `repr` emit for every value, and an eval card is mostly numbers. A verifier written in
 * another language would silently disagree about `eval_set_sha` for a subset of values, so it could
 * only ever *store* the hash, never *check* it.
 *
 * The rule, enforced by {@link validateEvalSet} and {@link validateEvalItemBody} before anything is
 * hashed:
 *
 *   - every JSON number in a hashed payload must be a **safe integer** — counts, K, cluster sizes,
 *     `(runId, sequence)`. Those are exact and print identically everywhere;
 *   - every real-valued quantity is a {@link Decimal}: a decimal **string** such as `"0.93"`.
 *
 * The rule applies to the whole payload, including `extensions`, `input.value` and `label.value`.
 * A workflow input that genuinely contains `1250.75` must be authored as `"1250.75"`; that is a real
 * cost, and it is the price of an `eval_set_sha` any language can verify.
 *
 * ## Registration
 *
 * {@link registerEvalSet} is the `registerWorkflowVersion` recipe with one addition: the payload is
 * run through `stripUndefined` first, because `canonicalJson` rejects `undefined` rather than
 * ignoring it and an eval card is mostly optional fields. `{ description: undefined }` therefore
 * hashes identically to `{}` instead of throwing.
 *
 * ## Lineage
 *
 * A lineage is `(project, workflowName)`. `workflowName` is carried in the card so a bundle names
 * its own lineage — otherwise a rename silently starts a *new* lineage and orphans every eval set
 * authored under the old name. {@link validateEvalSet} accepts a `knownLineages` set and emits a
 * `evalset.unknown_lineage` **warning** (never an error — a genuinely new workflow is legitimate)
 * when the declared name is not among them. `eval-set-store.ts` computes that set from the local
 * corpus, which is the only place that actually knows it.
 */

import { canonicalJson, sha256Digest } from "./canonical.js";
import { LWIR_INPUT_CONE_ALGORITHM } from "./lwir-input-cone.js";
import { stripUndefined } from "./strip-undefined.js";

export const EVAL_SET_API_VERSION = "littleworkflow.dev/evalset/v0.1";
export const EVAL_ITEM_API_VERSION = "littleworkflow.dev/evalitem/v0.1";
export const EVAL_SET_CANONICALIZER = "little-workflow-canonical-json@alpha";

/**
 * The four roles an item can hold.
 *
 * **There is deliberately no `gate_sealed`.** A queryable sealed flag *is* the stored membership
 * list that sealing exists to forbid: anything that can read the index — including any authoring
 * session — could enumerate the sealed split in one pass. Store `role: "gate"`, the union of the dev
 * and sealed splits, and let the key holder compute the partition at gate time as
 * `BE_uint64(HMAC(key, domain ‖ item_sha)[0..8]) < cutoff`. The four-key query path is unaffected:
 * the runner filters by `gate`, then partitions.
 *
 * Honeypots stay visible for the same reason they are safe to expose: the bundle reveals *that*
 * honeypots exist and how many, and only a body reveals *which inputs they are*. A honeypot is
 * defeated by knowing its content, not its count.
 */
export const EVAL_ITEM_ROLES = ["optimizer", "gate", "regression", "honeypot"] as const;
export type EvalItemRole = (typeof EVAL_ITEM_ROLES)[number];

export const REPLAY_VALIDITY_CLASSES = ["pure", "feedback", "side_effectful"] as const;
export type ReplayValidityClass = (typeof REPLAY_VALIDITY_CLASSES)[number];

export const LABEL_PROVENANCES = [
  "replay_inherited",
  "citation_grounded",
  "mutation_entailed",
  "judge_labeled",
  "human_labeled",
] as const;
export type LabelProvenance = (typeof LABEL_PROVENANCES)[number];

export const SAMPLING_STRATEGIES = [
  "stratified",
  "replay_window",
  "desiderata_search",
  "mixed",
] as const;
export type SamplingStrategy = (typeof SAMPLING_STRATEGIES)[number];

export const PII_STATUSES = ["synthetic", "surrogate", "redacted", "raw_prohibited"] as const;
export type PiiStatus = (typeof PII_STATUSES)[number];

export const SEAL_CUSTODY = ["dev_local", "customer_held"] as const;
export type SealCustody = (typeof SEAL_CUSTODY)[number];

/** Sentinel `target` for an item that tests the workflow end to end rather than one step. */
export const WORKFLOW_TARGET = "$workflow";

/**
 * A real number encoded as a decimal string: `"0.93"`, `"-0.004"`, `"1"`.
 *
 * **Not a JSON number.** See the module header. The accepted grammar is
 * `-?(0|[1-9][0-9]*)(\.[0-9]+)?`: no exponent, no leading zeros, no `+`, no negative zero, at most
 * {@link MAX_DECIMAL_LENGTH} characters.
 *
 * Trailing zeros are *allowed* and *significant to the hash*: `"0.90"` and `"0.9"` are different
 * bundles. That is deliberate — the string is the value exactly as the author reported it, and
 * statistics carry precision in their trailing digits. It also means the bundle never needs a
 * numeric normalisation step that a cross-language verifier would have to reimplement.
 */
export type Decimal = string;

export const MAX_DECIMAL_LENGTH = 64;

export type EvalSetBundle = {
  readonly apiVersion: typeof EVAL_SET_API_VERSION;
  readonly kind: "EvalSet";
  readonly manifest: EvalCard;
  /**
   * Merkle index: commits to every item body without containing one. Sorted **strictly** ascending
   * by `itemSha` — the canonicalizer does not sort arrays, so the order is part of the hash, and
   * strictness makes duplicate item shas impossible.
   */
  readonly index: readonly EvalItemIndexEntry[];
};

// ─────────────────────────────────── the eval card ───────────────────────────────────

export type EvalCard = {
  readonly metadata: {
    readonly name: string;
    readonly description?: string;
    /** Authored-at, ISO-8601 UTC, second precision: `YYYY-MM-DDTHH:MM:SSZ`. */
    readonly createdAt: string;
  };
  /**
   * The authoring workflow's `metadata.name`. A lineage is `(project, workflowName)`, and carrying
   * the name here is what lets a bundle name its own lineage — see the module header.
   */
  readonly workflowName: string;
  /** The LWIR version authored against. `WorkflowVersion.hash` format: `sha256:<64 hex>`. */
  readonly workflowLwirSha: string;
  /** Set when produced by a migration pass. Reserved. */
  readonly parentEvalSetSha?: string;
  readonly migrationSha?: string;

  readonly constructs: readonly ConstructDefinition[];
  readonly sampling: SamplingPolicy;
  readonly sealPolicy: SealPolicy;
  readonly desiderata: DesiderataReport;
  readonly generation: GenerationStats;
  readonly audit: AuditRecord;
  readonly judge: JudgeSpecRef;
  readonly independence: IndependenceAttestation;
  readonly noiseFloor: NoiseFloorMeasurement;
  /** Must be embedded to be greppable in a leaked context. */
  readonly canaryGuid: string;
  readonly lifecycle: LifecyclePolicy;
  readonly pii: PiiPolicy;
  /**
   * Hashed, schema-free, namespaced extension slot: keys look like `"lending.fairness/v1"`. Domain
   * blocks land here without a bundle-version bump, and they are inside the hash, so nothing is lost
   * evidentially. The no-float rule applies here too.
   */
  readonly extensions?: Record<string, unknown>;
};

/** The pass criterion, written *before* item generation. */
export type ConstructDefinition = {
  /** LWIR step id, or {@link WORKFLOW_TARGET} for workflow-level items. */
  readonly target: string;
  readonly passCriterion: string;
  readonly criteria: readonly { readonly id: string; readonly text: string }[];
  /** Default K-resample for this target; an item may override it. */
  readonly resampleK: number;
  readonly authoredAt: string;
};

export type SamplingPolicy = {
  readonly strategy: SamplingStrategy;
  /** The receipt's "input distribution = run-history window W". */
  readonly window?: { readonly fromAt: string; readonly toAt: string };
  readonly strata: readonly {
    readonly id: string;
    readonly definition: string;
    readonly count: number;
  }[];
};

/** Contains no key material, by construction. */
export type SealPolicy = {
  readonly algorithm: "HMAC-SHA256";
  /**
   * Key **identity**, never the key:
   * `"hmac-sha256-id:" + hex(HMAC(key, "littleworkflow/evalset/seal-key-id/v1"))`. A KDF-derived id,
   * so it is not a verification oracle even for a low-entropy key — which `sha256(key)` would be.
   */
  readonly sealKeyId: string;
  readonly custody: SealCustody;
  /**
   * Sealed iff `BE_uint64(HMAC(key, domain ‖ item_sha)[0..8]) < cutoff`. A decimal uint64 **string**:
   * it exceeds `Number.MAX_SAFE_INTEGER` and `canonicalJson` rejects `bigint`. Never a float — this
   * decides gate membership and has to be bit-reproducible in any language.
   */
  readonly cutoff: string;
  /** Domain separation, so one key can seal several lineages. */
  readonly domain: string;
};

export type DesiderataReport = {
  readonly difficultyBand: {
    readonly targetLow: Decimal;
    readonly targetHigh: Decimal;
    readonly achieved: Decimal;
  };
  readonly coverage: { readonly target: Decimal; readonly achieved: Decimal; readonly basis: string };
  readonly diversityClusters: { readonly target: number; readonly achieved: number };
  /** Optional until a filter computes it and a gate reads it. */
  readonly separability?: { readonly target: Decimal; readonly achieved: Decimal };
};

export type GenerationStats = {
  readonly candidatesGenerated: number;
  readonly admitted: number;
  /**
   * Keep rate is **derived** (`admitted / candidatesGenerated`), never stored: a stored float would
   * be a second source of truth that can drift from the two integers, and it would put a float in
   * the hash.
   */
  readonly rejectedByStage: readonly { readonly stage: string; readonly count: number }[];
  readonly authorModel: ModelPin;
};

export type AuditRecord = {
  readonly nAudited: number;
  /** Pseudonymous handles only — a name or an email address here is a validation error. */
  readonly raters: readonly { readonly ref: string; readonly kind: "human" | "model" }[];
  readonly labelErrorEstimate: {
    readonly point: Decimal;
    readonly ciLow: Decimal;
    readonly ciHigh: Decimal;
  };
  readonly fleissKappa?: Decimal;
};

export type ModelPin = {
  readonly providerId: string;
  readonly modelId: string;
  /** Load-bearing for the independence attestation. */
  readonly family: string;
};

export type JudgeSpecRef = {
  readonly modelPin: ModelPin;
  /**
   * Points at the content-addressed judge spec. The rubric text is **not** copied here: a rubric
   * edit changes `rubricSha`, which changes `eval_set_sha`, which is exactly the auto-invalidation
   * a recalibrated judge should cause.
   */
  readonly rubricSha: string;
  readonly calibrationSetSha: string;
  readonly tpr: Decimal;
  readonly tnr: Decimal;
  readonly kappaVsHuman?: Decimal;
  readonly kappaHumanHuman?: Decimal;
  readonly alignmentScore?: Decimal;
};

/** The effective-challenge field: who authored the eval, and were they the same family as the author of the thing under test. */
export type IndependenceAttestation = {
  readonly evalAuthorFamily: string;
  readonly workflowAuthorFamily: string;
  /** Must agree with the two families above — an attestation that contradicts itself is rejected. */
  readonly distinct: boolean;
  /** Pseudonymous handle. Real identity lives in the vault, keyed by this. */
  readonly humanReviewerRef?: string;
};

export type NoiseFloorMeasurement = {
  readonly method: "incumbent_rerun";
  readonly runs: number;
  readonly deltaPpP50: Decimal;
  readonly deltaPpP95: Decimal;
  readonly measuredAt: string;
};

export type LifecyclePolicy = {
  readonly expiresAt?: string;
  /** Rotation as two integers, so `1/6` never becomes a float. */
  readonly refresh: {
    readonly policy: "rotate_fraction";
    readonly numerator: number;
    readonly denominator: number;
    readonly cadence: string;
  };
  /**
   * The **budget** is policy, so it is immutable and lives here. The consumed **count** is state and
   * lives in the control plane — a counter inside a hash is a contradiction in terms.
   */
  readonly gateQueryBudget: number;
};

export type PiiPolicy = {
  readonly status: PiiStatus;
  readonly retentionClass: string;
  /**
   * Required whenever `status !== "synthetic"`. Disposal is *executed* by shredding the vault's
   * per-subject key, never by deleting a bundle — the bundle is immutable evidence.
   */
  readonly disposalDue?: string;
};

// ───────────────────────────── index entries and bodies ─────────────────────────────

/**
 * Set-scoped assignments for one item. Every field is here because it is needed to query, to render
 * the card, or to compute a migration verdict. Nothing here is item content, which is what makes the
 * whole structure safe to project into SQL.
 */
export type EvalItemIndexEntry = {
  /** Identity hash — excludes provenance and every field of this entry. */
  readonly itemSha: string;
  /** Integrity hash of the full body, provenance included. What a body reader verifies. */
  readonly bodySha: string;
  readonly target: string;
  readonly role: EvalItemRole;
  readonly replayValidity: ReplayValidityClass;
  readonly labelProvenance: LabelProvenance;
  /** Originating trace / document / template. Feeds clustered standard errors. */
  readonly clusterId: string;
  /** Perturbation-variant group. A group migrates and is roled as a unit. */
  readonly variantGroupId?: string;
  /** LWIR contract fields the label depends on: canonical paths, sorted, deduped. */
  readonly referencedFields: readonly string[];
  /** Transitive input cone of `target` in the authoring LWIR. */
  readonly inputConeHash: string;
  readonly inputConeAlgorithm: typeof LWIR_INPUT_CONE_ALGORITHM;
  /** Overrides the construct default. */
  readonly resampleK?: number;
  readonly createdAt: string;
  /**
   * There is deliberately **no** run/event pointer here, and the validator rejects one on sight.
   * See the module header: a `(runId, sequence)` pair dereferences to the item's recorded input.
   */
};

/** The privileged half. Addressed by `bodySha`, fetched through the body reader, never inlined. */
export type EvalItemBody = {
  readonly apiVersion: typeof EVAL_ITEM_API_VERSION;
  readonly kind: "EvalItem";
  readonly target: string;
  readonly input: EvalItemContent;
  readonly label: EvalItemLabel;
  readonly referenceAnswer?: EvalItemContent;
  readonly rubric: readonly { readonly criterionId: string; readonly expected: boolean }[];
  /** Provenance pointers live in the privileged half. Excluded from `itemSha`, committed by `bodySha`. */
  readonly provenance: readonly {
    readonly runId: string;
    readonly sequence: number;
    readonly eventId?: string;
  }[];
};

/**
 * The PII split, as a type. `inline` is legal **only** when the manifest declares
 * `pii.status === "synthetic"`; the validator rejects otherwise, before hashing. Because
 * `pii.status` is itself inside the hashed manifest, the check is re-verifiable offline from the
 * shas alone.
 */
export type EvalItemContent =
  | { readonly kind: "inline"; readonly value: unknown }
  | { readonly kind: "vault"; readonly vaultRef: string; readonly shape: unknown };

export type EvalItemLabel = {
  readonly provenance: LabelProvenance;
  readonly value: unknown;
  /** Provenance-specific evidence that a migration survival matrix reads. */
  readonly evidence?: EvalItemLabelEvidence;
};

export type EvalItemLabelEvidence =
  | {
      readonly kind: "citation";
      readonly sourceSha: string;
      readonly locator: string;
      readonly matchScore: Decimal;
    }
  | {
      readonly kind: "mutation";
      readonly baseItemSha: string;
      readonly transform: string;
      /** Contract fields the entailment factors through. */
      readonly entailedVia: readonly string[];
    }
  | { readonly kind: "replay"; readonly runId: string; readonly sequence: number };

// ─────────────────────────────────── registration ───────────────────────────────────

export type EvalSetVersion = {
  /** `evset_<first 16 hex of the hash>`. */
  readonly id: string;
  /** `sha256:<64 hex>` — this is `eval_set_sha`. */
  readonly hash: string;
  readonly canonicalizer: typeof EVAL_SET_CANONICALIZER;
  /** The canonical string next to the parsed object, so the hash is checkable without re-canonicalising. */
  readonly canonicalJson: string;
  readonly bundle: EvalSetBundle;
};

export type RegisteredEvalItemBody = {
  /** Identity: the body minus `provenance`. */
  readonly itemSha: string;
  /** Integrity: the whole body. Also the store address. */
  readonly bodySha: string;
  readonly canonicalJson: string;
  readonly body: EvalItemBody;
};

export type EvalSetFindingSeverity = "error" | "warning";

export type EvalSetValidationFinding = {
  readonly severity: EvalSetFindingSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type EvalSetValidationResult =
  | {
      readonly valid: true;
      readonly findings: readonly [];
      readonly warnings: readonly EvalSetValidationFinding[];
    }
  | {
      readonly valid: false;
      readonly findings: readonly EvalSetValidationFinding[];
      readonly warnings: readonly EvalSetValidationFinding[];
    };

export class EvalSetValidationError extends TypeError {
  readonly findings: readonly EvalSetValidationFinding[];
  readonly warnings: readonly EvalSetValidationFinding[];

  constructor(
    findings: readonly EvalSetValidationFinding[],
    warnings: readonly EvalSetValidationFinding[] = [],
  ) {
    super("Invalid eval set.");
    this.name = "EvalSetValidationError";
    this.findings = findings;
    this.warnings = warnings;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ValidateEvalSetOptions = {
  /**
   * Workflow names already known locally. When supplied and the bundle's `workflowName` is not among
   * them, a `evalset.unknown_lineage` **warning** is emitted: renaming a workflow silently starts a
   * new lineage and orphans every eval set authored under the old name, and a warning is the only
   * honest verdict — a genuinely new workflow looks exactly the same from here.
   */
  readonly knownLineages?: Iterable<string>;
};

export type RegisterEvalSetOptions = ValidateEvalSetOptions & {
  /** Called once per warning. Warnings are never part of {@link EvalSetVersion}: they are not evidence and must not perturb the bytes. */
  readonly onWarning?: (warning: EvalSetValidationFinding) => void;
};

export type ValidateEvalItemBodyOptions = {
  /** The owning bundle's PII policy. Required in practice: inline content without one is rejected. */
  readonly pii?: PiiPolicy;
};

/**
 * Validate an eval-set bundle.
 *
 * `undefined`-valued properties are stripped first, so validation sees exactly the payload
 * {@link registerEvalSet} would hash.
 */
export function validateEvalSet(
  value: unknown,
  options: ValidateEvalSetOptions = {},
): EvalSetValidationResult {
  const ctx = newContext();
  const bundle = canonicalClone(stripUndefined(value), ctx);
  if (bundle !== undefined) {
    rejectNonIntegerNumbers(bundle, "$", ctx);
    validateBundleShape(bundle, options, ctx);
  }
  return resultOf(ctx);
}

export function assertValidEvalSet(
  value: unknown,
  options: ValidateEvalSetOptions = {},
): asserts value is EvalSetBundle {
  const result = validateEvalSet(value, options);
  if (!result.valid) {
    throw new EvalSetValidationError(result.findings, result.warnings);
  }
}

/**
 * The `registerWorkflowVersion` recipe, plus a `stripUndefined` pass (see the module header) and the
 * warning channel.
 */
export function registerEvalSet(
  value: unknown,
  options: RegisterEvalSetOptions = {},
): EvalSetVersion {
  const stripped = stripUndefined(value);
  const result = validateEvalSet(stripped, options);
  if (!result.valid) {
    throw new EvalSetValidationError(result.findings, result.warnings);
  }
  if (options.onWarning !== undefined) {
    for (const warning of result.warnings) {
      options.onWarning(warning);
    }
  }
  const canonical = canonicalJson(stripped);
  const bundle = deepFreeze(JSON.parse(canonical) as EvalSetBundle);
  const hash = sha256Digest(bundle);
  return deepFreeze({
    id: `evset_${hash.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 16)}`,
    hash,
    canonicalizer: EVAL_SET_CANONICALIZER,
    canonicalJson: canonical,
    bundle,
  });
}

/** The identity projection: the body minus `provenance`. */
export function evalItemIdentity(body: EvalItemBody): Omit<EvalItemBody, "provenance"> {
  const { provenance: _omitted, ...identity } = body;
  return identity;
}

/** Identity hash. Stable across provenance differences — see the module header. */
export function evalItemSha(body: EvalItemBody): string {
  return sha256Digest(stripUndefined(evalItemIdentity(body)));
}

/** Integrity hash of the whole body, provenance included. */
export function evalItemBodySha(body: EvalItemBody): string {
  return sha256Digest(stripUndefined(body));
}

export function validateEvalItemBody(
  value: unknown,
  options: ValidateEvalItemBodyOptions = {},
): EvalSetValidationResult {
  const ctx = newContext();
  const body = canonicalClone(stripUndefined(value), ctx);
  if (body !== undefined) {
    rejectNonIntegerNumbers(body, "$", ctx);
    validateBodyShape(body, options.pii, "$", ctx);
  }
  return resultOf(ctx);
}

export function assertValidEvalItemBody(
  value: unknown,
  options: ValidateEvalItemBodyOptions = {},
): asserts value is EvalItemBody {
  const result = validateEvalItemBody(value, options);
  if (!result.valid) {
    throw new EvalSetValidationError(result.findings, result.warnings);
  }
}

/** Validate, canonicalise, then hash — in that order, so the PII rule runs before anything is committed to. */
export function registerEvalItemBody(
  value: unknown,
  options: ValidateEvalItemBodyOptions = {},
): RegisteredEvalItemBody {
  const stripped = stripUndefined(value);
  const result = validateEvalItemBody(stripped, options);
  if (!result.valid) {
    throw new EvalSetValidationError(result.findings, result.warnings);
  }
  const canonical = canonicalJson(stripped);
  const body = deepFreeze(JSON.parse(canonical) as EvalItemBody);
  return deepFreeze({
    itemSha: evalItemSha(body),
    bodySha: evalItemBodySha(body),
    canonicalJson: canonical,
    body,
  });
}

export type VerifyEvalSetBodiesOptions = {
  /** Allow the bundle's index to name items no body was supplied for (a gate slice, say). */
  readonly partial?: boolean;
};

/**
 * Cross-verify a bundle against the bodies it commits to.
 *
 * Checks both directions: every supplied body's recomputed `itemSha`/`bodySha` must match an index
 * entry, and (unless `partial`) every index entry must have a body. Also re-checks the facts the
 * index duplicates from the body — `target`, `labelProvenance` — and the inline/PII rule, which is
 * the one rule that needs both halves at once.
 */
export function verifyEvalSetBodies(
  bundle: EvalSetBundle,
  bodies: Iterable<EvalItemBody>,
  options: VerifyEvalSetBodiesOptions = {},
): EvalSetValidationResult {
  const ctx = newContext();
  const entriesByItemSha = new Map<string, EvalItemIndexEntry>();
  for (const entry of bundle.index) {
    entriesByItemSha.set(entry.itemSha, entry);
  }
  const criteriaByTarget = new Map<string, ReadonlySet<string>>();
  for (const construct of bundle.manifest.constructs) {
    criteriaByTarget.set(construct.target, new Set(construct.criteria.map((c) => c.id)));
  }

  const seen = new Set<string>();
  let position = 0;
  for (const body of bodies) {
    const path = `$.bodies[${position}]`;
    position += 1;
    const bodyResult = validateEvalItemBody(body, { pii: bundle.manifest.pii });
    for (const finding of [...bodyResult.findings, ...bodyResult.warnings]) {
      push(ctx, finding.severity, finding.code, joinPath(path, finding.path), finding.message);
    }
    if (!bodyResult.valid) {
      continue;
    }
    const itemSha = evalItemSha(body);
    const bodySha = evalItemBodySha(body);
    const entry = entriesByItemSha.get(itemSha);
    if (entry === undefined) {
      error(
        ctx,
        "evalset.body_not_indexed",
        path,
        `Body has item sha ${itemSha}, which no index entry of this bundle claims.`,
      );
      continue;
    }
    seen.add(itemSha);
    if (entry.bodySha !== bodySha) {
      error(
        ctx,
        "evalset.body_sha_mismatch",
        path,
        `Body hashes to ${bodySha} but the index entry for ${itemSha} pins bodySha ${entry.bodySha}.`,
      );
    }
    if (entry.target !== body.target) {
      error(
        ctx,
        "evalset.body_target_mismatch",
        `${path}.target`,
        `Body target '${body.target}' disagrees with the index entry's '${entry.target}'.`,
      );
    }
    if (entry.labelProvenance !== body.label.provenance) {
      error(
        ctx,
        "evalset.body_label_provenance_mismatch",
        `${path}.label.provenance`,
        `Body label provenance '${body.label.provenance}' disagrees with the index entry's '${entry.labelProvenance}'.`,
      );
    }
    const criteria = criteriaByTarget.get(body.target);
    if (criteria !== undefined) {
      for (let index = 0; index < body.rubric.length; index += 1) {
        const criterionId = body.rubric[index]?.criterionId as string;
        if (!criteria.has(criterionId)) {
          error(
            ctx,
            "evalset.unknown_criterion",
            `${path}.rubric[${index}].criterionId`,
            `Criterion '${criterionId}' is not declared by the construct for target '${body.target}'.`,
          );
        }
      }
    }
  }

  if (options.partial !== true) {
    for (const entry of bundle.index) {
      if (!seen.has(entry.itemSha)) {
        error(
          ctx,
          "evalset.body_missing",
          "$.bodies",
          `No body was supplied for index entry ${entry.itemSha}. Pass { partial: true } to verify a subset.`,
        );
      }
    }
  }

  return resultOf(ctx);
}

/**
 * Sort index entries into the order a bundle requires. Ascending `itemSha`, by UTF-16 code unit —
 * the ordering `canonicalJson` uses for object keys, and the one a verifier in any language
 * reproduces for lowercase-hex strings of equal length.
 */
export function sortEvalSetIndex(
  entries: readonly EvalItemIndexEntry[],
): readonly EvalItemIndexEntry[] {
  return [...entries].sort((left, right) => compareStrings(left.itemSha, right.itemSha));
}

// ───────────────────────────────────── validation ─────────────────────────────────────

const SHA256_PREFIX = "sha256:";
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UINT64_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const UINT64_MAX = 18446744073709551615n;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SEAL_KEY_ID_PATTERN = /^hmac-sha256-id:[0-9a-f]{64}$/u;
const EXTENSION_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9.\-_]*\/v[0-9]+$/u;
const MIN_CANARY_LENGTH = 8;

/**
 * Keys that must never appear in an index entry. A run/event pointer in the readable half
 * dereferences to the item's input for anyone with run-history access, which defeats the split.
 * Unknown keys are rejected anyway; these get their own code so the reason is legible.
 */
const FORBIDDEN_INDEX_KEYS = ["provenance", "runId", "sequence", "eventId", "events"] as const;

/**
 * Free-text fields an author could accidentally fill with personal data. This is the one place the
 * design falls back to a *check* rather than a structural guarantee, and it is worth saying so: the
 * regexes below catch the obvious shapes, not a determined author.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/u;
const PHONE_PATTERN = /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/u;

type Context = {
  readonly findings: EvalSetValidationFinding[];
  readonly warnings: EvalSetValidationFinding[];
};

function newContext(): Context {
  return { findings: [], warnings: [] };
}

function resultOf(ctx: Context): EvalSetValidationResult {
  return ctx.findings.length === 0
    ? { valid: true, findings: [], warnings: ctx.warnings }
    : { valid: false, findings: ctx.findings, warnings: ctx.warnings };
}

function push(
  ctx: Context,
  severity: EvalSetFindingSeverity,
  code: string,
  path: string,
  message: string,
): void {
  (severity === "error" ? ctx.findings : ctx.warnings).push({ severity, code, path, message });
}

function error(ctx: Context, code: string, path: string, message: string): void {
  push(ctx, "error", code, path, message);
}

function warn(ctx: Context, code: string, path: string, message: string): void {
  push(ctx, "warning", code, path, message);
}

function joinPath(prefix: string, path: string): string {
  return path === "$" ? prefix : `${prefix}${path.slice(1)}`;
}

function canonicalClone(value: unknown, ctx: Context): unknown {
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch (cause) {
    error(
      ctx,
      "evalset.non_hashable",
      "$",
      cause instanceof Error ? cause.message : "Value is not hashable.",
    );
    return undefined;
  }
}

/**
 * The float rule, applied to the entire payload rather than only to the fields typed {@link Decimal}.
 * A number that survives here is a safe integer, which every language prints identically.
 */
function rejectNonIntegerNumbers(value: unknown, path: string, ctx: Context): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      error(
        ctx,
        "evalset.float_in_hashed_payload",
        path,
        `JSON numbers in a content-addressed payload must be safe integers; received ${String(value)}. Encode real values as decimal strings ("0.93") so the hash is reproducible outside JavaScript.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      rejectNonIntegerNumbers(value[index], `${path}[${index}]`, ctx);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      rejectNonIntegerNumbers(item, `${path}.${key}`, ctx);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string, ctx: Context): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    error(ctx, "evalset.schema.invalid", path, `${path} must be an object.`);
    return undefined;
  }
  return value;
}

function requireArray(value: unknown, path: string, ctx: Context): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    error(ctx, "evalset.schema.invalid", path, `${path} must be an array.`);
    return undefined;
  }
  return value;
}

function checkKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  ctx: Context,
): void {
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      error(ctx, "evalset.schema.missing", `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      error(
        ctx,
        "evalset.schema.unknown_key",
        `${path}.${key}`,
        `${path} does not accept the key '${key}'. Eval-set payloads have closed key sets so that an unrecognised field can never enter a hash unexamined.`,
      );
    }
  }
}

function requireString(value: unknown, path: string, ctx: Context): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    error(ctx, "evalset.schema.invalid", path, `${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function requireBoolean(value: unknown, path: string, ctx: Context): boolean | undefined {
  if (typeof value !== "boolean") {
    error(ctx, "evalset.schema.invalid", path, `${path} must be a boolean.`);
    return undefined;
  }
  return value;
}

function requireLiteral<T extends string>(
  value: unknown,
  expected: T,
  path: string,
  ctx: Context,
): void {
  if (value !== expected) {
    error(ctx, "evalset.schema.invalid", path, `${path} must be ${JSON.stringify(expected)}.`);
  }
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  ctx: Context,
): T | undefined {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}.`,
    );
    return undefined;
  }
  return value as T;
}

function requireInteger(value: unknown, path: string, ctx: Context, minimum = 0): number | undefined {
  if (typeof value !== "number") {
    error(ctx, "evalset.schema.invalid", path, `${path} must be an integer.`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be a safe integer >= ${minimum}; received ${String(value)}.`,
    );
    return undefined;
  }
  return value;
}

/**
 * The rule that gives report item (b) its teeth: a {@link Decimal} position holds a *string*.
 *
 * A JSON number here is rejected even when it is an integer (`tpr: 1`), which is what makes this
 * check independent of the payload-wide float rule rather than a duplicate of it.
 */
function requireDecimal(value: unknown, path: string, ctx: Context): void {
  if (typeof value === "number") {
    error(
      ctx,
      "evalset.decimal_not_string",
      path,
      `${path} must be a decimal string such as "0.93", not a JSON number. JSON numbers are formatted by the JS engine, so a verifier written in another language could not reproduce this hash.`,
    );
    return;
  }
  if (typeof value !== "string") {
    error(ctx, "evalset.decimal_not_string", path, `${path} must be a decimal string.`);
    return;
  }
  if (value.length > MAX_DECIMAL_LENGTH) {
    error(
      ctx,
      "evalset.decimal_malformed",
      path,
      `${path} exceeds ${MAX_DECIMAL_LENGTH} characters.`,
    );
    return;
  }
  if (!DECIMAL_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.decimal_malformed",
      path,
      `${path} must match -?(0|[1-9][0-9]*)(\\.[0-9]+)? — no exponent, no leading '+', no leading zeros; received ${JSON.stringify(value)}.`,
    );
    return;
  }
  if (/^-0(?:\.0+)?$/u.test(value)) {
    error(
      ctx,
      "evalset.decimal_malformed",
      path,
      `${path} must not be a negative zero; write ${JSON.stringify(value.slice(1))}.`,
    );
  }
}

function requireDigest(value: unknown, path: string, ctx: Context): string | undefined {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be a digest of the form sha256:<64 lowercase hex>.`,
    );
    return undefined;
  }
  return value;
}

function requireTimestamp(value: unknown, path: string, ctx: Context): string | undefined {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be an ISO-8601 UTC timestamp at second precision (YYYY-MM-DDTHH:MM:SSZ). One instant must have exactly one spelling, or two identical eval sets get two hashes.`,
    );
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(/\.\d{3}Z$/u, "Z") !== value) {
    error(ctx, "evalset.schema.invalid", path, `${path} is not a real UTC instant.`);
    return undefined;
  }
  return value;
}

function checkFreeText(value: unknown, path: string, ctx: Context): void {
  if (typeof value !== "string") {
    return;
  }
  if (EMAIL_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.pii_in_free_text",
      path,
      `${path} looks like it contains an email address. Manifest free text is world-readable and immutable; use a pseudonymous handle.`,
    );
  }
  if (SSN_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.pii_in_free_text",
      path,
      `${path} looks like it contains a government identifier.`,
    );
  }
  if (PHONE_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.pii_in_free_text",
      path,
      `${path} looks like it contains a phone number.`,
    );
  }
}

function validateBundleShape(
  value: unknown,
  options: ValidateEvalSetOptions,
  ctx: Context,
): void {
  const bundle = requireRecord(value, "$", ctx);
  if (bundle === undefined) {
    return;
  }
  checkKeys(bundle, "$", ["apiVersion", "kind", "manifest", "index"], [], ctx);
  requireLiteral(bundle.apiVersion, EVAL_SET_API_VERSION, "$.apiVersion", ctx);
  requireLiteral(bundle.kind, "EvalSet", "$.kind", ctx);

  const targets = validateManifest(bundle.manifest, options, ctx);
  validateIndex(bundle.index, targets, ctx);
}

function validateManifest(
  value: unknown,
  options: ValidateEvalSetOptions,
  ctx: Context,
): ReadonlySet<string> {
  const path = "$.manifest";
  const manifest = requireRecord(value, path, ctx);
  if (manifest === undefined) {
    return new Set();
  }
  checkKeys(
    manifest,
    path,
    [
      "metadata",
      "workflowName",
      "workflowLwirSha",
      "constructs",
      "sampling",
      "sealPolicy",
      "desiderata",
      "generation",
      "audit",
      "judge",
      "independence",
      "noiseFloor",
      "canaryGuid",
      "lifecycle",
      "pii",
    ],
    ["parentEvalSetSha", "migrationSha", "extensions"],
    ctx,
  );

  validateMetadata(manifest.metadata, `${path}.metadata`, ctx);

  const workflowName = requireString(manifest.workflowName, `${path}.workflowName`, ctx);
  requireDigest(manifest.workflowLwirSha, `${path}.workflowLwirSha`, ctx);
  if (manifest.parentEvalSetSha !== undefined) {
    requireDigest(manifest.parentEvalSetSha, `${path}.parentEvalSetSha`, ctx);
  }
  if (manifest.migrationSha !== undefined) {
    requireDigest(manifest.migrationSha, `${path}.migrationSha`, ctx);
  }

  if (workflowName !== undefined && options.knownLineages !== undefined) {
    const known = new Set(options.knownLineages);
    if (!known.has(workflowName)) {
      warn(
        ctx,
        "evalset.unknown_lineage",
        `${path}.workflowName`,
        `Lineage '${workflowName}' has not been seen before${known.size === 0 ? "" : ` (known: ${[...known].sort(compareStrings).join(", ")})`}. If this workflow was renamed, its existing eval sets are now orphaned under the old name — migrate them rather than starting a new lineage.`,
      );
    }
  }

  const targets = validateConstructs(manifest.constructs, `${path}.constructs`, ctx);
  validateSampling(manifest.sampling, `${path}.sampling`, ctx);
  validateSealPolicy(manifest.sealPolicy, `${path}.sealPolicy`, ctx);
  validateDesiderata(manifest.desiderata, `${path}.desiderata`, ctx);
  validateGeneration(manifest.generation, `${path}.generation`, ctx);
  validateAudit(manifest.audit, `${path}.audit`, ctx);
  validateJudge(manifest.judge, `${path}.judge`, ctx);
  validateIndependence(manifest.independence, `${path}.independence`, ctx);
  validateNoiseFloor(manifest.noiseFloor, `${path}.noiseFloor`, ctx);
  validateCanary(manifest.canaryGuid, `${path}.canaryGuid`, ctx);
  validateLifecycle(manifest.lifecycle, `${path}.lifecycle`, ctx);
  validatePii(manifest.pii, `${path}.pii`, ctx);
  validateExtensions(manifest.extensions, `${path}.extensions`, ctx);

  return targets;
}

function validateMetadata(value: unknown, path: string, ctx: Context): void {
  const metadata = requireRecord(value, path, ctx);
  if (metadata === undefined) {
    return;
  }
  checkKeys(metadata, path, ["name", "createdAt"], ["description"], ctx);
  requireString(metadata.name, `${path}.name`, ctx);
  requireTimestamp(metadata.createdAt, `${path}.createdAt`, ctx);
  if (metadata.description !== undefined) {
    requireString(metadata.description, `${path}.description`, ctx);
    checkFreeText(metadata.description, `${path}.description`, ctx);
  }
}

function validateConstructs(value: unknown, path: string, ctx: Context): ReadonlySet<string> {
  const targets = new Set<string>();
  const constructs = requireArray(value, path, ctx);
  if (constructs === undefined) {
    return targets;
  }
  if (constructs.length === 0) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must declare at least one construct: the pass criterion is written before items are generated, and an item with no construct cannot be scored.`,
    );
  }
  for (let index = 0; index < constructs.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const construct = requireRecord(constructs[index], entryPath, ctx);
    if (construct === undefined) {
      continue;
    }
    checkKeys(
      construct,
      entryPath,
      ["target", "passCriterion", "criteria", "resampleK", "authoredAt"],
      [],
      ctx,
    );
    const target = requireString(construct.target, `${entryPath}.target`, ctx);
    if (target !== undefined) {
      if (targets.has(target)) {
        error(
          ctx,
          "evalset.duplicate_construct",
          `${entryPath}.target`,
          `Target '${target}' is defined by more than one construct.`,
        );
      }
      targets.add(target);
    }
    requireString(construct.passCriterion, `${entryPath}.passCriterion`, ctx);
    checkFreeText(construct.passCriterion, `${entryPath}.passCriterion`, ctx);
    requireInteger(construct.resampleK, `${entryPath}.resampleK`, ctx, 1);
    requireTimestamp(construct.authoredAt, `${entryPath}.authoredAt`, ctx);

    const criteria = requireArray(construct.criteria, `${entryPath}.criteria`, ctx);
    if (criteria === undefined) {
      continue;
    }
    const criterionIds = new Set<string>();
    for (let criterionIndex = 0; criterionIndex < criteria.length; criterionIndex += 1) {
      const criterionPath = `${entryPath}.criteria[${criterionIndex}]`;
      const criterion = requireRecord(criteria[criterionIndex], criterionPath, ctx);
      if (criterion === undefined) {
        continue;
      }
      checkKeys(criterion, criterionPath, ["id", "text"], [], ctx);
      const id = requireString(criterion.id, `${criterionPath}.id`, ctx);
      if (id !== undefined) {
        if (criterionIds.has(id)) {
          error(
            ctx,
            "evalset.duplicate_criterion",
            `${criterionPath}.id`,
            `Criterion id '${id}' is declared twice for target '${String(construct.target)}'.`,
          );
        }
        criterionIds.add(id);
      }
      requireString(criterion.text, `${criterionPath}.text`, ctx);
      checkFreeText(criterion.text, `${criterionPath}.text`, ctx);
    }
  }
  return targets;
}

function validateSampling(value: unknown, path: string, ctx: Context): void {
  const sampling = requireRecord(value, path, ctx);
  if (sampling === undefined) {
    return;
  }
  checkKeys(sampling, path, ["strategy", "strata"], ["window"], ctx);
  requireEnum(sampling.strategy, SAMPLING_STRATEGIES, `${path}.strategy`, ctx);
  if (sampling.window !== undefined) {
    const window = requireRecord(sampling.window, `${path}.window`, ctx);
    if (window !== undefined) {
      checkKeys(window, `${path}.window`, ["fromAt", "toAt"], [], ctx);
      const fromAt = requireTimestamp(window.fromAt, `${path}.window.fromAt`, ctx);
      const toAt = requireTimestamp(window.toAt, `${path}.window.toAt`, ctx);
      if (fromAt !== undefined && toAt !== undefined && fromAt > toAt) {
        error(
          ctx,
          "evalset.schema.invalid",
          `${path}.window`,
          `${path}.window.fromAt must not be after toAt.`,
        );
      }
    }
  }
  const strata = requireArray(sampling.strata, `${path}.strata`, ctx);
  if (strata === undefined) {
    return;
  }
  const ids = new Set<string>();
  for (let index = 0; index < strata.length; index += 1) {
    const entryPath = `${path}.strata[${index}]`;
    const stratum = requireRecord(strata[index], entryPath, ctx);
    if (stratum === undefined) {
      continue;
    }
    checkKeys(stratum, entryPath, ["id", "definition", "count"], [], ctx);
    const id = requireString(stratum.id, `${entryPath}.id`, ctx);
    if (id !== undefined) {
      if (ids.has(id)) {
        error(ctx, "evalset.schema.invalid", `${entryPath}.id`, `Stratum id '${id}' is repeated.`);
      }
      ids.add(id);
    }
    requireString(stratum.definition, `${entryPath}.definition`, ctx);
    requireInteger(stratum.count, `${entryPath}.count`, ctx);
  }
}

function validateSealPolicy(value: unknown, path: string, ctx: Context): void {
  const policy = requireRecord(value, path, ctx);
  if (policy === undefined) {
    return;
  }
  checkKeys(policy, path, ["algorithm", "sealKeyId", "custody", "cutoff", "domain"], [], ctx);
  requireLiteral(policy.algorithm, "HMAC-SHA256", `${path}.algorithm`, ctx);
  if (typeof policy.sealKeyId !== "string" || !SEAL_KEY_ID_PATTERN.test(policy.sealKeyId)) {
    error(
      ctx,
      "evalset.schema.invalid",
      `${path}.sealKeyId`,
      `${path}.sealKeyId must be "hmac-sha256-id:<64 lowercase hex>" — a KDF-derived identifier, never the key and never a plain hash of it.`,
    );
  }
  requireEnum(policy.custody, SEAL_CUSTODY, `${path}.custody`, ctx);
  validateCutoff(policy.cutoff, `${path}.cutoff`, ctx);
  requireString(policy.domain, `${path}.domain`, ctx);
}

function validateCutoff(value: unknown, path: string, ctx: Context): void {
  if (typeof value === "number") {
    error(
      ctx,
      "evalset.decimal_not_string",
      path,
      `${path} must be a decimal uint64 string: it exceeds Number.MAX_SAFE_INTEGER and it decides gate membership, so it has to be bit-reproducible in any language.`,
    );
    return;
  }
  if (typeof value !== "string" || !UINT64_PATTERN.test(value)) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be an unsigned decimal integer string with no leading zeros.`,
    );
    return;
  }
  if (BigInt(value) > UINT64_MAX) {
    error(ctx, "evalset.schema.invalid", path, `${path} exceeds 2^64 - 1.`);
  }
}

function validateDesiderata(value: unknown, path: string, ctx: Context): void {
  const desiderata = requireRecord(value, path, ctx);
  if (desiderata === undefined) {
    return;
  }
  checkKeys(
    desiderata,
    path,
    ["difficultyBand", "coverage", "diversityClusters"],
    ["separability"],
    ctx,
  );
  const band = requireRecord(desiderata.difficultyBand, `${path}.difficultyBand`, ctx);
  if (band !== undefined) {
    checkKeys(band, `${path}.difficultyBand`, ["targetLow", "targetHigh", "achieved"], [], ctx);
    requireDecimal(band.targetLow, `${path}.difficultyBand.targetLow`, ctx);
    requireDecimal(band.targetHigh, `${path}.difficultyBand.targetHigh`, ctx);
    requireDecimal(band.achieved, `${path}.difficultyBand.achieved`, ctx);
  }
  const coverage = requireRecord(desiderata.coverage, `${path}.coverage`, ctx);
  if (coverage !== undefined) {
    checkKeys(coverage, `${path}.coverage`, ["target", "achieved", "basis"], [], ctx);
    requireDecimal(coverage.target, `${path}.coverage.target`, ctx);
    requireDecimal(coverage.achieved, `${path}.coverage.achieved`, ctx);
    requireString(coverage.basis, `${path}.coverage.basis`, ctx);
  }
  const clusters = requireRecord(desiderata.diversityClusters, `${path}.diversityClusters`, ctx);
  if (clusters !== undefined) {
    checkKeys(clusters, `${path}.diversityClusters`, ["target", "achieved"], [], ctx);
    requireInteger(clusters.target, `${path}.diversityClusters.target`, ctx);
    requireInteger(clusters.achieved, `${path}.diversityClusters.achieved`, ctx);
  }
  if (desiderata.separability !== undefined) {
    const separability = requireRecord(desiderata.separability, `${path}.separability`, ctx);
    if (separability !== undefined) {
      checkKeys(separability, `${path}.separability`, ["target", "achieved"], [], ctx);
      requireDecimal(separability.target, `${path}.separability.target`, ctx);
      requireDecimal(separability.achieved, `${path}.separability.achieved`, ctx);
    }
  }
}

function validateGeneration(value: unknown, path: string, ctx: Context): void {
  const generation = requireRecord(value, path, ctx);
  if (generation === undefined) {
    return;
  }
  checkKeys(
    generation,
    path,
    ["candidatesGenerated", "admitted", "rejectedByStage", "authorModel"],
    [],
    ctx,
  );
  const candidates = requireInteger(
    generation.candidatesGenerated,
    `${path}.candidatesGenerated`,
    ctx,
  );
  const admitted = requireInteger(generation.admitted, `${path}.admitted`, ctx);
  if (candidates !== undefined && admitted !== undefined && admitted > candidates) {
    error(
      ctx,
      "evalset.schema.invalid",
      `${path}.admitted`,
      `${path}.admitted (${admitted}) cannot exceed candidatesGenerated (${candidates}); the keep rate is derived from these two integers.`,
    );
  }
  const stages = requireArray(generation.rejectedByStage, `${path}.rejectedByStage`, ctx);
  if (stages !== undefined) {
    for (let index = 0; index < stages.length; index += 1) {
      const entryPath = `${path}.rejectedByStage[${index}]`;
      const stage = requireRecord(stages[index], entryPath, ctx);
      if (stage === undefined) {
        continue;
      }
      checkKeys(stage, entryPath, ["stage", "count"], [], ctx);
      requireString(stage.stage, `${entryPath}.stage`, ctx);
      requireInteger(stage.count, `${entryPath}.count`, ctx);
    }
  }
  validateModelPin(generation.authorModel, `${path}.authorModel`, ctx);
}

function validateModelPin(value: unknown, path: string, ctx: Context): void {
  const pin = requireRecord(value, path, ctx);
  if (pin === undefined) {
    return;
  }
  checkKeys(pin, path, ["providerId", "modelId", "family"], [], ctx);
  requireString(pin.providerId, `${path}.providerId`, ctx);
  requireString(pin.modelId, `${path}.modelId`, ctx);
  requireString(pin.family, `${path}.family`, ctx);
}

function validateAudit(value: unknown, path: string, ctx: Context): void {
  const audit = requireRecord(value, path, ctx);
  if (audit === undefined) {
    return;
  }
  checkKeys(audit, path, ["nAudited", "raters", "labelErrorEstimate"], ["fleissKappa"], ctx);
  requireInteger(audit.nAudited, `${path}.nAudited`, ctx);
  const raters = requireArray(audit.raters, `${path}.raters`, ctx);
  if (raters !== undefined) {
    for (let index = 0; index < raters.length; index += 1) {
      const entryPath = `${path}.raters[${index}]`;
      const rater = requireRecord(raters[index], entryPath, ctx);
      if (rater === undefined) {
        continue;
      }
      checkKeys(rater, entryPath, ["ref", "kind"], [], ctx);
      requireString(rater.ref, `${entryPath}.ref`, ctx);
      checkFreeText(rater.ref, `${entryPath}.ref`, ctx);
      requireEnum(rater.kind, ["human", "model"] as const, `${entryPath}.kind`, ctx);
    }
  }
  const estimate = requireRecord(audit.labelErrorEstimate, `${path}.labelErrorEstimate`, ctx);
  if (estimate !== undefined) {
    checkKeys(estimate, `${path}.labelErrorEstimate`, ["point", "ciLow", "ciHigh"], [], ctx);
    requireDecimal(estimate.point, `${path}.labelErrorEstimate.point`, ctx);
    requireDecimal(estimate.ciLow, `${path}.labelErrorEstimate.ciLow`, ctx);
    requireDecimal(estimate.ciHigh, `${path}.labelErrorEstimate.ciHigh`, ctx);
  }
  if (audit.fleissKappa !== undefined) {
    requireDecimal(audit.fleissKappa, `${path}.fleissKappa`, ctx);
  }
}

function validateJudge(value: unknown, path: string, ctx: Context): void {
  const judge = requireRecord(value, path, ctx);
  if (judge === undefined) {
    return;
  }
  checkKeys(
    judge,
    path,
    ["modelPin", "rubricSha", "calibrationSetSha", "tpr", "tnr"],
    ["kappaVsHuman", "kappaHumanHuman", "alignmentScore"],
    ctx,
  );
  validateModelPin(judge.modelPin, `${path}.modelPin`, ctx);
  requireDigest(judge.rubricSha, `${path}.rubricSha`, ctx);
  requireDigest(judge.calibrationSetSha, `${path}.calibrationSetSha`, ctx);
  requireDecimal(judge.tpr, `${path}.tpr`, ctx);
  requireDecimal(judge.tnr, `${path}.tnr`, ctx);
  for (const key of ["kappaVsHuman", "kappaHumanHuman", "alignmentScore"] as const) {
    if (judge[key] !== undefined) {
      requireDecimal(judge[key], `${path}.${key}`, ctx);
    }
  }
}

function validateIndependence(value: unknown, path: string, ctx: Context): void {
  const independence = requireRecord(value, path, ctx);
  if (independence === undefined) {
    return;
  }
  checkKeys(
    independence,
    path,
    ["evalAuthorFamily", "workflowAuthorFamily", "distinct"],
    ["humanReviewerRef"],
    ctx,
  );
  const evalFamily = requireString(
    independence.evalAuthorFamily,
    `${path}.evalAuthorFamily`,
    ctx,
  );
  const workflowFamily = requireString(
    independence.workflowAuthorFamily,
    `${path}.workflowAuthorFamily`,
    ctx,
  );
  const distinct = requireBoolean(independence.distinct, `${path}.distinct`, ctx);
  if (evalFamily !== undefined && workflowFamily !== undefined && distinct !== undefined) {
    const actual = evalFamily !== workflowFamily;
    if (actual !== distinct) {
      error(
        ctx,
        "evalset.independence_inconsistent",
        `${path}.distinct`,
        `${path}.distinct is ${String(distinct)} but evalAuthorFamily '${evalFamily}' and workflowAuthorFamily '${workflowFamily}' are ${actual ? "different" : "the same"}. The attestation must agree with the fields it attests to.`,
      );
    }
  }
  if (independence.humanReviewerRef !== undefined) {
    requireString(independence.humanReviewerRef, `${path}.humanReviewerRef`, ctx);
    checkFreeText(independence.humanReviewerRef, `${path}.humanReviewerRef`, ctx);
  }
}

function validateNoiseFloor(value: unknown, path: string, ctx: Context): void {
  const noiseFloor = requireRecord(value, path, ctx);
  if (noiseFloor === undefined) {
    return;
  }
  checkKeys(
    noiseFloor,
    path,
    ["method", "runs", "deltaPpP50", "deltaPpP95", "measuredAt"],
    [],
    ctx,
  );
  requireLiteral(noiseFloor.method, "incumbent_rerun", `${path}.method`, ctx);
  requireInteger(noiseFloor.runs, `${path}.runs`, ctx, 1);
  requireDecimal(noiseFloor.deltaPpP50, `${path}.deltaPpP50`, ctx);
  requireDecimal(noiseFloor.deltaPpP95, `${path}.deltaPpP95`, ctx);
  requireTimestamp(noiseFloor.measuredAt, `${path}.measuredAt`, ctx);
}

function validateCanary(value: unknown, path: string, ctx: Context): void {
  const canary = requireString(value, path, ctx);
  if (canary === undefined) {
    return;
  }
  if (canary.length < MIN_CANARY_LENGTH || /\s/u.test(canary)) {
    error(
      ctx,
      "evalset.schema.invalid",
      path,
      `${path} must be a whitespace-free string of at least ${MIN_CANARY_LENGTH} characters: it exists to be greppable in a leaked context.`,
    );
  }
}

function validateLifecycle(value: unknown, path: string, ctx: Context): void {
  const lifecycle = requireRecord(value, path, ctx);
  if (lifecycle === undefined) {
    return;
  }
  checkKeys(lifecycle, path, ["refresh", "gateQueryBudget"], ["expiresAt"], ctx);
  if (lifecycle.expiresAt !== undefined) {
    requireTimestamp(lifecycle.expiresAt, `${path}.expiresAt`, ctx);
  }
  const refresh = requireRecord(lifecycle.refresh, `${path}.refresh`, ctx);
  if (refresh !== undefined) {
    checkKeys(
      refresh,
      `${path}.refresh`,
      ["policy", "numerator", "denominator", "cadence"],
      [],
      ctx,
    );
    requireLiteral(refresh.policy, "rotate_fraction", `${path}.refresh.policy`, ctx);
    const numerator = requireInteger(refresh.numerator, `${path}.refresh.numerator`, ctx);
    const denominator = requireInteger(refresh.denominator, `${path}.refresh.denominator`, ctx, 1);
    if (numerator !== undefined && denominator !== undefined && numerator > denominator) {
      error(
        ctx,
        "evalset.schema.invalid",
        `${path}.refresh.numerator`,
        `${path}.refresh must be a fraction <= 1; received ${numerator}/${denominator}.`,
      );
    }
    requireString(refresh.cadence, `${path}.refresh.cadence`, ctx);
  }
  requireInteger(lifecycle.gateQueryBudget, `${path}.gateQueryBudget`, ctx);
}

function validatePii(value: unknown, path: string, ctx: Context): void {
  const pii = requireRecord(value, path, ctx);
  if (pii === undefined) {
    return;
  }
  checkKeys(pii, path, ["status", "retentionClass"], ["disposalDue"], ctx);
  const status = requireEnum(pii.status, PII_STATUSES, `${path}.status`, ctx);
  requireString(pii.retentionClass, `${path}.retentionClass`, ctx);
  if (pii.disposalDue !== undefined) {
    requireTimestamp(pii.disposalDue, `${path}.disposalDue`, ctx);
  } else if (status !== undefined && status !== "synthetic") {
    error(
      ctx,
      "evalset.schema.missing",
      `${path}.disposalDue`,
      `${path}.disposalDue is required when pii.status is '${status}': a non-synthetic set carries a disposal clock.`,
    );
  }
}

function validateExtensions(value: unknown, path: string, ctx: Context): void {
  if (value === undefined) {
    return;
  }
  const extensions = requireRecord(value, path, ctx);
  if (extensions === undefined) {
    return;
  }
  for (const key of Object.keys(extensions)) {
    if (!EXTENSION_NAMESPACE_PATTERN.test(key)) {
      error(
        ctx,
        "evalset.extension_key_unnamespaced",
        `${path}.${key}`,
        `Extension keys must be namespaced and versioned, e.g. "lending.fairness/v1"; received ${JSON.stringify(key)}.`,
      );
    }
  }
}

function validateIndex(value: unknown, targets: ReadonlySet<string>, ctx: Context): void {
  const path = "$.index";
  const index = requireArray(value, path, ctx);
  if (index === undefined) {
    return;
  }
  let previousItemSha: string | undefined;
  const rolesByVariantGroup = new Map<string, { readonly role: string; readonly at: number }>();

  for (let position = 0; position < index.length; position += 1) {
    const entryPath = `${path}[${position}]`;
    const entry = requireRecord(index[position], entryPath, ctx);
    if (entry === undefined) {
      continue;
    }
    for (const forbidden of FORBIDDEN_INDEX_KEYS) {
      if (Object.hasOwn(entry, forbidden)) {
        error(
          ctx,
          "evalset.index_run_pointer",
          `${entryPath}.${forbidden}`,
          `Index entries must not carry '${forbidden}'. A run or event pointer dereferences to the item's recorded input for anything with run-history access, so putting one in the readable half would hand every authoring session the gate and honeypot inputs the manifest/body split exists to withhold. Provenance belongs in the item body.`,
        );
      }
    }
    checkKeys(
      entry,
      entryPath,
      [
        "itemSha",
        "bodySha",
        "target",
        "role",
        "replayValidity",
        "labelProvenance",
        "clusterId",
        "referencedFields",
        "inputConeHash",
        "inputConeAlgorithm",
        "createdAt",
      ],
      ["variantGroupId", "resampleK"],
      ctx,
    );

    const itemSha = requireDigest(entry.itemSha, `${entryPath}.itemSha`, ctx);
    requireDigest(entry.bodySha, `${entryPath}.bodySha`, ctx);
    if (itemSha !== undefined) {
      if (previousItemSha !== undefined && compareStrings(previousItemSha, itemSha) >= 0) {
        error(
          ctx,
          "evalset.index_unsorted",
          `${entryPath}.itemSha`,
          `Index entries must be strictly ascending by itemSha: ${itemSha} follows ${previousItemSha}. The canonicalizer does not sort arrays, so the order is part of eval_set_sha, and strictness is what makes a duplicate item sha impossible.`,
        );
      }
      previousItemSha = itemSha;
    }

    const target = requireString(entry.target, `${entryPath}.target`, ctx);
    if (target !== undefined && targets.size > 0 && !targets.has(target)) {
      error(
        ctx,
        "evalset.unknown_target",
        `${entryPath}.target`,
        `No construct declares target '${target}', so this item has no pass criterion.`,
      );
    }

    const role = requireEnum(entry.role, EVAL_ITEM_ROLES, `${entryPath}.role`, ctx);
    if (entry.role === "gate_sealed" || entry.role === "gate_dev") {
      error(
        ctx,
        "evalset.sealed_role",
        `${entryPath}.role`,
        `'${String(entry.role)}' is not a role. Store 'gate' — the union of the dev and sealed splits — and let the key holder compute the partition at gate time; a queryable sealed flag is precisely the stored membership list sealing exists to forbid.`,
      );
    }
    requireEnum(entry.replayValidity, REPLAY_VALIDITY_CLASSES, `${entryPath}.replayValidity`, ctx);
    requireEnum(entry.labelProvenance, LABEL_PROVENANCES, `${entryPath}.labelProvenance`, ctx);
    requireString(entry.clusterId, `${entryPath}.clusterId`, ctx);
    requireDigest(entry.inputConeHash, `${entryPath}.inputConeHash`, ctx);
    requireLiteral(
      entry.inputConeAlgorithm,
      LWIR_INPUT_CONE_ALGORITHM,
      `${entryPath}.inputConeAlgorithm`,
      ctx,
    );
    requireTimestamp(entry.createdAt, `${entryPath}.createdAt`, ctx);
    if (entry.resampleK !== undefined) {
      requireInteger(entry.resampleK, `${entryPath}.resampleK`, ctx, 1);
    }

    validateReferencedFields(entry.referencedFields, `${entryPath}.referencedFields`, ctx);

    if (entry.variantGroupId !== undefined) {
      const groupId = requireString(entry.variantGroupId, `${entryPath}.variantGroupId`, ctx);
      if (groupId !== undefined && role !== undefined) {
        const previous = rolesByVariantGroup.get(groupId);
        if (previous === undefined) {
          rolesByVariantGroup.set(groupId, { role, at: position });
        } else if (previous.role !== role) {
          error(
            ctx,
            "evalset.variant_group_role_conflict",
            `${entryPath}.role`,
            `Variant group '${groupId}' holds role '${previous.role}' at index ${previous.at} and '${role}' here. A paraphrase of a gate item has a different item sha, so nothing downstream can catch this: a mixed-role variant group leaks the gate item into the optimizer set.`,
          );
        }
      }
    }
  }
}

function validateReferencedFields(value: unknown, path: string, ctx: Context): void {
  const fields = requireArray(value, path, ctx);
  if (fields === undefined) {
    return;
  }
  let previous: string | undefined;
  for (let index = 0; index < fields.length; index += 1) {
    const field = requireString(fields[index], `${path}[${index}]`, ctx);
    if (field === undefined) {
      continue;
    }
    if (previous !== undefined && compareStrings(previous, field) >= 0) {
      error(
        ctx,
        "evalset.referenced_fields_unsorted",
        `${path}[${index}]`,
        `${path} must be sorted ascending and deduplicated so that a cosmetic reordering cannot change eval_set_sha.`,
      );
    }
    previous = field;
  }
}

function validateBodyShape(
  value: unknown,
  pii: PiiPolicy | undefined,
  path: string,
  ctx: Context,
): void {
  const body = requireRecord(value, path, ctx);
  if (body === undefined) {
    return;
  }
  checkKeys(
    body,
    path,
    ["apiVersion", "kind", "target", "input", "label", "rubric", "provenance"],
    ["referenceAnswer"],
    ctx,
  );
  requireLiteral(body.apiVersion, EVAL_ITEM_API_VERSION, `${path}.apiVersion`, ctx);
  requireLiteral(body.kind, "EvalItem", `${path}.kind`, ctx);
  requireString(body.target, `${path}.target`, ctx);

  validateContent(body.input, pii, `${path}.input`, ctx);
  if (body.referenceAnswer !== undefined) {
    validateContent(body.referenceAnswer, pii, `${path}.referenceAnswer`, ctx);
  }
  validateLabel(body.label, `${path}.label`, ctx);

  const rubric = requireArray(body.rubric, `${path}.rubric`, ctx);
  if (rubric !== undefined) {
    const seen = new Set<string>();
    for (let index = 0; index < rubric.length; index += 1) {
      const entryPath = `${path}.rubric[${index}]`;
      const criterion = requireRecord(rubric[index], entryPath, ctx);
      if (criterion === undefined) {
        continue;
      }
      checkKeys(criterion, entryPath, ["criterionId", "expected"], [], ctx);
      const criterionId = requireString(criterion.criterionId, `${entryPath}.criterionId`, ctx);
      if (criterionId !== undefined) {
        if (seen.has(criterionId)) {
          error(
            ctx,
            "evalset.duplicate_criterion",
            `${entryPath}.criterionId`,
            `Criterion '${criterionId}' appears twice in this rubric.`,
          );
        }
        seen.add(criterionId);
      }
      requireBoolean(criterion.expected, `${entryPath}.expected`, ctx);
    }
  }

  const provenance = requireArray(body.provenance, `${path}.provenance`, ctx);
  if (provenance !== undefined) {
    for (let index = 0; index < provenance.length; index += 1) {
      const entryPath = `${path}.provenance[${index}]`;
      const pointer = requireRecord(provenance[index], entryPath, ctx);
      if (pointer === undefined) {
        continue;
      }
      checkKeys(pointer, entryPath, ["runId", "sequence"], ["eventId"], ctx);
      requireString(pointer.runId, `${entryPath}.runId`, ctx);
      requireInteger(pointer.sequence, `${entryPath}.sequence`, ctx);
      if (pointer.eventId !== undefined) {
        requireString(pointer.eventId, `${entryPath}.eventId`, ctx);
      }
    }
  }
}

function validateContent(
  value: unknown,
  pii: PiiPolicy | undefined,
  path: string,
  ctx: Context,
): void {
  const content = requireRecord(value, path, ctx);
  if (content === undefined) {
    return;
  }
  const kind = requireEnum(content.kind, ["inline", "vault"] as const, `${path}.kind`, ctx);
  if (kind === "inline") {
    checkKeys(content, path, ["kind", "value"], [], ctx);
    if (pii === undefined) {
      error(
        ctx,
        "evalset.inline_content_requires_pii_policy",
        path,
        `Inline item content can only be validated against a PII policy. Register the body with the owning bundle's { pii } so the check runs before anything is hashed.`,
      );
    } else if (pii.status !== "synthetic") {
      error(
        ctx,
        "evalset.inline_content_not_synthetic",
        path,
        `Inline content is legal only when the manifest declares pii.status === "synthetic"; this manifest declares '${pii.status}'. Use { kind: "vault", vaultRef, shape } so disposal can be executed by shredding a key rather than by deleting immutable evidence.`,
      );
    }
    return;
  }
  if (kind === "vault") {
    checkKeys(content, path, ["kind", "vaultRef", "shape"], [], ctx);
    requireString(content.vaultRef, `${path}.vaultRef`, ctx);
  }
}

function validateLabel(value: unknown, path: string, ctx: Context): void {
  const label = requireRecord(value, path, ctx);
  if (label === undefined) {
    return;
  }
  checkKeys(label, path, ["provenance", "value"], ["evidence"], ctx);
  requireEnum(label.provenance, LABEL_PROVENANCES, `${path}.provenance`, ctx);
  if (label.evidence === undefined) {
    return;
  }
  const evidence = requireRecord(label.evidence, `${path}.evidence`, ctx);
  if (evidence === undefined) {
    return;
  }
  const evidencePath = `${path}.evidence`;
  const kind = requireEnum(
    evidence.kind,
    ["citation", "mutation", "replay"] as const,
    `${evidencePath}.kind`,
    ctx,
  );
  if (kind === "citation") {
    checkKeys(evidence, evidencePath, ["kind", "sourceSha", "locator", "matchScore"], [], ctx);
    requireDigest(evidence.sourceSha, `${evidencePath}.sourceSha`, ctx);
    requireString(evidence.locator, `${evidencePath}.locator`, ctx);
    requireDecimal(evidence.matchScore, `${evidencePath}.matchScore`, ctx);
    return;
  }
  if (kind === "mutation") {
    checkKeys(evidence, evidencePath, ["kind", "baseItemSha", "transform", "entailedVia"], [], ctx);
    requireDigest(evidence.baseItemSha, `${evidencePath}.baseItemSha`, ctx);
    requireString(evidence.transform, `${evidencePath}.transform`, ctx);
    validateReferencedFields(evidence.entailedVia, `${evidencePath}.entailedVia`, ctx);
    return;
  }
  if (kind === "replay") {
    checkKeys(evidence, evidencePath, ["kind", "runId", "sequence"], [], ctx);
    requireString(evidence.runId, `${evidencePath}.runId`, ctx);
    requireInteger(evidence.sequence, `${evidencePath}.sequence`, ctx);
  }
}

/** UTF-16 code-unit order — the ordering `canonicalJson` applies to object keys. Never `localeCompare`. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
}
