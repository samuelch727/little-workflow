import { describe, expect, it } from "vitest";
import {
  inputConeHash,
  inputConeSnapshot,
  LWIR_INPUT_CONE_ALGORITHM,
  LwirInputConeError,
} from "./lwir-input-cone.js";

const objSchema = { type: "object" as const };

function baseLwir(steps: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "input-cone.test", version: "0.1.0-alpha" },
    input: { schema: objSchema },
    output: { schema: objSchema },
    permissions: { models: ["m"], tools: [], secrets: [], network: [] },
    steps,
    ...overrides,
  };
}

function gen(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uses: "ai.generate",
    input: "{{ input }}",
    with: { model: "m", prompt: `prompt for ${id}` },
    output: { mode: "object", schema: objSchema },
    ...extra,
  };
}

function hashOf(lwir: unknown, stepId: string): string {
  return inputConeHash(lwir, stepId).hash;
}

/** a -> b -> c, plus an unrelated `side` step nothing depends on. */
function chainLwir(mutate: (steps: Record<string, unknown>[]) => void = () => {}) {
  const steps = [
    gen("a"),
    gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }),
    gen("side"),
  ];
  mutate(steps);
  return baseLwir(steps);
}

describe("algorithm identity", () => {
  it("reports the versioned algorithm id alongside the digest", () => {
    const result = inputConeHash(chainLwir(), "b");
    expect(result.algorithm).toBe("lwir-input-cone@v1");
    expect(LWIR_INPUT_CONE_ALGORITHM).toBe("lwir-input-cone@v1");
    expect(result.stepId).toBe("b");
    expect(result.scope).toBe("steps");
    expect(result.cyclic).toBe(false);
  });

  it("formats the digest as sha256:<hex>, matching the little-workflow convention", () => {
    expect(hashOf(chainLwir(), "b")).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("mixes the algorithm id into the hashed payload so a future v2 cannot collide with v1", () => {
    const snapshot = inputConeSnapshot(chainLwir(), "b");
    expect(snapshot.algorithm).toBe("lwir-input-cone@v1");
  });
});

describe("cone membership", () => {
  it("contains the step and its transitive influencers only", () => {
    expect(inputConeHash(chainLwir(), "c").stepIds).toEqual(["a", "b", "c"]);
    expect(inputConeHash(chainLwir(), "b").stepIds).toEqual(["a", "b"]);
    expect(inputConeHash(chainLwir(), "a").stepIds).toEqual(["a"]);
  });
});

describe("determinism", () => {
  it("is independent of the order steps appear in the array", () => {
    const forward = baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
      gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }),
    ]);
    const shuffled = baseLwir([
      gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }),
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    ]);
    expect(hashOf(shuffled, "c")).toBe(hashOf(forward, "c"));
  });

  it("is independent of object key insertion order", () => {
    const left = baseLwir([
      { id: "a", uses: "ai.generate", with: { model: "m", prompt: "p" }, output: { mode: "text" } },
      { id: "b", uses: "ai.generate", needs: ["a"], input: "{{ steps.a.output }}", with: { prompt: "q", model: "m" }, output: { mode: "text" } },
    ]);
    const right = baseLwir([
      { output: { mode: "text" }, with: { prompt: "q", model: "m" }, input: "{{ steps.a.output }}", needs: ["a"], uses: "ai.generate", id: "b" },
      { output: { mode: "text" }, with: { model: "m", prompt: "p" }, uses: "ai.generate", id: "a" },
    ]);
    expect(hashOf(right, "b")).toBe(hashOf(left, "b"));
  });

  it("is independent of the order of `needs` entries", () => {
    const left = baseLwir([
      gen("a"),
      gen("b"),
      gen("c", { needs: ["a", "b"], input: "{{ steps.a.output }}{{ steps.b.output }}" }),
    ]);
    const right = baseLwir([
      gen("a"),
      gen("b"),
      gen("c", { needs: ["b", "a"], input: "{{ steps.a.output }}{{ steps.b.output }}" }),
    ]);
    expect(hashOf(right, "c")).toBe(hashOf(left, "c"));
  });

  it("treats an empty `needs` as an absent `needs`", () => {
    const absent = baseLwir([gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" })]);
    const empty = baseLwir([
      gen("a", { needs: [] }),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    ]);
    expect(hashOf(empty, "b")).toBe(hashOf(absent, "b"));
  });

  it("returns the same hash for the same document twice", () => {
    expect(hashOf(chainLwir(), "c")).toBe(hashOf(chainLwir(), "c"));
  });

  it("does NOT promise order-independence once an escape hatch has fired", () => {
    // Under `whole-document` the document is hashed as it stands. The hatch fired because the
    // module could not establish what the document means, so it stops claiming any rearrangement of
    // it is cosmetic. Over-invalidation, and the honest reading of `scope`.
    const ordered = (needs: readonly string[]) =>
      baseLwir([
        gen("a"),
        gen("side"),
        gen("b", { needs, input: "own id is {{ step.id }}" }),
      ]);
    expect(inputConeHash(ordered(["a", "side"]), "b").scope).toBe("whole-document");
    expect(hashOf(ordered(["side", "a"]), "b")).not.toBe(hashOf(ordered(["a", "side"]), "b"));
  });
});

