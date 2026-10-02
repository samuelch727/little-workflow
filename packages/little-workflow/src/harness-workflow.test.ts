import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateHarnessWorkflowExecution } from "little-harness";
import { defineWorkflow, model } from "./authoring.js";
import { RunFailedError } from "./runtime.js";
import {
  asHarnessWorkflow,
  mapWorkflowError,
  summarizeWorkflowOutput,
  toHarnessWorkflowInputSchemaMarker,
  MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS,
} from "./harness-workflow.js";

function workflow() {
  return defineWorkflow({
    id: "candidate.review",
    description: "Review a candidate.",
    model: model({ provider: "test", modelId: "planner" } as never),
  });
}

function harnessContext(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    definitionIdentity: "sha256:test-candidate-review",
    toolCallId: "tool_1",
    disposition: "await",
    parentSessionId: "sess_1",
    parentTurnId: "turn_1",
    originTurnId: "turn_1",
    reservedRunId: "run_test",
    persistence: { dataDir: ".little-workflow" },
    observation: { recordProgress: async () => undefined },
    inheritance: {},
    ...overrides,
  };
}

describe("asHarnessWorkflow", () => {
  it("exposes a structural HarnessWorkflow with durable execution mode", () => {
    const adapted = asHarnessWorkflow(workflow(), {
      executionMode: "durable",
      definitionIdentity: "sha256:test-candidate-review",
    });

    expect(adapted).toMatchObject({
      id: "candidate.review",
      description: "Review a candidate.",
      executionMode: "durable",
      definitionIdentity: "sha256:test-candidate-review",
    });
    expect(typeof adapted.runForHarness).toBe("function");
  });

  it("requires manual adapters to provide workflow definition identity", () => {
    expect(() => asHarnessWorkflow(workflow(), { executionMode: "durable" } as never))
      .toThrow(/definition identity/i);
  });

  it("allows callers to provide an explicit workflow definition identity", () => {
    const adapted = asHarnessWorkflow(workflow(), {
      definitionIdentity: { notApplicable: true, reason: "test fixture" },
    });

    expect(adapted.definitionIdentity).toEqual({ notApplicable: true, reason: "test fixture" });
  });

  it("requires explicit opt-in for untyped workflow input", () => {
    expect(asHarnessWorkflow(workflow(), { definitionIdentity: "sha256:test-candidate-review" }).inputSchema).toEqual({
      kind: "untyped",
      allowUntypedInput: false,
    });
    expect(asHarnessWorkflow(workflow(), {
      allowUntypedInput: true,
      definitionIdentity: "sha256:test-candidate-review",
    }).inputSchema).toEqual({
      kind: "untyped",
      allowUntypedInput: true,
    });
  });

  it("treats boolean true input schemas as untyped markers", () => {
    expect(toHarnessWorkflowInputSchemaMarker(true, { allowUntypedInput: false })).toEqual({
      kind: "untyped",
      allowUntypedInput: false,
    });
    expect(toHarnessWorkflowInputSchemaMarker(true, { allowUntypedInput: true })).toEqual({
      kind: "untyped",
      allowUntypedInput: true,
    });
  });

  it("fails closed on unsupported context protocol version", async () => {
    const adapted = asHarnessWorkflow(workflow(), {
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
    });

    await expect(adapted.runForHarness({}, harnessContext({ protocolVersion: 999 }) as never))
      .resolves.toMatchObject({
        protocolVersion: 1,
        status: "failed",
        causeCode: "unsupported_protocol",
      });
  });

  it("fails closed when observation progress sink is missing", async () => {
    const adapted = asHarnessWorkflow(workflow(), {
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
    });

    await expect(adapted.runForHarness({}, harnessContext({ observation: undefined }) as never))
      .resolves.toMatchObject({
        protocolVersion: 1,
        status: "failed",
        causeCode: "unsupported_protocol",
      });
  });

  it("fails closed on unknown disposition", async () => {
    const adapted = asHarnessWorkflow(workflow(), {
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
    });

    await expect(adapted.runForHarness({}, harnessContext({ disposition: "sideways" }) as never))
      .resolves.toMatchObject({
        protocolVersion: 1,
        status: "failed",
        causeCode: "unsupported_protocol",
      });
  });

  it("fails closed when a detached start is requested for an inline workflow", async () => {
    const adapted = asHarnessWorkflow(workflow(), {
      executionMode: "inline",
      definitionIdentity: "sha256:test-candidate-review",
    });

    await expect(adapted.runForHarness({}, harnessContext({ disposition: "start" }) as never))
      .resolves.toMatchObject({
        protocolVersion: 1,
        status: "failed",
        causeCode: "unsupported_protocol",
      });
  });
});

