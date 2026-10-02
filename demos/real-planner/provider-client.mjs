import { createDeepSeek } from "@ai-sdk/deepseek";

export function resolveDeepseekModels({
  apiKey,
  baseURL,
  modelId,
  createProvider = createDeepSeek,
}) {
  const provider = createProvider({
    apiKey,
    baseURL,
    headers: { "accept-encoding": "identity" },
  });
  return {
    plannerModel: provider(modelId),
    workerModel: provider(modelId),
  };
}