describe("what invalidates a cone", () => {
  it("changes when an upstream step is edited", () => {
    const before = hashOf(chainLwir(), "c");
    const after = hashOf(
      chainLwir((steps) => {
        steps[0] = gen("a", { with: { model: "m", prompt: "a different prompt" } });
      }),
      "c",
    );
    expect(after).not.toBe(before);
  });

  it("changes when an upstream step's output contract is edited", () => {
    const before = hashOf(chainLwir(), "c");
    const after = hashOf(
      chainLwir((steps) => {
        steps[0] = gen("a", {
          output: { mode: "object", schema: { type: "object", required: ["x"] } },
        });
      }),
      "c",
    );
    expect(after).not.toBe(before);
  });

  it("changes when an upstream step's onFailure or sensitive flag is edited", () => {
    const before = hashOf(chainLwir(), "c");
    const repaired = hashOf(
      chainLwir((steps) => {
        steps[0] = gen("a", { onFailure: { repair: { mode: "self", maxAttempts: 3 } } });
      }),
      "c",
    );
    const redacted = hashOf(
      chainLwir((steps) => {
        steps[0] = gen("a", { sensitive: true });
      }),
      "c",
    );
    expect(repaired).not.toBe(before);
    expect(redacted).not.toBe(before);
  });

  it("does NOT change when a downstream step is edited", () => {
    const before = hashOf(chainLwir(), "b");
    const after = hashOf(
      chainLwir((steps) => {
        steps[2] = gen("c", {
          needs: ["b"],
          input: "{{ steps.b.output }}",
          with: { model: "m", prompt: "rewritten downstream prompt" },
        });
      }),
      "b",
    );
    expect(after).toBe(before);
  });

  it("does NOT change when an unrelated step is edited, added, or removed", () => {
    const before = hashOf(chainLwir(), "b");
    const edited = hashOf(
      chainLwir((steps) => {
        steps[3] = gen("side", { with: { model: "other", prompt: "unrelated" } });
      }),
      "b",
    );
    const removed = hashOf(
      baseLwir([gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" })]),
      "b",
    );
    expect(edited).toBe(before);
    expect(removed).toBe(before);
  });

  it("changes when the step under test is renamed, even if the graph shape is preserved", () => {
    // v1 treats a step id as load-bearing: it is the `steps.X` key, the run-state path segment,
    // and the address the eval item itself was authored against. Rename-invariance would need
    // graph canonicalisation, which is LIT-15 lineage work, not the cone's job.
    const before = hashOf(chainLwir(), "b");
    const renamed = hashOf(
      baseLwir([
        gen("a"),
        gen("b2", { needs: ["a"], input: "{{ steps.a.output }}" }),
        gen("c", { needs: ["b2"], input: "{{ steps.b2.output }}" }),
        gen("side"),
      ]),
      "b2",
    );
    expect(renamed).not.toBe(before);
  });

  it("changes when an upstream step is renamed, even if the graph shape is preserved", () => {
    const before = hashOf(chainLwir(), "b");
    const renamed = hashOf(
      baseLwir([
        gen("a2"),
        gen("b", { needs: ["a2"], input: "{{ steps.a2.output }}" }),
        gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }),
        gen("side"),
      ]),
      "b",
    );
    expect(renamed).not.toBe(before);
  });
});