describe("toHarnessWorkflowInputSchemaMarker", () => {
  it("marks opaque StandardSchema validators unconvertible by default", () => {
    const marker = toHarnessWorkflowInputSchemaMarker({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }, { allowUntypedInput: false });

    expect(marker).toMatchObject({ kind: "unconvertible" });
  });

  it("converts zod schemas through the normal schema normalization path", () => {
    const marker = toHarnessWorkflowInputSchemaMarker(z.object({
      candidateId: z.string(),
    }), { allowUntypedInput: false });

    expect(marker).toMatchObject({ kind: "json-schema" });
    expect(marker.kind === "json-schema" ? marker.schema : undefined).toMatchObject({
      type: "object",
      properties: {
        candidateId: expect.objectContaining({ type: "string" }),
      },
    });
  });

  it("allows explicit lossy fallback for opaque StandardSchema validators", () => {
    const marker = toHarnessWorkflowInputSchemaMarker({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }, { allowUntypedInput: false, allowLossyStandardSchema: true });

    expect(marker).toMatchObject({
      kind: "json-schema",
      lossy: true,
    });
    expect(marker.kind === "json-schema" ? marker.warning : undefined).toMatch(/opaque standardschema/i);
  });

  it("marks unconvertible input schemas instead of exposing invalid tool schemas", () => {
    const marker = toHarnessWorkflowInputSchemaMarker({
      transform: () => undefined,
    }, { allowUntypedInput: false });

    expect(marker).toMatchObject({ kind: "unconvertible" });
  });

  it("does not rescue transform-like StandardSchema values through embedded JSON Schema", () => {
    const marker = toHarnessWorkflowInputSchemaMarker(z.string().transform((value) => value.length), {
      allowUntypedInput: false,
      allowLossyStandardSchema: true,
    });

    expect(marker).toMatchObject({ kind: "unconvertible" });
  });
});

