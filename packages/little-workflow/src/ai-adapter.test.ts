import { describe, expect, it, vi } from "vitest";
import {
  type AiSdkModuleLike,
  createAiSdkAdapter,
  generateWithAdapter,
  resolveAiSdkMapping,
} from "./ai-adapter.js";

{
  type AiAdapterModule = typeof import("./ai-adapter.js");
  type HasLegacyRuntimeAdapter = "createRuntimeAiAdapter" extends keyof AiAdapterModule ? true : false;
  // @ts-expect-error createRuntimeAiAdapter should not be part of the public API surface.
  const _legacyRuntimeAdapterExport: HasLegacyRuntimeAdapter = true;
  void _legacyRuntimeAdapterExport;
  type HasLegacyPlannerAdapter = "createAiSdkPlannerAdapter" extends keyof AiAdapterModule ? true : false;
  // @ts-expect-error createAiSdkPlannerAdapter should not be part of the public API surface.
  const _legacyPlannerAdapterExport: HasLegacyPlannerAdapter = true;
  void _legacyPlannerAdapterExport;
}

{
  type PublicApiModule = typeof import("./index.js");
  type HasPublicAiSdkAdapter = "createAiSdkAdapter" extends keyof PublicApiModule ? true : false;
  // @ts-expect-error createAiSdkAdapter is an internal bridge, not a package-root export.
  const _publicAiSdkAdapterExport: HasPublicAiSdkAdapter = true;
  void _publicAiSdkAdapterExport;
  type HasPublicGenerateWithAdapter = "generateWithAdapter" extends keyof PublicApiModule ? true : false;
  // @ts-expect-error generateWithAdapter is an internal bridge, not a package-root export.
  const _publicGenerateWithAdapterExport: HasPublicGenerateWithAdapter = true;
  void _publicGenerateWithAdapterExport;
  type HasPublicPlannerAdapter = "PlannerAdapter" extends keyof PublicApiModule ? true : false;
  // @ts-expect-error PlannerAdapter is an internal compatibility type, not a package-root export.
  const _publicPlannerAdapterExport: HasPublicPlannerAdapter = true;
  void _publicPlannerAdapterExport;
  type HasPublicCompileWorkflow = "compileWorkflow" extends keyof PublicApiModule ? true : false;
  // @ts-expect-error compileWorkflow is an internal compiler entrypoint, not a package-root export.
  const _publicCompileWorkflowExport: HasPublicCompileWorkflow = true;
  void _publicCompileWorkflowExport;
}

const profileSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
  },
};

const scoreSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["score"],
    properties: {
      score: { type: "number" },
    },
  },
};

function moduleWithOutput() {
  const calls: unknown[] = [];
  return {
    calls,
    moduleLike: {
      generateText: vi.fn(async (options: unknown) => {
        calls.push(options);
        return {
          output: { ok: true },
          text: "ok",
          // AI SDK 7: `usage` totals every step (v6 called this `totalUsage`).
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
          finishReason: "stop",
          providerMetadata: { gateway: { requestId: "req_123" } },
        };
      }),
      streamText: vi.fn(),
      Output: {
        text: vi.fn(() => ({ outputKind: "text" })),
        object: vi.fn((options: unknown) => ({ outputKind: "object", options })),
        array: vi.fn((options: unknown) => ({ outputKind: "array", options })),
        choice: vi.fn((options: unknown) => ({ outputKind: "choice", options })),
        json: vi.fn((options: unknown) => ({ outputKind: "json", options })),
      },
    },
  };
}