describe("target-step projection", () => {
  // v1 hashes every cone member whole, target included. An earlier draft dropped the target's
  // `output` / `onFailure` / `sensitive` on the theory that they only describe the *result*. They
  // do not: `augmentAiStepForRepair` pastes `output.schema` and `output.mode` into a repair turn
  // (and `resolveRepairPolicy` makes self-repair default-on for every `ai.generate` step),
  // `onFailure.fixer.system` is consumed as the fixer's system prompt, and the `step` expression
  // root reads all three straight back into the step's own input.
  it("hashes the target's own output contract, repair policy and sensitivity", () => {
    const before = hashOf(chainLwir(), "b");
    const reshaped = hashOf(
      chainLwir((steps) => {
        steps[1] = gen("b", {
          needs: ["a"],
          input: "{{ steps.a.output }}",
          output: { mode: "object", schema: { type: "object", required: ["y"] } },
          onFailure: { repair: { mode: "self", maxAttempts: 2 } },
          sensitive: true,
        });
      }),
      "b",
    );
    expect(reshaped).not.toBe(before);
  });

  it("invalidates on each of the three formerly-excluded target fields independently", () => {
    const before = hashOf(chainLwir(), "b");
    const target = (extra: Record<string, unknown>) =>
      hashOf(
        chainLwir((steps) => {
          steps[1] = gen("b", { needs: ["a"], input: "{{ steps.a.output }}", ...extra });
        }),
        "b",
      );
    // `output.mode` and `output.schema` are pasted verbatim into the default-on repair turn.
    expect(target({ output: { mode: "text" } })).not.toBe(before);
    expect(target({ output: { mode: "object", schema: { type: "object", required: ["y"] } } }))
      .not.toBe(before);
    // `onFailure.repair` decides whether that turn happens at all; `onFailure.fixer.system` is a
    // system prompt.
    expect(target({ onFailure: { repair: { mode: "self", maxAttempts: 2 } } })).not.toBe(before);
    expect(
      target({
        onFailure: { fixer: { model: "m", maxAttempts: 1, system: "you fix things" } },
      }),
    ).not.toBe(before);
    expect(target({ sensitive: true })).not.toBe(before);
  });

  it("invalidates on a target `sensitive` flip with no expression anywhere in the document", () => {
    // The narrowest statement of the fix: no `{{ step.… }}` is needed for these fields to matter.
    const off = hashOf(chainLwir((steps) => {
      steps[1] = gen("b", { needs: ["a"], input: "{{ steps.a.output }}", sensitive: false });
    }), "b");
    const on = hashOf(chainLwir((steps) => {
      steps[1] = gen("b", { needs: ["a"], input: "{{ steps.a.output }}", sensitive: true });
    }), "b");
    expect(on).not.toBe(off);
  });

  it("still tracks the target's own input bindings", () => {
    const before = hashOf(chainLwir(), "b");
    const rebound = hashOf(
      chainLwir((steps) => {
        steps[1] = gen("b", { needs: ["a"], input: "{{ steps.a.output.summary }}" });
      }),
      "b",
    );
    expect(rebound).not.toBe(before);
  });

  it("still tracks the target's own `with` block (for ai.generate the prompt is the model input)", () => {
    const before = hashOf(chainLwir(), "b");
    const reprompted = hashOf(
      chainLwir((steps) => {
        steps[1] = gen("b", {
          needs: ["a"],
          input: "{{ steps.a.output }}",
          with: { model: "m", prompt: "a rewritten prompt" },
        });
      }),
      "b",
    );
    expect(reprompted).not.toBe(before);
  });
});

describe("workflow-level fields", () => {
  it("does NOT change when cosmetic workflow metadata is edited", () => {
    const before = hashOf(chainLwir(), "b");
    const described = baseLwir(
      [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")],
      { metadata: { name: "input-cone.test", version: "9.9.9", description: "now with prose" } },
    );
    expect(hashOf(described, "b")).toBe(before);
  });

  it("changes when the workflow output schema is edited", () => {
    // The workflow's `output.schema` is validated against the final step's output; on failure
    // `validateJsonSchema` raises a `RuntimeStepSchemaError` whose ajv finding text is pasted into
    // the `[OUTPUT REPAIR]` turn. It reaches a model input, so it is hashed.
    const before = hashOf(chainLwir(), "b");
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")];
    const reshapedOutput = baseLwir(steps, {
      output: { schema: { type: "object", required: ["report"] } },
    });
    expect(hashOf(reshapedOutput, "b")).not.toBe(before);
  });

  it("changes when permissions are edited", () => {
    // Hashed not because a permissions edit is known to reach a model input, but because the
    // envelope is a deny-list: only `metadata` is dropped. Over-invalidation costs a regeneration.
    const before = hashOf(chainLwir(), "b");
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")];
    const rescoped = baseLwir(steps, {
      permissions: { models: ["m", "n"], tools: ["search"], secrets: [], network: [] },
    });
    expect(hashOf(rescoped, "b")).not.toBe(before);
  });

  it("changes when a top-level key the algorithm has never heard of is edited", () => {
    // The F8 class: an allow-list would silently drop a key added to LWIR after this module was
    // written. A deny-list hashes it by default.
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("side")];
    const before = hashOf(baseLwir(steps, { futureKey: { retries: 1 } }), "b");
    const after = hashOf(baseLwir(steps, { futureKey: { retries: 2 } }), "b");
    expect(after).not.toBe(before);
  });

  it("changes when a sibling key is added under `input`, not only when the schema changes", () => {
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("side")];
    const before = hashOf(baseLwir(steps, { input: { schema: objSchema } }), "b");
    const after = hashOf(
      baseLwir(steps, { input: { schema: objSchema, example: { topic: "x" } } }),
      "b",
    );
    expect(after).not.toBe(before);
  });

  it("still does NOT change when only `metadata` is edited — the one exclusion", () => {
    const before = hashOf(chainLwir(), "b");
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")];
    const rewritten = baseLwir(steps, {
      metadata: { name: "renamed", version: "9.9.9", description: "now with prose" },
    });
    expect(hashOf(rewritten, "b")).toBe(before);
  });

  it("changes when the workflow input schema changes", () => {
    const before = hashOf(chainLwir(), "b");
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")];
    const rescoped = baseLwir(steps, {
      input: { schema: { type: "object", required: ["topic"] } },
    });
    expect(hashOf(rescoped, "b")).not.toBe(before);
  });

  it("changes when the apiVersion changes", () => {
    const before = hashOf(chainLwir(), "b");
    const steps = [gen("a"), gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }), gen("c", { needs: ["b"], input: "{{ steps.b.output }}" }), gen("side")];
    const bumped = baseLwir(steps, { apiVersion: "littleworkflow.dev/v0.2" });
    expect(hashOf(bumped, "b")).not.toBe(before);
  });
});

