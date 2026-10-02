import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dreamerModel, setDreamerModel } from "../agents/dreamer/env";
import { transientReason, withModelRetry } from "../agents/dreamer/model-retry";
import { usage } from "./support/mock-model";

/**
 * The failure this wrapper exists for, reproduced exactly as DeepSeek delivers it: a 200
 * whose body never parsed, which the provider therefore marks NOT retryable — so the AI
 * SDK's own retry loop (gated on `isRetryable`) walks straight past it.
 *
 * `responseBody` is omitted rather than set to `undefined` because `exactOptionalPropertyTypes`
 * is on; the field reads back as `undefined` either way, which is the condition under test.
 */
function unparseableSuccess(): APICallError {
  return new APICallError({
    message: "Failed to process successful response",
    url: "https://api.deepseek.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    isRetryable: false,
  });
}

/** A provider answer that IS an answer: read, considered, and returned with a body. */
function badRequest(): APICallError {
  return new APICallError({
    message: "invalid model id",
    url: "https://api.deepseek.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "Model Not Exist" } }),
    isRetryable: false,
  });
}

const GENERATED = {
  content: [{ type: "text" as const, text: "ok" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
};

/**
 * A model that throws its first `failures` calls and then answers. One counter serves both
 * `doGenerate` and `doStream` so a test can assert "the underlying model was called twice".
 */
function flakyModel(options: {
  readonly failures: number;
  readonly error: () => unknown;
}): MockLanguageModelV3 & { readonly stats: { calls: number } } {
  const stats = { calls: 0 };
  const attempt = (): void => {
    stats.calls += 1;
    if (stats.calls <= options.failures) throw options.error();
  };
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "flaky",
    doGenerate: async () => {
      attempt();
      return GENERATED;
    },
    doStream: async () => {
      attempt();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });
  return Object.assign(model, { stats });
}

/**
 * Call a wrapped model the way the AI SDK does.
 *
 * `withModelRetry` returns the `LanguageModel` union (it also accepts a bare model id), so a
 * caller reaching for the transport methods has to narrow. The test knows it passed an
 * object in, which is exactly what this cast says.
 */
function callModel(
  model: LanguageModel,
  method: "doGenerate" | "doStream",
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const transport = model as unknown as Record<string, (options: unknown) => Promise<unknown>>;
  const call = transport[method];
  if (call === undefined) throw new Error(`wrapped model has no ${method}`);
  return call.call(model, {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...extra,
  });
}

function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => void lines.push(line) };
}

/** Tests never wait: the backoff schedule is asserted from what the wrapper asked for. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

describe("the model retry wrapper", () => {
  it("retries an unparseable 200 and succeeds, logging one line per retry", async () => {
    const base = flakyModel({ failures: 1, error: unparseableSuccess });
    const { lines, log } = collector();
    const { waits, sleep } = recordingSleep();

    const result = await callModel(withModelRetry(base, { log, sleep }), "doGenerate");

    expect(result).toMatchObject({ finishReason: { unified: "stop" } });
    expect(base.stats.calls).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("doGenerate");
    expect(lines[0]).toContain("empty response body (HTTP 200)");
    expect(waits).toEqual([1_000]);
  });

  it("retries a stream that fails before it hands back a stream", async () => {
    // The path that matters most by volume: the template workflows' `ai.generate` steps run
    // through `streamText`, so the 61-call sweep never touches `doGenerate` at all.
    const base = flakyModel({ failures: 2, error: unparseableSuccess });
    const { lines, log } = collector();
    const { waits, sleep } = recordingSleep();

    const result = await callModel(withModelRetry(base, { log, sleep }), "doStream");

    expect(result).toHaveProperty("stream");
    expect(base.stats.calls).toBe(3);
    expect(lines.map((line) => line.includes("doStream"))).toEqual([true, true]);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("does not retry a 4xx that came back with a body", async () => {
    const base = flakyModel({ failures: 1, error: badRequest });
    const { lines, log } = collector();
    const { sleep } = recordingSleep();

    await expect(callModel(withModelRetry(base, { log, sleep }), "doGenerate")).rejects.toThrow(
      "invalid model id",
    );
    expect(base.stats.calls).toBe(1);
    expect(lines).toEqual([]);
  });

  it("surfaces the error once the retries are used up", async () => {
    const base = flakyModel({ failures: Number.MAX_SAFE_INTEGER, error: unparseableSuccess });
    const { lines, log } = collector();
    const { waits, sleep } = recordingSleep();

    await expect(callModel(withModelRetry(base, { log, sleep }), "doGenerate")).rejects.toThrow(
      "Failed to process successful response",
    );
    // Three retries after the first attempt, then the caller sees the real error.
    expect(base.stats.calls).toBe(4);
    expect(lines).toHaveLength(3);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("does not retry once the caller has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const base = flakyModel({
      failures: 1,
      error: () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const { lines, log } = collector();
    const { sleep } = recordingSleep();

    await expect(
      callModel(withModelRetry(base, { log, sleep }), "doGenerate", {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("socket hang up");
    expect(base.stats.calls).toBe(1);
    expect(lines).toEqual([]);
  });

  describe("what counts as transient", () => {
    it("retries transport failures and nothing else", () => {
      expect(transientReason(unparseableSuccess())).toBe("empty response body (HTTP 200)");
      expect(
        transientReason(
          new APICallError({
            message: "bad gateway",
            url: "u",
            requestBodyValues: {},
            statusCode: 502,
            responseBody: "<html>502</html>",
          }),
        ),
      ).toBe("HTTP 502");
      expect(transientReason(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(
        "socket error ECONNRESET",
      );
      // Wrapped one level down, which is how undici surfaces a dead connection.
      expect(
        transientReason(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          }),
        ),
      ).toBe("socket error ECONNRESET");

      expect(transientReason(badRequest())).toBeUndefined();
      expect(transientReason(new Error("I cannot help with that"))).toBeUndefined();
      expect(transientReason(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBeUndefined();
      // A 429 with a body is the provider answering; backing off is the caller's business.
      expect(
        transientReason(
          new APICallError({
            message: "rate limited",
            url: "u",
            requestBodyValues: {},
            statusCode: 429,
            responseBody: "slow down",
          }),
        ),
      ).toBeUndefined();
    });
  });
});

describe("the wrapper's place in the model path", () => {
  afterEach(() => {
    setDreamerModel(undefined);
  });

  /**
   * The point of this test: `dreamerModel()` is the single source every model call in the
   * demo comes from — `agent.ts` for the dreamer's turns, each `workflows/*.ts` for its
   * `ai.generate` steps. If the wrapper were merely defined and not wired, this fails.
   *
   * It runs on the real defaults (no injected `sleep`), so it also proves the shipped
   * backoff is finite and the shipped log goes to stderr.
   */
  it("dreamerModel() returns a model that retries", async () => {
    const base = flakyModel({ failures: 1, error: unparseableSuccess });
    setDreamerModel(base);

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const result = await callModel(dreamerModel(), "doGenerate");
      expect(result).toMatchObject({ finishReason: { unified: "stop" } });
    } finally {
      stderr.mockRestore();
    }

    expect(base.stats.calls).toBe(2);
    expect(written.join("")).toContain("[dreamer] model doGenerate failed");
  }, 20_000);
});
