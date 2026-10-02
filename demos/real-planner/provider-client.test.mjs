import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeepseekModels } from "./provider-client.mjs";

test("resolveDeepseekModels selects DeepSeek models for planner and worker", () => {
  const seen = {
    options: undefined,
    modelIds: [],
  };
  const plannerSentinel = { kind: "planner-model" };
  const workerSentinel = { kind: "worker-model" };
  const createProvider = (options) => {
    seen.options = options;
    return (modelId) => {
      seen.modelIds.push(modelId);
      return seen.modelIds.length === 1 ? plannerSentinel : workerSentinel;
    };
  };

  const result = resolveDeepseekModels({
    apiKey: "secret",
    baseURL: "https://api.deepseek.com/v1",
    modelId: "deepseek-v4-pro",
    createProvider,
  });

  assert.equal(seen.options.apiKey, "secret");
  assert.equal(seen.options.baseURL, "https://api.deepseek.com/v1");
  assert.deepEqual(seen.modelIds, ["deepseek-v4-pro", "deepseek-v4-pro"]);
  assert.equal(result.plannerModel, plannerSentinel);
  assert.equal(result.workerModel, workerSentinel);
});

test("resolveDeepseekModels disables compressed DeepSeek responses", () => {
  let seenOptions;
  const createProvider = (options) => {
    seenOptions = options;
    return () => ({ kind: "model" });
  };

  resolveDeepseekModels({
    apiKey: "secret",
    baseURL: "https://api.deepseek.com/v1",
    modelId: "deepseek-v4-pro",
    createProvider,
  });

  assert.deepEqual(seenOptions.headers, {
    "accept-encoding": "identity",
  });
});