describe("mapWorkflowError", () => {
  it("maps RunFailedError cause codes structurally and prefers the error run id", () => {
    const timeout = mapWorkflowError(new RunFailedError({
      runId: "run_error",
      workflowVersionId: "wv",
      causeCode: "timeout",
    }), "run_fallback");
    expect(timeout).toMatchObject({ status: "failed", runId: "run_error", causeCode: "timeout" });

    const cancelled = mapWorkflowError(new RunFailedError({
      runId: "run_cancel",
      workflowVersionId: "wv",
      causeCode: "cancelled",
    }), "run_fallback");
    expect(cancelled).toMatchObject({ status: "cancelled", runId: "run_cancel", causeCode: "cancelled" });

    const input = mapWorkflowError(new RunFailedError({
      runId: "run_input",
      workflowVersionId: "wv",
      causeCode: "input_schema_error",
    }), "run_fallback");
    expect(input).toMatchObject({ status: "failed", runId: "run_input", causeCode: "input_validation" });

    const step = mapWorkflowError(new RunFailedError({
      runId: "run_step",
      workflowVersionId: "wv",
      causeCode: "step_failed",
    }), "run_fallback");
    expect(step).toMatchObject({ status: "failed", runId: "run_step", causeCode: "workflow_failed" });
  });

  it("emits a non-empty message for empty-message step failures so harness validation accepts it", () => {
    const mapped = mapWorkflowError(new RunFailedError({
      runId: "run_empty",
      workflowVersionId: "wv",
      causeCode: "step_failed",
      message: "",
    }), "run_fallback");
    expect(mapped).toMatchObject({ status: "failed", causeCode: "workflow_failed" });
    expect((mapped as { message: string }).message.length).toBeGreaterThan(0);
    expect(() => validateHarnessWorkflowExecution(mapped as never)).not.toThrow();
  });

  it("summarizes the failing step and runtime cause code when the run identifies one", () => {
    const mapped = mapWorkflowError(new RunFailedError({
      runId: "run_step",
      workflowVersionId: "wv",
      causeCode: "step_failed",
      failedStepPath: "review.score",
      message: "scoring service unavailable",
    }), "run_fallback");

    expect(mapped).toMatchObject({
      status: "failed",
      causeCode: "workflow_failed",
      // The Harness cause-code vocabulary collapses step_failed into workflow_failed; the summary
      // keeps the step path and the runtime cause the model would otherwise never see.
      summary: "Failed at step 'review.score' (step_failed): scoring service unavailable",
    });
    expect(() => validateHarnessWorkflowExecution(mapped as never)).not.toThrow();
  });

  it("omits the summary when there is no failing step to add beyond the message", () => {
    const mapped = mapWorkflowError(new RunFailedError({
      runId: "run_timeout",
      workflowVersionId: "wv",
      causeCode: "timeout",
      message: "Run timed out.",
    }), "run_fallback");

    expect(mapped).toMatchObject({ status: "failed", causeCode: "timeout" });
    expect((mapped as { summary?: string }).summary).toBeUndefined();
  });

  it("caps an oversized failure summary", () => {
    const mapped = mapWorkflowError(new RunFailedError({
      runId: "run_loud",
      workflowVersionId: "wv",
      causeCode: "step_failed",
      failedStepPath: "review.score",
      message: "e".repeat(20000),
    }), "run_fallback");

    const summary = (mapped as { summary: string }).summary;
    expect(summary.indexOf("…[truncated:")).toBe(MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS);
    expect(summary).toContain("the full value is recorded in run run_loud");
  });

  it("emits non-empty messages for empty-message AbortError/TimeoutError", () => {
    const abort = mapWorkflowError(Object.assign(new Error(""), { name: "AbortError" }), "run_abort");
    expect(abort).toMatchObject({ status: "cancelled", causeCode: "cancelled" });
    expect((abort as { message: string }).message.length).toBeGreaterThan(0);
    expect(() => validateHarnessWorkflowExecution(abort as never)).not.toThrow();

    const timeout = mapWorkflowError(Object.assign(new Error(""), { name: "TimeoutError" }), "run_timeout");
    expect(timeout).toMatchObject({ status: "failed", causeCode: "timeout" });
    expect((timeout as { message: string }).message.length).toBeGreaterThan(0);
    expect(() => validateHarnessWorkflowExecution(timeout as never)).not.toThrow();
  });
});

describe("summarizeWorkflowOutput", () => {
  it("renders the same output to the same summary every time", () => {
    const output = { recommendation: "advance", scores: [1, 2, 3], notes: { a: 1 } };
    const first = summarizeWorkflowOutput(output, "run_1");
    const second = summarizeWorkflowOutput(output, "run_1");
    const structuralTwin = summarizeWorkflowOutput(
      { recommendation: "advance", scores: [1, 2, 3], notes: { a: 1 } },
      "run_1",
    );

    expect(first).toBe(second);
    expect(first).toBe(structuralTwin);
    expect(first).toBe('{"recommendation":"advance","scores":[1,2,3],"notes":{"a":1}}');
  });

  it("passes strings through without re-encoding them", () => {
    expect(summarizeWorkflowOutput("plain text result", "run_1")).toBe("plain text result");
  });

  it("truncates at the cap and marks the truncation with the full size and run id", () => {
    const summary = summarizeWorkflowOutput("y".repeat(9000), "run_big");

    expect(summary.slice(0, MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS)).toBe(
      "y".repeat(MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS),
    );
    expect(summary.slice(MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS)).toBe(
      `…[truncated: ${MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS} of 9000 characters; the full value is recorded in run run_big]`,
    );
  });

  it("does not truncate a value that exactly fills the cap", () => {
    const exact = "z".repeat(MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS);
    expect(summarizeWorkflowOutput(exact, "run_1")).toBe(exact);
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    // The cap lands mid-pair, so the trailing lone high surrogate must be dropped.
    const summary = summarizeWorkflowOutput("a".repeat(4095) + "😀".repeat(10), "run_1", 4096);

    expect(summary.slice(0, 4095)).toBe("a".repeat(4095));
    expect(summary.charCodeAt(4095)).not.toBeGreaterThanOrEqual(0xd800);
    expect(summary).toContain("…[truncated: 4095 of ");
    expect([...summary]).not.toContain("\ud83d");
  });

  it("degrades unrenderable output instead of turning a completed run into a failure", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => summarizeWorkflowOutput(circular, "run_1")).not.toThrow();
    expect(summarizeWorkflowOutput(circular, "run_1").length).toBeGreaterThan(0);

    expect(summarizeWorkflowOutput(10n, "run_1")).toBe("10");
    expect(summarizeWorkflowOutput(Object.create(null), "run_1")).toBe("{}");
  });

  it("always produces a string for outputs JSON cannot encode", () => {
    expect(summarizeWorkflowOutput(undefined, "run_1")).toBe("undefined");
    expect(typeof summarizeWorkflowOutput(() => undefined, "run_1")).toBe("string");
  });
});