describe("workflow expression root escape hatch", () => {
  function workflowRootLwir(description: string) {
    return baseLwir(
      [
        gen("a", { with: { model: "m", prompt: "{{ workflow.metadata.description }}" } }),
        gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
        gen("side"),
      ],
      { metadata: { name: "input-cone.test", version: "0.1.0-alpha", description } },
    );
  }

  it("falls back to hashing the whole document when a cone member reads `workflow`", () => {
    const result = inputConeHash(workflowRootLwir("first"), "b");
    expect(result.scope).toBe("whole-document");
    expect(result.stepIds).toEqual([]);
  });

  it("makes otherwise-excluded metadata invalidating, because `workflow` can read any of it", () => {
    expect(hashOf(workflowRootLwir("second"), "b")).not.toBe(
      hashOf(workflowRootLwir("first"), "b"),
    );
  });

  it("keeps the target step id in the payload so two steps cannot collide", () => {
    expect(hashOf(workflowRootLwir("first"), "b")).not.toBe(
      hashOf(workflowRootLwir("first"), "a"),
    );
  });

  it("is not triggered by the bare word 'workflow' outside an expression", () => {
    // The scope assertion must run against the document that actually contains the word. Asserting
    // it on `chainLwir()` — which contains no "workflow" anywhere — proves nothing: an
    // implementation that flipped to whole-document on the bare word would still have passed.
    const proseLwir = chainLwir((steps) => {
      steps[0] = gen("a", { with: { model: "m", prompt: "describe the workflow" } });
    });
    expect(inputConeHash(proseLwir, "b").scope).toBe("steps");
    expect(inputConeHash(proseLwir, "b").stepIds).toEqual(["a", "b"]);
    expect(hashOf(proseLwir, "b")).not.toBe(hashOf(chainLwir(), "b"));
  });
});

describe("step expression root escape hatch", () => {
  /**
   * `step` is a first-class expression root bound to the raw `LwirStep` (`expressionContextFor` in
   * runtime.ts), and `resolveStepInput` resolves `step.input` into the value handed to the worker.
   * Each document below is `validateLwir`-valid and reads a field the earlier draft dropped from
   * the target's projection, so the edit was invisible to the hash.
   */
  function stepRootLwir(expression: string, targetExtra: Record<string, unknown> = {}) {
    return baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: expression, ...targetExtra }),
      gen("side"),
    ]);
  }

  it("falls back to the whole document when a cone member reads the `step` root", () => {
    const result = inputConeHash(stepRootLwir("redaction={{ step.sensitive }}"), "b");
    expect(result.scope).toBe("whole-document");
    expect(result.stepIds).toEqual([]);
  });

  it("invalidates on `step.sensitive` when the flag flips", () => {
    const before = hashOf(stepRootLwir("redaction={{ step.sensitive }}", { sensitive: false }), "b");
    const after = hashOf(stepRootLwir("redaction={{ step.sensitive }}", { sensitive: true }), "b");
    expect(after).not.toBe(before);
  });

  it("invalidates on `step.onFailure.repair.maxAttempts`", () => {
    const before = hashOf(
      stepRootLwir("attempts={{ step.onFailure.repair.maxAttempts }}", {
        onFailure: { repair: { mode: "self", maxAttempts: 2 } },
      }),
      "b",
    );
    const after = hashOf(
      stepRootLwir("attempts={{ step.onFailure.repair.maxAttempts }}", {
        onFailure: { repair: { mode: "self", maxAttempts: 5 } },
      }),
      "b",
    );
    expect(after).not.toBe(before);
  });

  it("invalidates on `step.output.mode`", () => {
    const before = hashOf(
      stepRootLwir("mode={{ step.output.mode }}", { output: { mode: "text" } }),
      "b",
    );
    const after = hashOf(
      stepRootLwir("mode={{ step.output.mode }}", { output: { mode: "object", schema: objSchema } }),
      "b",
    );
    expect(after).not.toBe(before);
  });

  it("fires when an influencer, not the target, reads the `step` root", () => {
    const lwir = baseLwir([
      gen("a", { input: "own id is {{ step.id }}" }),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    ]);
    expect(inputConeHash(lwir, "b").scope).toBe("whole-document");
  });

  it("is not triggered by `steps.X` — the root regex requires a terminator after `step`", () => {
    expect(inputConeHash(chainLwir(), "b").scope).toBe("steps");
    const lwir = baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    ]);
    expect(inputConeHash(lwir, "b").scope).toBe("steps");
  });
});

