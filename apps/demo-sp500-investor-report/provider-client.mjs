import { createDeepSeek } from "@ai-sdk/deepseek";

export function resolveDeepseekModel({
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
  return provider(modelId);
}
