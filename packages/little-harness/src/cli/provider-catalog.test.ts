import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_CHOICE,
  modelChoices,
  providerChoices,
  renderAgentSource,
  providerEnvVars,
  resolveModelChoice,
  resolveProvider,
} from "./provider-catalog.js";

describe("provider catalog", () => {
  it("pins every provider package to a range instead of latest", () => {
    for (const { value } of providerChoices()) {
      const provider = resolveProvider(value);
      if (provider.packageName === undefined) {
        expect(provider.packageVersion).toBeUndefined();
        continue;
      }
      expect(provider.packageVersion, provider.id).toMatch(/^\^\d+\.\d+\.\d+$/u);
    }
  });

  it("lists AI SDK provider choices", () => {
    expect(providerChoices().map((choice) => choice.value)).toEqual([
      "gateway",
      "vercel",
      "openai",
      "azure",
      "anthropic",
      "open-responses",
      "bedrock",
      "groq",
      "deepinfra",
      "google",
      "google-vertex",
      "xai",
      "mistral",
      "togetherai",
      "cohere",
      "fireworks",
      "deepseek",
      "moonshotai",
      "alibaba",
      "cerebras",
      "perplexity",
      "baseten",
      "huggingface",
      "openai-compatible",
    ]);
  });

  it("resolves provider metadata by AI SDK provider name", () => {
    expect(resolveProvider("openai")).toMatchObject({
      id: "openai",
      packageName: "@ai-sdk/openai",
      exportName: "openai",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
  });

  it("uses a current Cerebras default model from the AI SDK provider docs", () => {
    expect(resolveProvider("cerebras").defaultModel).toBe("gpt-oss-120b");
  });

  it("throws for unknown providers", () => {
    expect(() => resolveProvider("made-up")).toThrow(/unknown provider/i);
  });

  it("resolves additional AI SDK language provider metadata", () => {
    expect(resolveProvider("azure")).toMatchObject({
      packageName: "@ai-sdk/azure",
      exportName: "azure",
      apiKeyEnvVar: "AZURE_API_KEY",
    });
    expect(resolveProvider("bedrock")).toMatchObject({
      packageName: "@ai-sdk/amazon-bedrock",
      exportName: "bedrock",
      apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    });
    expect(resolveProvider("huggingface")).toMatchObject({
      packageName: "@ai-sdk/huggingface",
      exportName: "huggingface",
      apiKeyEnvVar: "HUGGINGFACE_API_KEY",
    });
  });

  it("resolves known and custom model ids", () => {
    expect(resolveModelChoice("openai", "gpt-5.2")).toEqual("gpt-5.2");
    expect(resolveModelChoice("openai", "custom-model-id")).toEqual("custom-model-id");
  });

  it("offers a custom model choice for prompt fallbacks", () => {
    expect(modelChoices("openai").at(-1)).toMatchObject({
      value: CUSTOM_MODEL_CHOICE,
      name: expect.stringMatching(/custom/i),
    });
  });

  it("renders provider imports and model calls", () => {
    expect(renderAgentSource({ provider: "openai", model: "gpt-5.2" })).toContain(
      'import { openai } from "@ai-sdk/openai";',
    );
    expect(renderAgentSource({ provider: "openai", model: "gpt-5.2" })).toContain(
      'model: openai("gpt-5.2")',
    );
    expect(renderAgentSource({ provider: "gateway", model: "anthropic/claude-sonnet-4-6" })).toContain(
      'import { gateway } from "ai";',
    );
    expect(renderAgentSource({ provider: "gateway", model: "anthropic/claude-sonnet-4-6" })).toContain(
      'model: gateway("anthropic/claude-sonnet-4-6")',
    );
  });

  it("renders an OpenAI-compatible provider scaffold with base URL and API key env vars", () => {
    const source = renderAgentSource({ provider: "openai-compatible", model: "local-model" });
    expect(source).toContain('import { createOpenAICompatible } from "@ai-sdk/openai-compatible";');
    expect(source).toContain("OPENAI_COMPATIBLE_BASE_URL");
    expect(source).toContain("OPENAI_COMPATIBLE_API_KEY");
    expect(source).toContain('model: openaiCompatible("local-model")');
  });

  it("renders an Open Responses provider scaffold with URL and API key env vars", () => {
    const source = renderAgentSource({ provider: "open-responses", model: "mistralai/ministral-3-14b-reasoning" });
    expect(source).toContain('import { createOpenResponses } from "@ai-sdk/open-responses";');
    expect(source).toContain("OPEN_RESPONSES_URL");
    expect(source).toContain("OPEN_RESPONSES_API_KEY");
    expect(source).toContain('model: openResponses("mistralai/ministral-3-14b-reasoning")');
  });

  it("treats the Open Responses API key as optional setup", () => {
    const provider = resolveProvider("open-responses");
    expect(providerEnvVars(provider)).toEqual(["OPEN_RESPONSES_URL"]);
    expect(renderAgentSource({ provider: "open-responses" })).toContain("Optional: set OPEN_RESPONSES_API_KEY");
  });
});