describe("runForHarness", () => {
  it("summarizes a completed run's output so the calling model can see the result", async () => {
    vi.resetModules();
    const runWorkflow = vi.fn(async (options: { readonly runId?: string }) => ({
      status: "completed",
      output: { recommendation: "advance" },
      runId: options.runId ?? "run_test",
      workflowVersionId: "wv",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
      artifacts: [],
    }));
    vi.doMock("./runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./runtime.js")>();
      return { ...actual, runWorkflow };
    });

    const [{ asHarnessWorkflow: mockedAsHarnessWorkflow }, { defineWorkflow: mockedDefineWorkflow, model: mockedModel }] =
      await Promise.all([
        import("./harness-workflow.js"),
        import("./authoring.js"),
      ]);
    const adapted = mockedAsHarnessWorkflow(
      mockedDefineWorkflow({
        id: "candidate.review.summary",
        model: mockedModel({ provider: "test", modelId: "planner" } as never),
      }),
      { definitionIdentity: "sha256:test-summary" },
    );

    const execution = await adapted.runForHarness({}, harnessContext({ reservedRunId: "run_summary" }) as never);
    expect(execution).toMatchObject({
      status: "completed",
      output: { recommendation: "advance" },
      summary: '{"recommendation":"advance"}',
    });
    expect(() => validateHarnessWorkflowExecution(execution as never)).not.toThrow();

    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });


  it("does not reuse a construction-time AbortSignal when the Harness context omits one", async () => {
    vi.resetModules();
    const runWorkflow = vi.fn(async (options: { readonly runId?: string; readonly signal?: AbortSignal }) => ({
      status: "completed",
      output: { signalWasPresent: options.signal !== undefined },
      runId: options.runId ?? "run_test",
      workflowVersionId: "wv",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: [],
      artifacts: [],
    }));
    vi.doMock("./runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./runtime.js")>();
      return { ...actual, runWorkflow };
    });

    const [{ asHarnessWorkflow: mockedAsHarnessWorkflow }, { defineWorkflow: mockedDefineWorkflow, model: mockedModel }] =
      await Promise.all([
        import("./harness-workflow.js"),
        import("./authoring.js"),
      ]);
    const controller = new AbortController();
    controller.abort();
    const adapted = mockedAsHarnessWorkflow(
      mockedDefineWorkflow({
        id: "candidate.review.signal",
        model: mockedModel({ provider: "test", modelId: "planner" } as never),
      }),
      {
        definitionIdentity: "sha256:test-signal",
        signal: controller.signal,
      },
    );

    await expect(adapted.runForHarness({}, harnessContext({ reservedRunId: "run_signal" }) as never))
      .resolves.toMatchObject({
        status: "completed",
        output: { signalWasPresent: false },
      });
    expect(runWorkflow).toHaveBeenCalledWith(expect.objectContaining({ signal: undefined }));

    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });
});