describe("AI SDK adapter", () => {
  it("loads without importing the real ai package or provider packages", async () => {
    const adapterModule = await import("./ai-adapter.js");

    expect(adapterModule.createAiSdkAdapter).toBe(createAiSdkAdapter);
    expect(adapterModule).not.toHaveProperty("createRuntimeAiAdapter");
    expect(adapterModule).not.toHaveProperty("createAiSdkPlannerAdapter");
    expect(typeof adapterModule.generateWithAdapter).toBe("function");
    expect(typeof adapterModule.resolveAiSdkMapping).toBe("function");
  });

  it("keeps internal adapter and compiler helpers off the package root", async () => {
    const publicApi = await import("./index.js");

    expect(publicApi).not.toHaveProperty("createAiSdkAdapter");
    expect(publicApi).not.toHaveProperty("generateWithAdapter");
    expect(publicApi).not.toHaveProperty("resolveAiSdkMapping");
    expect(publicApi).not.toHaveProperty("compileWorkflow");
  });

  it("detects the primary generateText + Output helper mapping", () => {
    const { moduleLike } = moduleWithOutput();

    expect(resolveAiSdkMapping(moduleLike)).toEqual({
      strategy: "generateText.output",
      generateFunction: "generateText",
      streamFunction: "streamText",
      outputHelpers: {
        text: "Output.text",
        object: "Output.object",
        array: "Output.array",
        choice: "Output.choice",
        json: "Output.json",
      },
    });
  });

  it("maps every output mode through injected Output helpers", async () => {
    const { calls, moduleLike } = moduleWithOutput();
    const adapter = createAiSdkAdapter(moduleLike);

    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "Draft a summary.",
      output: { mode: "text" },
    });
    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "Extract a profile.",
      output: { mode: "object", schema: profileSchema, name: "profile" },
    });
    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "Score candidates.",
      output: {
        mode: "array",
        schema: scoreSchema,
        name: "scores",
        description: "Candidate scores.",
      },
    });
    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "Pick one.",
      output: {
        mode: "choice",
        values: ["approve", "reject"],
        name: "decision",
        description: "Allowed decisions.",
      },
    });
    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "Return JSON.",
      output: { mode: "json", schema: profileSchema, name: "payload" },
    });

    expect(moduleLike.Output.text).toHaveBeenCalledWith();
    expect(moduleLike.Output.object).toHaveBeenCalledWith({
      schema: profileSchema,
      name: "profile",
    });
    // Array mode goes through Output.object with the full array schema (not
    // Output.array, which wraps as { elements: T[] } and breaks providers that
    // return a raw top-level JSON array).
    expect(moduleLike.Output.object).toHaveBeenCalledWith({
      schema: scoreSchema,
      name: "scores",
      description: "Candidate scores.",
    });
    expect(moduleLike.Output.array).not.toHaveBeenCalled();
    expect(moduleLike.Output.choice).toHaveBeenCalledWith({
      options: ["approve", "reject"],
      name: "decision",
      description: "Allowed decisions.",
    });
    expect(moduleLike.Output.json).toHaveBeenCalledWith({
      name: "payload",
    });
    expect(calls).toHaveLength(5);
    expect(calls).toEqual([
      expect.objectContaining({ output: { outputKind: "text" } }),
      expect.objectContaining({ output: { outputKind: "object", options: expect.any(Object) } }),
      expect.objectContaining({ output: { outputKind: "object", options: expect.any(Object) } }),
      expect.objectContaining({ output: { outputKind: "choice", options: expect.any(Object) } }),
      expect.objectContaining({ output: { outputKind: "json", options: expect.any(Object) } }),
    ]);
  });

  it("streams via streamText when stream:true, draining promise fields", async () => {
    const streamText = vi.fn((options: unknown) => ({
      // streamText exposes terminal values as promises; the adapter awaits them.
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([{ toolName: "lookup", input: { x: 1 }, toolCallId: "c1" }]),
      output: Promise.resolve({ ok: true }),
      usage: Promise.resolve({ inputTokens: 9, outputTokens: 4, totalTokens: 13 }),
      finishReason: Promise.resolve("tool-calls"),
      providerMetadata: Promise.resolve({ deepseek: { promptCacheHitTokens: 7 } }),
      _request: options,
    }));
    const moduleLike = {
      generateText: vi.fn(),
      streamText,
      Output: {
        text: vi.fn(() => ({ outputKind: "text" })),
        object: vi.fn((o: unknown) => ({ outputKind: "object", options: o })),
        array: vi.fn((o: unknown) => ({ outputKind: "array", options: o })),
        choice: vi.fn((o: unknown) => ({ outputKind: "choice", options: o })),
        json: vi.fn((o: unknown) => ({ outputKind: "json", options: o })),
      },
    };
    const adapter = createAiSdkAdapter(moduleLike);

    const result = await generateWithAdapter(adapter, {
      model: "model.fast",
      messages: [{ role: "user", content: "hi" }],
      output: { mode: "object", schema: { type: "object" } },
      stream: true,
    });

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(moduleLike.generateText).not.toHaveBeenCalled();
    expect(result.output).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
    expect((result.raw as { readonly toolCalls?: unknown }).toolCalls).toEqual([
      { toolName: "lookup", input: { x: 1 }, toolCallId: "c1" },
    ]);
  });

  it("falls back to generateText when stream:true but no streamText is available", async () => {
    const { moduleLike, calls } = moduleWithOutput();
    const adapter = createAiSdkAdapter({ ...moduleLike, streamText: undefined });
    await generateWithAdapter(adapter, {
      model: "model.fast",
      prompt: "hi",
      output: { mode: "text" },
      stream: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("reads cached and reasoning tokens from AI SDK 7 usage details", async () => {
    // AI SDK 7 dropped the flat `cachedInputTokens`/`reasoningTokens`; missing them would bill
    // cached input at the full rate.
    const { moduleLike } = moduleWithOutput();
    moduleLike.generateText.mockResolvedValueOnce({
      output: { ok: true },
      text: "ok",
      usage: {
        inputTokens: 10,
        inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 },
        outputTokens: 5,
        outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
        totalTokens: 15,
      },
      finishReason: "stop",
      providerMetadata: {},
    } as never);

    const result = await generateWithAdapter(createAiSdkAdapter(moduleLike), {
      model: "model.fast",
      prompt: "Extract a profile.",
      output: { mode: "object", schema: profileSchema },
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 6,
      reasoningTokens: 2,
    });
  });

  it("captures output, usage, finish reason, provider metadata, and mapping lock", async () => {
    const { moduleLike } = moduleWithOutput();
    const adapter = createAiSdkAdapter(moduleLike);
    const abortController = new AbortController();

    const result = await generateWithAdapter(adapter, {
      model: "model.fast",
      system: "Be precise.",
      prompt: "Extract a profile.",
      output: { mode: "object", schema: profileSchema },
      providerOptions: { gateway: { tags: ["alpha"] } },
      abortSignal: abortController.signal,
      timeout: 12_345,
    });

    expect(result).toEqual({
      output: { ok: true },
      text: "ok",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      finishReason: "stop",
      providerMetadata: { gateway: { requestId: "req_123" } },
      mapping: resolveAiSdkMapping(moduleLike),
      resultField: "output",
      raw: expect.any(Object),
    });
    expect(moduleLike.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model.fast",
        instructions: "Be precise.",
        prompt: "Extract a profile.",
        providerOptions: { gateway: { tags: ["alpha"] } },
        abortSignal: abortController.signal,
        timeout: 12_345,
      }),
    );
  });

  it("passes output: helper result to generateText (AI SDK contract)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const moduleLike = {
      generateText: async (request: Record<string, unknown>) => {
        calls.push(request);
        return {
          text: "{}",
          output: { hello: true },
          // experimental_output intentionally undefined to prove the adapter
          // is not relying on the v5 parameter name.
          experimental_output: undefined,
        };
      },
      streamText: () => ({}),
      Output: {
        text: () => ({ helperKind: "text" }),
        object: ({ schema }: { schema: unknown }) => ({ helperKind: "object", schema }),
        array: () => ({ helperKind: "array" }),
        choice: () => ({ helperKind: "choice" }),
        json: () => ({ helperKind: "json" }),
      },
    };
    const adapter = createAiSdkAdapter(moduleLike as unknown as AiSdkModuleLike);
    await generateWithAdapter(adapter, {
      model: { providerId: "demo", modelId: "demo" },
      output: { mode: "object", schema: { type: "object" } },
      prompt: "hi",
    });
    expect(calls[0]).toMatchObject({
      output: { helperKind: "object", schema: { type: "object" } },
    });
    expect(calls[0]).not.toHaveProperty("experimental_output");
  });

  describe("resolveAiSdkMapping (post-v6)", () => {
    it("rejects modules that ship generateObject without Output helpers", () => {
      // Cast: simulate a v5-era SDK module passed at runtime (no generateText/Output).
      const legacyOnlyModule = {
        generateObject: async () => ({}),
        streamObject: () => ({}),
      } as unknown as import("./ai-adapter.js").AiSdkModuleLike;
      expect(() => resolveAiSdkMapping(legacyOnlyModule)).toThrow(
        /AI SDK adapter requires generateText with Output helpers/,
      );
    });

    it("does not expose a legacy.generateObject strategy", () => {
      const v6Module = {
        generateText: async () => ({}),
        streamText: () => ({}),
        Output: {
          text: () => ({}),
          object: () => ({}),
          array: () => ({}),
          choice: () => ({}),
          json: () => ({}),
        },
      };
      const mapping = resolveAiSdkMapping(v6Module);
      expect(mapping.strategy).toBe("generateText.output");
      const strategies: ReadonlyArray<typeof mapping.strategy> = [
        "generateText.output",
      ];
      expect(strategies).toContain(mapping.strategy);
    });
  });

});