describe("unscannable strings", () => {
  /**
   * `expressionsIn` (lwir.ts) returns `[]` when a `{{` or `}}` survives after every well-formed
   * match is stripped — indistinguishable, to a caller reading only the array, from "no expressions
   * here". `resolveString` (expressions.ts) rejects a string only when the `{{` and `}}` *counts*
   * differ, so the string below resolves fine at runtime while the scanner saw nothing.
   */
  const strayDelimiters = "x {{ workflow.metadata.description }} }} {{";

  function strayLwir(description: string) {
    return baseLwir(
      [
        gen("a", { input: strayDelimiters }),
        gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
        gen("side"),
      ],
      { metadata: { name: "input-cone.test", version: "0.1.0-alpha", description } },
    );
  }

  it("refuses to narrow rather than reporting a string it could not read as expression-free", () => {
    const result = inputConeHash(strayLwir("first"), "b");
    expect(result.scope).toBe("whole-document");
    expect(result.stepIds).toEqual([]);
  });

  it("makes the hidden `workflow.metadata` read invalidating", () => {
    expect(hashOf(strayLwir("second"), "b")).not.toBe(hashOf(strayLwir("first"), "b"));
  });

  it("refuses to narrow when a stray delimiter could be hiding a `steps.X` edge", () => {
    // `side` is not reachable by any scannable edge, so narrowing here would drop a step whose
    // output the runtime may well substitute.
    const lwir = baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }} }} {{ steps.side.output }}" }),
      gen("side"),
    ]);
    const result = inputConeHash(lwir, "b");
    expect(result.scope).toBe("whole-document");
    const edited = baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }} }} {{ steps.side.output }}" }),
      gen("side", { with: { model: "m", prompt: "a different side prompt" } }),
    ]);
    expect(hashOf(edited, "b")).not.toBe(hashOf(lwir, "b"));
  });

  it("still narrows for a string with no delimiters at all", () => {
    const lwir = baseLwir([
      gen("a", { input: "plain prose, no braces" }),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
    ]);
    expect(inputConeHash(lwir, "b").scope).toBe("steps");
  });

  it("fires for a stray delimiter anywhere in the step, not only in `with`/`input`/`cache`", () => {
    const lwir = baseLwir([
      gen("a"),
      gen("b", {
        needs: ["a"],
        input: "{{ steps.a.output }}",
        onFailure: { fixer: { model: "m", maxAttempts: 1, system: "fix it }} {{" } },
      }),
    ]);
    expect(inputConeHash(lwir, "b").scope).toBe("whole-document");
  });
});

describe("decision and branch edges", () => {
  /**
   * route decides between `left` and `right`; `join` consumes whichever ran.
   * `route` itself is fed by `seed`.
   */
  function decisionLwir(when: string) {
    return baseLwir([
      gen("seed"),
      {
        id: "route",
        uses: "decision",
        needs: ["seed"],
        with: {
          cases: [{ when, to: "left" }],
          default: "right",
        },
      },
      gen("left"),
      gen("right"),
      gen("join", { needs: ["left"], input: "{{ steps.left.output }}" }),
    ]);
  }

  it("pulls the deciding step (and its own inputs) into a routed-to step's cone", () => {
    expect(inputConeHash(decisionLwir("{{ steps.seed.output.ok }}"), "left").stepIds).toEqual([
      "left",
      "route",
      "seed",
    ]);
  });

  it("changes a routed-to step's cone when the decision condition is edited", () => {
    const before = hashOf(decisionLwir("{{ steps.seed.output.ok }}"), "left");
    const after = hashOf(decisionLwir("{{ steps.seed.output.ready }}"), "left");
    expect(after).not.toBe(before);
  });

  it("carries the decision edge transitively to a step that needs a routed-to step", () => {
    expect(inputConeHash(decisionLwir("{{ steps.seed.output.ok }}"), "join").stepIds).toEqual([
      "join",
      "left",
      "route",
      "seed",
    ]);
  });

  it("does not pull a sibling branch that nothing in the cone depends on", () => {
    expect(inputConeHash(decisionLwir("{{ steps.seed.output.ok }}"), "left").stepIds).not.toContain(
      "right",
    );
  });

  it("reaches a step that only influences the target through the decision", () => {
    // `left` declares no `needs`; `seed` reaches it solely as the decision's own input. A
    // `needs`-only walk would call this edit invisible.
    const before = hashOf(decisionLwir("{{ steps.seed.output.ok }}"), "left");
    const reseeded = baseLwir([
      gen("seed", { with: { model: "m", prompt: "a different seed prompt" } }),
      {
        id: "route",
        uses: "decision",
        needs: ["seed"],
        with: {
          cases: [{ when: "{{ steps.seed.output.ok }}", to: "left" }],
          default: "right",
        },
      },
      gen("left"),
      gen("right"),
      gen("join", { needs: ["left"], input: "{{ steps.left.output }}" }),
    ]);
    expect(hashOf(reseeded, "left")).not.toBe(before);
  });
});

