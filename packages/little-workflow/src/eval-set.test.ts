import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  assertValidEvalSet,
  EVAL_ITEM_API_VERSION,
  EVAL_ITEM_ROLES,
  EVAL_SET_API_VERSION,
  EVAL_SET_CANONICALIZER,
  evalItemBodySha,
  evalItemIdentity,
  evalItemSha,
  EvalSetValidationError,
  registerEvalItemBody,
  registerEvalSet,
  sortEvalSetIndex,
  validateEvalItemBody,
  validateEvalSet,
  verifyEvalSetBodies,
  type EvalItemBody,
  type EvalSetBundle,
  type EvalSetValidationResult,
  type PiiPolicy,
} from "./eval-set.js";
import { LWIR_INPUT_CONE_ALGORITHM } from "./lwir-input-cone.js";

type Record_ = Record<string, unknown>;

const SEAL_KEY_ID = `hmac-sha256-id:${sha256Digest("seal-key").slice("sha256:".length)}`;

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

function entryFor(item: EvalItemBody, overrides: Record_ = {}): Record_ {
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
    ...overrides,
  };
}

function card(overrides: Record_ = {}): Record_ {
  return {
    metadata: {
      name: "support.summarize.gate",
      description: "Gate set for the support summariser.",
      createdAt: "2026-08-01T09:00:00Z",
    },
    workflowName: "support.summarize",
    workflowLwirSha: sha256Digest("lwir"),
    constructs: [
      {
        target: "summarize",
        passCriterion: "The summary names the severity and the affected system.",
        criteria: [{ id: "names-severity", text: "Severity is stated explicitly." }],
        resampleK: 3,
        authoredAt: "2026-07-30T12:00:00Z",
      },
    ],
    sampling: {
      strategy: "replay_window",
      window: { fromAt: "2026-06-01T00:00:00Z", toAt: "2026-07-01T00:00:00Z" },
      strata: [{ id: "p1", definition: "priority = 1", count: 40 }],
    },
    sealPolicy: {
      algorithm: "HMAC-SHA256",
      sealKeyId: SEAL_KEY_ID,
      custody: "dev_local",
      cutoff: "9223372036854775808",
      domain: "evalset-seal/v1/support.summarize",
    },
    desiderata: {
      difficultyBand: { targetLow: "0.30", targetHigh: "0.70", achieved: "0.52" },
      coverage: { target: "0.90", achieved: "0.93", basis: "contract fields touched" },
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
      humanReviewerRef: "reviewer-2",
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
    pii: { status: "synthetic", retentionClass: "evidence-5y" },
    ...overrides,
  };
}

function bundleOf(entries: readonly Record_[], cardOverrides: Record_ = {}): Record_ {
  return {
    apiVersion: EVAL_SET_API_VERSION,
    kind: "EvalSet",
    manifest: card(cardOverrides),
    index: sortIndex(entries),
  };
}

function sortIndex(entries: readonly Record_[]): readonly Record_[] {
  return [...entries].sort((left, right) =>
    String(left.itemSha) < String(right.itemSha) ? -1 : String(left.itemSha) > String(right.itemSha) ? 1 : 0
  );
}

function codes(result: EvalSetValidationResult): readonly string[] {
  return result.findings.map((finding) => finding.code);
}

function warningCodes(result: EvalSetValidationResult): readonly string[] {
  return result.warnings.map((finding) => finding.code);
}

/** Rebuild every object with its keys in reverse order, so nothing is hashed in insertion order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeys(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const result: Record_ = {};
    for (const key of Object.keys(value as Record_).reverse()) {
      result[key] = reverseKeys((value as Record_)[key]);
    }
    return result as T;
  }
  return value;
}

const SYNTHETIC: PiiPolicy = { status: "synthetic", retentionClass: "evidence-5y" };

describe("eval set bundle", () => {
  it("registers a valid bundle with a content-addressed id and the repo digest convention", () => {
    const version = registerEvalSet(bundleOf([entryFor(body())]));

    expect(version.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(version.id).toBe(`evset_${version.hash.slice("sha256:".length, "sha256:".length + 16)}`);
    expect(version.canonicalizer).toBe(EVAL_SET_CANONICALIZER);
    expect(version.canonicalJson).toBe(canonicalJson(version.bundle));
    expect(sha256Digest(version.bundle)).toBe(version.hash);
    expect(Object.isFrozen(version.bundle)).toBe(true);
    expect(Object.isFrozen(version.bundle.index[0])).toBe(true);
  });

  it("hashes independently of key insertion order", () => {
    const bundle = bundleOf([entryFor(body())]);

    const straight = registerEvalSet(bundle);
    const reversed = registerEvalSet(reverseKeys(bundle));

    expect(reversed.hash).toBe(straight.hash);
    expect(reversed.id).toBe(straight.id);
    expect(reversed.canonicalJson).toBe(straight.canonicalJson);
  });

  it("omits undefined-valued properties instead of rejecting them", () => {
    const withUndefined = bundleOf(
      [entryFor(body(), { variantGroupId: undefined, resampleK: undefined })],
      { parentEvalSetSha: undefined, extensions: undefined },
    );
    (withUndefined.manifest as Record_).metadata = {
      name: "support.summarize.gate",
      description: "Gate set for the support summariser.",
      createdAt: "2026-08-01T09:00:00Z",
      // A key that is present but undefined must hash as if it were absent.
      migrationSha: undefined,
    };
    const without = bundleOf([entryFor(body())]);
    (without.manifest as Record_).metadata = {
      name: "support.summarize.gate",
      description: "Gate set for the support summariser.",
      createdAt: "2026-08-01T09:00:00Z",
    };

    expect(registerEvalSet(withUndefined).hash).toBe(registerEvalSet(without).hash);
  });

  it("keeps warnings out of the registered version so they cannot perturb the bytes", () => {
    const bundle = bundleOf([entryFor(body())]);
    const seen: string[] = [];

    const quiet = registerEvalSet(bundle);
    const warned = registerEvalSet(bundle, {
      knownLineages: ["something.else"],
      onWarning: (warning) => seen.push(warning.code),
    });

    expect(seen).toEqual(["evalset.unknown_lineage"]);
    expect(warned.hash).toBe(quiet.hash);
    expect(Object.keys(warned)).toEqual(Object.keys(quiet));
  });
});

describe("eval set decimal encoding", () => {
  it("rejects a JSON float in a Decimal position", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], { judge: { ...(card().judge as Record_), tpr: 0.93 } }),
    );

    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("evalset.decimal_not_string");
    expect(codes(result)).toContain("evalset.float_in_hashed_payload");
    expect(() => registerEvalSet(bundleOf([entryFor(body())], {
      judge: { ...(card().judge as Record_), tpr: 0.93 },
    }))).toThrow(EvalSetValidationError);
  });

  it("rejects an integer JSON number in a Decimal position, which the payload-wide float rule allows", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], { judge: { ...(card().judge as Record_), tnr: 1 } }),
    );

    expect(codes(result)).toContain("evalset.decimal_not_string");
    expect(codes(result)).not.toContain("evalset.float_in_hashed_payload");
  });

  it("rejects a non-integer number anywhere in the hashed payload, including extensions", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], { extensions: { "lending.fairness/v1": { air: 0.82 } } }),
    );

    expect(codes(result)).toContain("evalset.float_in_hashed_payload");
    expect(result.findings.map((finding) => finding.path)).toContain(
      "$.manifest.extensions.lending.fairness/v1.air",
    );
  });

  it("rejects malformed decimal strings", () => {
    for (const malformed of ["1e-3", "+1", "01", "-0", "-0.00", ".5", "1.", "0,5", ""]) {
      const result = validateEvalSet(
        bundleOf([entryFor(body())], { judge: { ...(card().judge as Record_), tpr: malformed } }),
      );
      expect(codes(result), `expected ${JSON.stringify(malformed)} to be rejected`).toContain(
        result.findings.some((finding) => finding.code === "evalset.decimal_malformed")
          ? "evalset.decimal_malformed"
          : "evalset.decimal_not_string",
      );
      expect(result.valid).toBe(false);
    }
  });

  it("accepts decimal strings, trailing zeros included, and treats them as distinct values", () => {
    const withTwoPlaces = registerEvalSet(
      bundleOf([entryFor(body())], { judge: { ...(card().judge as Record_), tpr: "0.90" } }),
    );
    const withOnePlace = registerEvalSet(
      bundleOf([entryFor(body())], { judge: { ...(card().judge as Record_), tpr: "0.9" } }),
    );

    expect(withTwoPlaces.hash).not.toBe(withOnePlace.hash);
  });

  it("requires the seal cutoff to be a uint64 string, never a number", () => {
    const asNumber = validateEvalSet(
      bundleOf([entryFor(body())], {
        sealPolicy: { ...(card().sealPolicy as Record_), cutoff: 9223372036854775808 },
      }),
    );
    const tooLarge = validateEvalSet(
      bundleOf([entryFor(body())], {
        sealPolicy: { ...(card().sealPolicy as Record_), cutoff: "18446744073709551616" },
      }),
    );

    expect(codes(asNumber)).toContain("evalset.decimal_not_string");
    expect(codes(tooLarge)).toContain("evalset.schema.invalid");
  });

  it("never puts the seal key itself in the manifest shape", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], {
        sealPolicy: { ...(card().sealPolicy as Record_), key: "hunter2" },
      }),
    );

    expect(codes(result)).toContain("evalset.schema.unknown_key");
  });
});

describe("eval set roles", () => {
  it("has no gate_sealed role — a queryable sealed flag is the stored list sealing forbids", () => {
    expect(EVAL_ITEM_ROLES).toEqual(["optimizer", "gate", "regression", "honeypot"]);
    expect(EVAL_ITEM_ROLES as readonly string[]).not.toContain("gate_sealed");
    expect(EVAL_ITEM_ROLES as readonly string[]).not.toContain("gate_dev");
  });

  it("rejects gate_sealed and gate_dev on an index entry with a reason", () => {
    for (const role of ["gate_sealed", "gate_dev"]) {
      const result = validateEvalSet(bundleOf([entryFor(body(), { role })]));
      expect(codes(result)).toContain("evalset.sealed_role");
      const finding = result.findings.find((item) => item.code === "evalset.sealed_role");
      expect(finding?.message).toContain("gate");
    }
  });

  it("rejects a variant group whose members disagree about their role", () => {
    const first = body();
    const second = body({ input: { kind: "inline", value: { ticket: "printer ablaze" } } });

    const result = validateEvalSet(
      bundleOf([
        entryFor(first, { role: "gate", variantGroupId: "paraphrase-1" }),
        entryFor(second, { role: "optimizer", variantGroupId: "paraphrase-1" }),
      ]),
    );

    expect(codes(result)).toContain("evalset.variant_group_role_conflict");
  });
});

describe("eval set index", () => {
  it("requires the index to be strictly ascending by itemSha", () => {
    const first = body();
    const second = body({ input: { kind: "inline", value: { ticket: "b" } } });
    const sorted = sortIndex([entryFor(first), entryFor(second)]);

    expect(validateEvalSet(bundleOf(sorted)).valid).toBe(true);
    expect(codes(validateEvalSet({ ...bundleOf(sorted), index: [...sorted].reverse() }))).toContain(
      "evalset.index_unsorted",
    );
  });

  it("rejects a duplicated itemSha through the same strictness", () => {
    const item = body();
    const result = validateEvalSet({
      ...bundleOf([entryFor(item)]),
      index: [entryFor(item), entryFor(item)],
    });

    expect(codes(result)).toContain("evalset.index_unsorted");
  });

  it("sortEvalSetIndex produces the order the validator demands", () => {
    const entries = [
      entryFor(body({ input: { kind: "inline", value: { ticket: "c" } } })),
      entryFor(body()),
      entryFor(body({ input: { kind: "inline", value: { ticket: "b" } } })),
    ];

    const sorted = sortEvalSetIndex(entries as never);

    expect(validateEvalSet({ ...bundleOf([]), index: sorted }).valid).toBe(true);
  });

  it("rejects a run or event pointer in an index entry", () => {
    for (const pointer of [
      { runId: "run_a" },
      { sequence: 3 },
      { eventId: "evt_1" },
      { provenance: [{ runId: "run_a", sequence: 3 }] },
    ]) {
      const result = validateEvalSet(bundleOf([entryFor(body(), pointer)]));
      expect(codes(result), `expected ${Object.keys(pointer)[0]} to be rejected`).toContain(
        "evalset.index_run_pointer",
      );
    }
  });

  it("carries no dereferenceable pointer in a registered bundle's readable half", () => {
    const version = registerEvalSet(bundleOf([entryFor(body())]));

    for (const entry of version.bundle.index) {
      expect(Object.keys(entry).sort()).toEqual([
        "bodySha",
        "clusterId",
        "createdAt",
        "inputConeAlgorithm",
        "inputConeHash",
        "itemSha",
        "labelProvenance",
        "referencedFields",
        "replayValidity",
        "role",
        "target",
      ]);
    }
    expect(JSON.stringify(version.bundle.index)).not.toContain("run_a");
  });

  it("rejects an item whose target no construct declares", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body({ target: "classify" }), { target: "classify" })]),
    );

    expect(codes(result)).toContain("evalset.unknown_target");
  });

  it("pins the input cone algorithm so cone hashes are never compared across versions", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body(), { inputConeAlgorithm: "lwir-input-cone@v2" })]),
    );

    expect(result.valid).toBe(false);
    expect(validateEvalSet(bundleOf([entryFor(body())])).valid).toBe(true);
  });
});

describe("eval item hashing", () => {
  it("gives two identical bodies with different provenance one itemSha and two bodyShas", () => {
    const fromTraceA = body({ provenance: [{ runId: "run_a", sequence: 3 }] });
    const fromTraceB = body({ provenance: [{ runId: "run_b", sequence: 41, eventId: "evt_9" }] });

    expect(evalItemSha(fromTraceA)).toBe(evalItemSha(fromTraceB));
    expect(evalItemBodySha(fromTraceA)).not.toBe(evalItemBodySha(fromTraceB));
    expect(evalItemBodySha(fromTraceA)).not.toBe(evalItemSha(fromTraceA));
    expect(evalItemIdentity(fromTraceA)).not.toHaveProperty("provenance");
  });

  it("keeps itemSha independent of the set-scoped assignments that live in the index", () => {
    const item = body();
    const asGate = entryFor(item, { role: "gate", clusterId: "trace-1" });
    const asOptimizer = entryFor(item, {
      role: "optimizer",
      clusterId: "trace-9",
      resampleK: 7,
      createdAt: "2027-01-01T00:00:00Z",
    });

    expect(asOptimizer.itemSha).toBe(asGate.itemSha);
  });

  it("changes itemSha when the item's own content changes", () => {
    expect(evalItemSha(body())).not.toBe(
      evalItemSha(body({ label: { provenance: "human_labeled", value: { severity: "low" } } })),
    );
  });

  it("omits undefined body properties from itemSha", () => {
    expect(evalItemSha(body({ referenceAnswer: undefined }))).toBe(evalItemSha(body()));
  });

  it("registers a body at its own hash", () => {
    const registered = registerEvalItemBody(body(), { pii: SYNTHETIC });

    expect(registered.itemSha).toBe(evalItemSha(body()));
    expect(registered.bodySha).toBe(evalItemBodySha(body()));
    expect(registered.canonicalJson).toBe(canonicalJson(registered.body));
    expect(sha256Digest(JSON.parse(registered.canonicalJson))).toBe(registered.bodySha);
  });
});

describe("eval item PII split", () => {
  it("rejects inline content unless the manifest declares pii.status === synthetic", () => {
    for (const status of ["surrogate", "redacted", "raw_prohibited"] as const) {
      const result = validateEvalItemBody(body(), {
        pii: { status, retentionClass: "evidence-5y", disposalDue: "2028-01-01T00:00:00Z" },
      });
      expect(codes(result), `expected inline to be rejected under ${status}`).toContain(
        "evalset.inline_content_not_synthetic",
      );
    }

    expect(validateEvalItemBody(body(), { pii: SYNTHETIC }).valid).toBe(true);
  });

  it("accepts vault content under any pii status", () => {
    const vaulted = body({
      input: { kind: "vault", vaultRef: "evpv_1", shape: { ticket: "string" } },
    });

    expect(
      validateEvalItemBody(vaulted, {
        pii: { status: "raw_prohibited", retentionClass: "pii", disposalDue: "2028-01-01T00:00:00Z" },
      }).valid,
    ).toBe(true);
  });

  it("refuses to hash inline content when no PII policy was supplied", () => {
    expect(() => registerEvalItemBody(body())).toThrow(EvalSetValidationError);
    expect(codes(validateEvalItemBody(body()))).toContain(
      "evalset.inline_content_requires_pii_policy",
    );
  });

  it("applies the rule to the reference answer as well as the input", () => {
    const vaultedInputInlineAnswer = body({
      input: { kind: "vault", vaultRef: "evpv_1", shape: {} },
      referenceAnswer: { kind: "inline", value: "high" },
    });

    expect(
      codes(
        validateEvalItemBody(vaultedInputInlineAnswer, {
          pii: { status: "surrogate", retentionClass: "pii", disposalDue: "2028-01-01T00:00:00Z" },
        }),
      ),
    ).toContain("evalset.inline_content_not_synthetic");
  });

  it("requires a disposal clock whenever the set is not synthetic", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], { pii: { status: "surrogate", retentionClass: "pii" } }),
    );

    expect(codes(result)).toContain("evalset.schema.missing");
    expect(result.findings.map((finding) => finding.path)).toContain("$.manifest.pii.disposalDue");
  });

  it("rejects contact details in the manifest's free-text fields", () => {
    const withEmail = validateEvalSet(
      bundleOf([entryFor(body())], {
        audit: {
          ...(card().audit as Record_),
          raters: [{ ref: "jane.doe@example.com", kind: "human" }],
        },
      }),
    );
    const withDescription = validateEvalSet(
      bundleOf([entryFor(body())], {
        metadata: {
          name: "support.summarize.gate",
          description: "Owner: 555-123-4567",
          createdAt: "2026-08-01T09:00:00Z",
        },
      }),
    );

    expect(codes(withEmail)).toContain("evalset.pii_in_free_text");
    expect(codes(withDescription)).toContain("evalset.pii_in_free_text");
  });
});

describe("bundle / body cross-verification", () => {
  function registeredBundle(items: readonly EvalItemBody[]): EvalSetBundle {
    return registerEvalSet(bundleOf(items.map((item) => entryFor(item)))).bundle;
  }

  it("verifies bodies against the index the bundle committed to", () => {
    const items = [body(), body({ input: { kind: "inline", value: { ticket: "b" } } })];

    const result = verifyEvalSetBodies(registeredBundle(items), items);

    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("catches a body that does not hash to the bodySha the index pins", () => {
    const item = body();
    const bundle = registeredBundle([item]);
    const tampered = { ...item, provenance: [{ runId: "run_z", sequence: 1 }] } as EvalItemBody;

    const result = verifyEvalSetBodies(bundle, [tampered]);

    expect(codes(result)).toContain("evalset.body_sha_mismatch");
  });

  it("catches a body the bundle never indexed, and an index entry with no body", () => {
    const item = body();
    const stranger = body({ input: { kind: "inline", value: { ticket: "stranger" } } });

    expect(codes(verifyEvalSetBodies(registeredBundle([item]), [stranger]))).toContain(
      "evalset.body_not_indexed",
    );
    expect(codes(verifyEvalSetBodies(registeredBundle([item, stranger]), [item]))).toContain(
      "evalset.body_missing",
    );
    expect(
      verifyEvalSetBodies(registeredBundle([item, stranger]), [item], { partial: true }).valid,
    ).toBe(true);
  });

  it("re-checks the facts the index duplicates from the body", () => {
    const item = body();
    const bundle = registerEvalSet(
      bundleOf([entryFor(item, { labelProvenance: "judge_labeled" })]),
    ).bundle;

    expect(codes(verifyEvalSetBodies(bundle, [item]))).toContain(
      "evalset.body_label_provenance_mismatch",
    );
  });

  it("rejects a rubric criterion the construct never declared", () => {
    const item = body({ rubric: [{ criterionId: "invented", expected: true }] });

    expect(codes(verifyEvalSetBodies(registeredBundle([item]), [item]))).toContain(
      "evalset.unknown_criterion",
    );
  });

  it("applies the manifest's PII policy to the bodies it is verified against", () => {
    const item = body({
      input: { kind: "vault", vaultRef: "evpv_1", shape: {} },
    });
    const bundle = registerEvalSet(
      bundleOf([entryFor(item)], {
        pii: { status: "surrogate", retentionClass: "pii", disposalDue: "2028-01-01T00:00:00Z" },
      }),
    ).bundle;

    expect(verifyEvalSetBodies(bundle, [item]).valid).toBe(true);
    expect(
      codes(verifyEvalSetBodies(bundle, [{ ...item, input: { kind: "inline", value: 1 } } as EvalItemBody])),
    ).toContain("evalset.inline_content_not_synthetic");
  });
});

describe("eval set lineage", () => {
  it("warns, without failing, when the declared lineage is unknown", () => {
    const result = validateEvalSet(bundleOf([entryFor(body())]), {
      knownLineages: ["billing.reconcile"],
    });

    expect(result.valid).toBe(true);
    expect(warningCodes(result)).toEqual(["evalset.unknown_lineage"]);
    expect(result.warnings[0]?.message).toContain("renamed");
    expect(result.warnings[0]?.message).toContain("billing.reconcile");
  });

  it("stays silent when the lineage is known, and when no lineage set was supplied", () => {
    expect(
      validateEvalSet(bundleOf([entryFor(body())]), { knownLineages: ["support.summarize"] })
        .warnings,
    ).toEqual([]);
    expect(validateEvalSet(bundleOf([entryFor(body())])).warnings).toEqual([]);
  });
});

describe("eval set structural validation", () => {
  it("rejects unknown keys anywhere in the bundle", () => {
    expect(codes(validateEvalSet({ ...bundleOf([entryFor(body())]), surprise: 1 }))).toContain(
      "evalset.schema.unknown_key",
    );
    expect(
      codes(validateEvalSet(bundleOf([entryFor(body())], { surprise: "hello" }))),
    ).toContain("evalset.schema.unknown_key");
  });

  it("requires one spelling for a timestamp", () => {
    for (const stamp of ["2026-08-01T09:00:00.000Z", "2026-08-01T09:00:00+00:00", "2026-08-01"]) {
      expect(
        codes(validateEvalSet(bundleOf([entryFor(body(), { createdAt: stamp })]))),
      ).toContain("evalset.schema.invalid");
    }
  });

  it("rejects an independence attestation that contradicts its own fields", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], {
        independence: { evalAuthorFamily: "claude", workflowAuthorFamily: "claude", distinct: true },
      }),
    );

    expect(codes(result)).toContain("evalset.independence_inconsistent");
  });

  it("rejects an admitted count larger than the candidate pool it came from", () => {
    const result = validateEvalSet(
      bundleOf([entryFor(body())], {
        generation: { ...(card().generation as Record_), candidatesGenerated: 10, admitted: 11 },
      }),
    );

    expect(codes(result)).toContain("evalset.schema.invalid");
  });

  it("rejects an unnamespaced extension key", () => {
    expect(
      codes(validateEvalSet(bundleOf([entryFor(body())], { extensions: { fairness: {} } }))),
    ).toContain("evalset.extension_key_unnamespaced");
    expect(
      validateEvalSet(bundleOf([entryFor(body())], { extensions: { "lending.fairness/v1": {} } }))
        .valid,
    ).toBe(true);
  });

  it("rejects a value the canonicalizer cannot hash", () => {
    expect(codes(validateEvalSet(bundleOf([entryFor(body())], { canaryGuid: new Date() })))).toContain(
      "evalset.non_hashable",
    );
  });

  it("assertValidEvalSet throws with the findings attached", () => {
    try {
      assertValidEvalSet(bundleOf([entryFor(body(), { role: "gate_sealed" })]));
      expect.unreachable("assertValidEvalSet should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalSetValidationError);
      expect((error as EvalSetValidationError).findings.map((finding) => finding.code)).toContain(
        "evalset.sealed_role",
      );
    }
  });
});