describe("expression references without a declared `needs`", () => {
  /**
   * The lwir.ts L492-499 case: `lastOutput` / `allVisits` back-edge references are legal without a
   * matching `needs` entry, because declaring one would create an unsatisfiable forward-DAG cycle.
   * The cone must follow the reference edge anyway.
   */
  function loopLwir(prompt: string) {
    return baseLwir([
      gen("draft", { maxVisits: 3 }),
      gen("critique", {
        needs: ["draft"],
        maxVisits: 3,
        input: "{{ steps.draft.lastOutput }}",
        with: { model: "m", prompt },
      }),
      {
        id: "gate",
        uses: "decision",
        needs: ["critique"],
        maxVisits: 3,
        with: {
          cases: [{ when: "{{ steps.critique.lastOutput.done }}", to: "end" }],
          default: "draft",
        },
      },
    ]);
  }

  it("follows a `lastOutput` reference that is deliberately absent from `needs`", () => {
    const lwir = baseLwir([
      gen("early", { maxVisits: 2 }),
      gen("late", { input: "{{ steps.early.lastOutput }}" }),
    ]);
    expect(inputConeHash(lwir, "late").stepIds).toEqual(["early", "late"]);
  });

  it("reports a step on a decision loop as cyclic and includes the whole loop", () => {
    const result = inputConeHash(loopLwir("critique it"), "draft");
    expect(result.cyclic).toBe(true);
    expect(result.stepIds).toEqual(["critique", "draft", "gate"]);
  });

  it("terminates and stays stable under array reorder for a cyclic cone", () => {
    const forward = loopLwir("critique it");
    const shuffled = baseLwir([...forward.steps].reverse());
    expect(hashOf(shuffled, "draft")).toBe(hashOf(forward, "draft"));
  });

  it("terminates on a self-referential step", () => {
    const lwir = baseLwir([gen("solo", { needs: ["solo"], maxVisits: 2 })]);
    const result = inputConeHash(lwir, "solo");
    expect(result.cyclic).toBe(true);
    expect(result.stepIds).toEqual(["solo"]);
  });

  it("hashes the target in full when the target is on a cycle", () => {
    // Every member is hashed whole, cyclic or not; on a loop the target's own `output` additionally
    // feeds its later-visit input, so this is the case that must never regress.
    const before = hashOf(loopLwir("critique it"), "draft");
    const reshaped = baseLwir([
      gen("draft", { maxVisits: 3, output: { mode: "text" } }),
      gen("critique", {
        needs: ["draft"],
        maxVisits: 3,
        input: "{{ steps.draft.lastOutput }}",
        with: { model: "m", prompt: "critique it" },
      }),
      {
        id: "gate",
        uses: "decision",
        needs: ["critique"],
        maxVisits: 3,
        with: {
          cases: [{ when: "{{ steps.critique.lastOutput.done }}", to: "end" }],
          default: "draft",
        },
      },
    ]);
    expect(hashOf(reshaped, "draft")).not.toBe(before);
  });
});

describe("parallel branch bodies", () => {
  function parallelLwir(branchPrompt: string, outerPrompt: string) {
    return baseLwir([
      gen("seed", { with: { model: "m", prompt: outerPrompt } }),
      {
        id: "fan",
        uses: "parallel",
        needs: ["seed"],
        with: {
          items: "{{ steps.seed.output.items }}",
          itemKey: "{{ item.id }}",
          cardinality: { kind: "matches_items" },
          maxBranches: 10,
          maxConcurrency: 4,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          gen("branch", {
            input: "{{ item }}",
            with: { model: "m", prompt: branchPrompt },
          }),
        ],
        output: { mode: "array", schema: { type: "array", items: objSchema } },
      },
      gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
    ]);
  }

  it("hashes a parallel step's branch bodies as part of that step", () => {
    const before = hashOf(parallelLwir("summarise", "seed"), "report");
    const after = hashOf(parallelLwir("summarise differently", "seed"), "report");
    expect(after).not.toBe(before);
  });

  it("resolves a branch-body reference to a nested sibling as local, not as a missing step", () => {
    const lwir = baseLwir([
      gen("seed"),
      {
        id: "fan",
        uses: "parallel",
        needs: ["seed"],
        with: {
          items: "{{ steps.seed.output.items }}",
          itemKey: "{{ item.id }}",
          cardinality: { kind: "matches_items" },
          maxBranches: 10,
          maxConcurrency: 4,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          gen("first", { input: "{{ item }}" }),
          gen("second", { needs: ["first"], input: "{{ steps.first.output }}" }),
        ],
        output: { mode: "array", schema: { type: "array", items: objSchema } },
      },
      gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
    ]);
    expect(inputConeHash(lwir, "report").stepIds).toEqual(["fan", "report", "seed"]);
  });

  it("pulls a top-level step referenced from inside a branch body into the cone", () => {
    const lwir = baseLwir([
      gen("shared"),
      gen("seed"),
      {
        id: "fan",
        uses: "parallel",
        needs: ["seed", "shared"],
        with: {
          items: "{{ steps.seed.output.items }}",
          itemKey: "{{ item.id }}",
          cardinality: { kind: "matches_items" },
          maxBranches: 10,
          maxConcurrency: 4,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [gen("branch", { input: "{{ steps.shared.output }}" })],
        output: { mode: "array", schema: { type: "array", items: objSchema } },
      },
      gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
    ]);
    expect(inputConeHash(lwir, "report").stepIds).toEqual([
      "fan",
      "report",
      "seed",
      "shared",
    ]);
  });

  it("pulls a top-level step declared in a branch step's own `needs` into the cone", () => {
    const lwir = baseLwir([
      gen("shared"),
      gen("seed"),
      {
        id: "fan",
        uses: "parallel",
        needs: ["seed", "shared"],
        with: {
          items: "{{ steps.seed.output.items }}",
          itemKey: "{{ item.id }}",
          cardinality: { kind: "matches_items" },
          maxBranches: 10,
          maxConcurrency: 4,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [gen("branch", { needs: ["shared"], input: "{{ item }}" })],
        output: { mode: "array", schema: { type: "array", items: objSchema } },
      },
      gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
    ]);
    expect(inputConeHash(lwir, "report").stepIds).toEqual([
      "fan",
      "report",
      "seed",
      "shared",
    ]);
  });

  it("normalises `needs` inside a branch body too, so a nested reorder is not invalidating", () => {
    const nested = (needs: readonly string[]) =>
      baseLwir([
        gen("shared"),
        gen("seed"),
        {
          id: "fan",
          uses: "parallel",
          needs: ["seed", "shared"],
          with: {
            items: "{{ steps.seed.output.items }}",
            itemKey: "{{ item.id }}",
            cardinality: { kind: "matches_items" },
            maxBranches: 10,
            maxConcurrency: 4,
            failureMode: "fail_fast",
            fanIn: { order: "input", output: "array" },
          },
          steps: [
            gen("first", { input: "{{ item }}" }),
            gen("second", { needs, input: "{{ steps.first.output }}" }),
          ],
          output: { mode: "array", schema: { type: "array", items: objSchema } },
        },
        gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
      ]);
    expect(hashOf(nested(["shared", "first"]), "report")).toBe(
      hashOf(nested(["first", "shared"]), "report"),
    );
    // Duplicates and an empty list normalise at depth as well.
    expect(hashOf(nested(["first", "first", "shared"]), "report")).toBe(
      hashOf(nested(["first", "shared"]), "report"),
    );
  });

  it("still treats a nested branch-body reorder as invalidating", () => {
    // Branch order is not known to be meaningless, so reordering bodies over-invalidates.
    const bodies = (order: readonly string[]) =>
      baseLwir([
        gen("seed"),
        {
          id: "fan",
          uses: "parallel",
          needs: ["seed"],
          with: {
            items: "{{ steps.seed.output.items }}",
            itemKey: "{{ item.id }}",
            cardinality: { kind: "matches_items" },
            maxBranches: 10,
            maxConcurrency: 4,
            failureMode: "fail_fast",
            fanIn: { order: "input", output: "array" },
          },
          steps: order.map((id) => gen(id, { input: "{{ item }}" })),
          output: { mode: "array", schema: { type: "array", items: objSchema } },
        },
        gen("report", { needs: ["fan"], input: "{{ steps.fan.output }}" }),
      ]);
    expect(hashOf(bodies(["two", "one"]), "report")).not.toBe(
      hashOf(bodies(["one", "two"]), "report"),
    );
  });

  it("addresses top-level steps only", () => {
    expect(() => inputConeHash(parallelLwir("summarise", "seed"), "branch")).toThrow(
      LwirInputConeError,
    );
    try {
      inputConeHash(parallelLwir("summarise", "seed"), "branch");
      expect.unreachable("expected a nested_step_unsupported error");
    } catch (error) {
      expect((error as LwirInputConeError).code).toBe("nested_step_unsupported");
    }
  });
});

describe("typed errors", () => {
  function expectConeError(run: () => unknown, code: string): LwirInputConeError {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(LwirInputConeError);
      expect((error as LwirInputConeError).code).toBe(code);
      return error as LwirInputConeError;
    }
    return expect.unreachable(`expected a ${code} error`) as never;
  }

  it("rejects a missing `needs` target", () => {
    const lwir = baseLwir([gen("a"), gen("b", { needs: ["ghost"] })]);
    expectConeError(() => inputConeHash(lwir, "b"), "missing_reference");
  });

  it("rejects a missing expression reference", () => {
    const lwir = baseLwir([gen("a"), gen("b", { needs: ["a"], input: "{{ steps.ghost.output }}" })]);
    expectConeError(() => inputConeHash(lwir, "b"), "missing_reference");
  });

  it("rejects a decision in the cone that routes to a missing step", () => {
    const lwir = baseLwir([
      gen("seed"),
      {
        id: "route",
        uses: "decision",
        needs: ["seed"],
        with: { cases: [{ when: "{{ steps.seed.output.ok }}", to: "left" }], default: "ghost" },
      },
      gen("left"),
    ]);
    expectConeError(() => inputConeHash(lwir, "left"), "missing_reference");
  });

  it("ignores a dangling decision target outside the cone", () => {
    const lwir = baseLwir([
      gen("a"),
      gen("b", { needs: ["a"], input: "{{ steps.a.output }}" }),
      {
        id: "elsewhere",
        uses: "decision",
        needs: ["a"],
        with: { cases: [{ when: "{{ steps.a.output.ok }}", to: "ghost" }], default: "end" },
      },
    ]);
    expect(() => inputConeHash(lwir, "b")).not.toThrow();
  });

  it("rejects an unknown step id", () => {
    expectConeError(() => inputConeHash(chainLwir(), "nope"), "step_not_found");
  });

  it("rejects an empty step id", () => {
    expectConeError(() => inputConeHash(chainLwir(), ""), "step_not_found");
  });

  it("rejects duplicate top-level step ids", () => {
    const lwir = baseLwir([gen("a"), gen("a")]);
    expectConeError(() => inputConeHash(lwir, "a"), "duplicate_step_id");
  });

  it("rejects a non-object document", () => {
    expectConeError(() => inputConeHash("not a workflow", "a"), "invalid_lwir");
  });

  it("rejects a document without a steps array", () => {
    expectConeError(() => inputConeHash({ apiVersion: "x" }, "a"), "invalid_lwir");
  });

  it("rejects a step that is not an object, or has no usable id", () => {
    expectConeError(() => inputConeHash(baseLwir(["nope"]), "a"), "invalid_lwir");
    expectConeError(() => inputConeHash(baseLwir([{ uses: "ai.generate" }]), "a"), "invalid_lwir");
  });

  it("rejects a malformed `needs`", () => {
    expectConeError(
      () => inputConeHash(baseLwir([gen("a"), gen("b", { needs: "a" })]), "b"),
      "invalid_lwir",
    );
    expectConeError(
      () => inputConeHash(baseLwir([gen("a"), gen("b", { needs: [1] })]), "b"),
      "invalid_lwir",
    );
  });

  it("rejects an unhashable document rather than hanging on it", () => {
    const cyclicDocument = baseLwir([gen("a")]) as Record<string, unknown>;
    cyclicDocument.self = cyclicDocument;
    const error = expectConeError(() => inputConeHash(cyclicDocument, "a"), "invalid_lwir");
    expect(error.name).toBe("LwirInputConeError");
  });
});

describe("snapshot", () => {
  it("exposes the exact payload that gets hashed", () => {
    const snapshot = inputConeSnapshot(chainLwir(), "b");
    expect(snapshot.scope).toBe("steps");
    if (snapshot.scope !== "steps") {
      expect.unreachable("expected a steps-scoped snapshot");
      return;
    }
    expect(snapshot.stepId).toBe("b");
    expect(snapshot.influencers.map((step) => step.id)).toEqual(["a"]);
    // The target is hashed whole, exactly like every influencer — no field is dropped.
    expect(snapshot.target).toHaveProperty("output");
    expect(snapshot.influencers[0]).toHaveProperty("output");
  });

  it("carries the workflow envelope as a deny-list: everything but `metadata` and `steps`", () => {
    const snapshot = inputConeSnapshot(chainLwir(), "b");
    if (snapshot.scope !== "steps") {
      expect.unreachable("expected a steps-scoped snapshot");
      return;
    }
    expect(Object.keys(snapshot.workflow).sort()).toEqual([
      "apiVersion",
      "input",
      "kind",
      "output",
      "permissions",
    ]);
    expect(snapshot.workflow.input).toEqual({ schema: objSchema });
    expect(snapshot.workflow.output).toEqual({ schema: objSchema });
  });
});
