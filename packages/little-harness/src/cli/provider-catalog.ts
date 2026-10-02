export type ProviderId =
  | "gateway"
  | "vercel"
  | "openai"
  | "azure"
  | "anthropic"
  | "open-responses"
  | "bedrock"
  | "groq"
  | "deepinfra"
  | "google"
  | "google-vertex"
  | "xai"
  | "mistral"
  | "togetherai"
  | "cohere"
  | "fireworks"
  | "deepseek"
  | "moonshotai"
  | "alibaba"
  | "cerebras"
  | "perplexity"
  | "baseten"
  | "huggingface"
  | "openai-compatible";

export type ProviderDefinition = {
  id: ProviderId;
  name: string;
  packageName?: string;
  /**
   * The semver range scaffolds pin `packageName` to: the provider major built for the AI SDK
   * major this package peers on. Never `latest` — a provider's next major targets the next
   * AI SDK major and would install a model the harness cannot run.
   */
  packageVersion?: string;
  importModule: string;
  exportName: string;
  apiKeyEnvVar: string;
  envVars?: string[];
  optionalEnvVars?: string[];
  defaultModel: string;
  models: string[];
  renderMode?: "default" | "openai-compatible" | "open-responses";
};

export type Choice<T extends string = string> = {
  name: string;
  value: T;
  description?: string;
};

export const CUSTOM_MODEL_CHOICE = "__custom_model__";

const PROVIDERS: ProviderDefinition[] = [
  {
    id: "gateway",
    name: "Vercel AI Gateway",
    importModule: "ai",
    exportName: "gateway",
    apiKeyEnvVar: "AI_GATEWAY_API_KEY",
    defaultModel: "openai/gpt-5.2",
    models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6", "google/gemini-3-pro-preview"],
  },
  {
    id: "vercel",
    name: "Vercel",
    packageName: "@ai-sdk/vercel",
    packageVersion: "^3.0.30",
    importModule: "@ai-sdk/vercel",
    exportName: "vercel",
    apiKeyEnvVar: "VERCEL_API_KEY",
    defaultModel: "v0-1.0-md",
    models: ["v0-1.0-md"],
  },
  {
    id: "openai",
    name: "OpenAI",
    packageName: "@ai-sdk/openai",
    packageVersion: "^4.0.83",
    importModule: "@ai-sdk/openai",
    exportName: "openai",
    apiKeyEnvVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5.2",
    models: ["gpt-5.2-pro", "gpt-5.2", "gpt-5.1", "gpt-5.1-codex", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    packageName: "@ai-sdk/azure",
    packageVersion: "^4.0.89",
    importModule: "@ai-sdk/azure",
    exportName: "azure",
    apiKeyEnvVar: "AZURE_API_KEY",
    envVars: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"],
    defaultModel: "your-deployment-name",
    models: ["your-deployment-name", "gpt-5.2", "gpt-4.1"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    packageName: "@ai-sdk/anthropic",
    packageVersion: "^4.0.71",
    importModule: "@ai-sdk/anthropic",
    exportName: "anthropic",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-4-6",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "open-responses",
    name: "Open Responses",
    packageName: "@ai-sdk/open-responses",
    packageVersion: "^2.0.58",
    importModule: "@ai-sdk/open-responses",
    exportName: "openResponses",
    apiKeyEnvVar: "OPEN_RESPONSES_API_KEY",
    envVars: ["OPEN_RESPONSES_URL"],
    optionalEnvVars: ["OPEN_RESPONSES_API_KEY"],
    defaultModel: "mistralai/ministral-3-14b-reasoning",
    models: ["mistralai/ministral-3-14b-reasoning", "model-id"],
    renderMode: "open-responses",
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    packageName: "@ai-sdk/amazon-bedrock",
    packageVersion: "^5.0.104",
    importModule: "@ai-sdk/amazon-bedrock",
    exportName: "bedrock",
    apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    defaultModel: "anthropic.claude-3-haiku-20240307-v1:0",
    models: ["anthropic.claude-3-haiku-20240307-v1:0", "meta.llama3-70b-instruct-v1:0"],
  },
  {
    id: "groq",
    name: "Groq",
    packageName: "@ai-sdk/groq",
    packageVersion: "^4.0.54",
    importModule: "@ai-sdk/groq",
    exportName: "groq",
    apiKeyEnvVar: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "llama-3.3-70b-versatile",
      "deepseek-r1-distill-llama-70b",
      "qwen-qwq-32b",
      "openai/gpt-oss-120b",
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    packageName: "@ai-sdk/deepinfra",
    packageVersion: "^3.0.62",
    importModule: "@ai-sdk/deepinfra",
    exportName: "deepinfra",
    apiKeyEnvVar: "DEEPINFRA_API_KEY",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      "meta-llama/Llama-3.3-70B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/QwQ-32B",
    ],
  },
  {
    id: "google",
    name: "Google Generative AI",
    packageName: "@ai-sdk/google",
    packageVersion: "^4.0.87",
    importModule: "@ai-sdk/google",
    exportName: "google",
    apiKeyEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaultModel: "gemini-3.1-pro-preview",
    models: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    packageName: "@ai-sdk/google-vertex",
    packageVersion: "^5.0.101",
    importModule: "@ai-sdk/google-vertex",
    exportName: "vertex",
    apiKeyEnvVar: "GOOGLE_APPLICATION_CREDENTIALS",
    envVars: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
    defaultModel: "gemini-3.1-pro-preview",
    models: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "xai",
    name: "xAI",
    packageName: "@ai-sdk/xai",
    packageVersion: "^5.0.14",
    importModule: "@ai-sdk/xai",
    exportName: "xai",
    apiKeyEnvVar: "XAI_API_KEY",
    defaultModel: "grok-4-fast-reasoning",
    models: ["grok-4-fast-reasoning", "grok-4", "grok-3", "grok-3-mini"],
  },
  {
    id: "mistral",
    name: "Mistral",
    packageName: "@ai-sdk/mistral",
    packageVersion: "^4.0.56",
    importModule: "@ai-sdk/mistral",
    exportName: "mistral",
    apiKeyEnvVar: "MISTRAL_API_KEY",
    defaultModel: "mistral-large-latest",
    models: [
      "pixtral-large-latest",
      "mistral-large-latest",
      "magistral-medium-2506",
      "magistral-small-2506",
      "mistral-small-latest",
      "ministral-8b-latest",
    ],
  },
  {
    id: "togetherai",
    name: "Together.ai",
    packageName: "@ai-sdk/togetherai",
    packageVersion: "^3.0.63",
    importModule: "@ai-sdk/togetherai",
    exportName: "togetherai",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    defaultModel: "meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo",
    models: [
      "meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
      "mistralai/Mixtral-8x22B-Instruct-v0.1",
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    packageName: "@ai-sdk/cohere",
    packageVersion: "^4.0.54",
    importModule: "@ai-sdk/cohere",
    exportName: "cohere",
    apiKeyEnvVar: "COHERE_API_KEY",
    defaultModel: "command-a-03-2025",
    models: ["command-a-03-2025", "command-a-reasoning-08-2025", "command-r-plus", "command-r"],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    packageName: "@ai-sdk/fireworks",
    packageVersion: "^3.0.65",
    importModule: "@ai-sdk/fireworks",
    exportName: "fireworks",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
    defaultModel: "accounts/fireworks/models/deepseek-r1",
    models: [
      "accounts/fireworks/models/deepseek-r1",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/qwen2-vl-72b-instruct",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    packageName: "@ai-sdk/deepseek",
    packageVersion: "^3.0.58",
    importModule: "@ai-sdk/deepseek",
    exportName: "deepseek",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    // deepseek-chat / deepseek-reasoner were fully retired 2026-07-24
    // (api-docs.deepseek.com/news/news260424) — scaffolding them produces a
    // provider error at call time. The v4 ids are the current line.
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    packageName: "@ai-sdk/moonshotai",
    packageVersion: "^3.0.62",
    importModule: "@ai-sdk/moonshotai",
    exportName: "moonshotai",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.5",
    models: ["kimi-k2.5", "kimi-k2-thinking"],
  },
  {
    id: "alibaba",
    name: "Alibaba",
    packageName: "@ai-sdk/alibaba",
    packageVersion: "^2.0.60",
    importModule: "@ai-sdk/alibaba",
    exportName: "alibaba",
    apiKeyEnvVar: "ALIBABA_API_KEY",
    defaultModel: "qwen-plus",
    models: ["qwen3-max", "qwen-plus"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    packageName: "@ai-sdk/cerebras",
    packageVersion: "^3.0.62",
    importModule: "@ai-sdk/cerebras",
    exportName: "cerebras",
    apiKeyEnvVar: "CEREBRAS_API_KEY",
    defaultModel: "gpt-oss-120b",
    models: ["llama3.3-70b", "gpt-oss-120b", "qwen-3-32b"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    packageName: "@ai-sdk/perplexity",
    packageVersion: "^5.0.5",
    importModule: "@ai-sdk/perplexity",
    exportName: "perplexity",
    apiKeyEnvVar: "PERPLEXITY_API_KEY",
    defaultModel: "sonar-pro",
    models: ["sonar-pro", "sonar"],
  },
  {
    id: "baseten",
    name: "Baseten",
    packageName: "@ai-sdk/baseten",
    packageVersion: "^2.1.40",
    importModule: "@ai-sdk/baseten",
    exportName: "baseten",
    apiKeyEnvVar: "BASETEN_API_KEY",
    defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    models: ["Qwen/Qwen3-235B-A22B-Instruct-2507", "deepseek-ai/DeepSeek-V3.1", "moonshotai/Kimi-K2-Instruct-0905"],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    packageName: "@ai-sdk/huggingface",
    packageVersion: "^2.0.62",
    importModule: "@ai-sdk/huggingface",
    exportName: "huggingface",
    apiKeyEnvVar: "HUGGINGFACE_API_KEY",
    defaultModel: "meta-llama/Llama-3.1-8B-Instruct",
    models: ["meta-llama/Llama-3.1-8B-Instruct", "moonshotai/Kimi-K2-Instruct"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible API",
    packageName: "@ai-sdk/openai-compatible",
    packageVersion: "^3.0.62",
    importModule: "@ai-sdk/openai-compatible",
    exportName: "openaiCompatible",
    apiKeyEnvVar: "OPENAI_COMPATIBLE_API_KEY",
    envVars: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"],
    defaultModel: "model-id",
    models: ["model-id", "custom-model-id"],
    renderMode: "openai-compatible",
  },
];

export function providerChoices(): Choice<ProviderId>[] {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    value: provider.id,
    description: provider.packageName ?? "Uses the gateway provider exported by ai",
  }));
}

export function modelChoices(providerId: string): Choice[] {
  const provider = resolveProvider(providerId);
  return [
    ...provider.models.map((model) => ({ name: model, value: model })),
    {
      name: "Custom model id",
      value: CUSTOM_MODEL_CHOICE,
      description: "Type any model id accepted by this AI SDK provider",
    },
  ];
}

export function allProviders(): ProviderDefinition[] {
  return [...PROVIDERS];
}

export function providerEnvVars(provider: ProviderDefinition): string[] {
  return [...(provider.envVars ?? [provider.apiKeyEnvVar])];
}

export function resolveProvider(providerId: string): ProviderDefinition {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (provider === undefined) {
    const available = PROVIDERS.map((item) => item.id).join(", ");
    throw new Error(`Unknown provider '${providerId}'. Available providers: ${available}`);
  }
  return provider;
}

export function resolveModelChoice(providerId: string, modelId: string | undefined): string {
  const provider = resolveProvider(providerId);
  if (modelId === CUSTOM_MODEL_CHOICE) {
    throw new Error("Custom model id requires a model value.");
  }
  return modelId?.trim() || provider.defaultModel;
}

export function renderAgentSource(options: {
  provider: string;
  model?: string;
  system?: string;
}): string {
  const provider = resolveProvider(options.provider);
  const model = resolveModelChoice(provider.id, options.model);
  const system = options.system ?? "You are a helpful agent.";
  const optionalEnvVars = provider.optionalEnvVars ?? [];
  const installComment = provider.packageName === undefined
    ? "Uses the AI SDK gateway provider and an AI_GATEWAY_API_KEY in your environment."
    : `Requires the ${provider.packageName} provider and ${providerEnvVars(provider).join(", ")} in your environment.${
      optionalEnvVars.length === 0 ? "" : ` Optional: set ${optionalEnvVars.join(", ")} if your endpoint requires authentication.`
    }`;

  if (provider.renderMode === "openai-compatible") {
    return `import { createHarness, localHost } from "little-harness";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
if (!baseURL) {
  throw new Error("OPENAI_COMPATIBLE_BASE_URL is required for the OpenAI-compatible provider.");
}

// ${installComment}
const openaiCompatible = createOpenAICompatible({
  name: "openai-compatible",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  baseURL,
  includeUsage: true,
});

export default createHarness({
  model: openaiCompatible(${JSON.stringify(model)}),
  system: ${JSON.stringify(system)}, // or delete this and edit instructions.md
  host: localHost(),
});
`;
  }

  if (provider.renderMode === "open-responses") {
    return `import { createHarness, localHost } from "little-harness";
import { createOpenResponses } from "@ai-sdk/open-responses";

const url = process.env.OPEN_RESPONSES_URL;
if (!url) {
  throw new Error("OPEN_RESPONSES_URL is required for the Open Responses provider.");
}

// ${installComment}
const openResponses = createOpenResponses({
  name: "open-responses",
  url,
  apiKey: process.env.OPEN_RESPONSES_API_KEY,
});

export default createHarness({
  model: openResponses(${JSON.stringify(model)}),
  system: ${JSON.stringify(system)}, // or delete this and edit instructions.md
  host: localHost(),
});
`;
  }

  return `import { createHarness, localHost } from "little-harness";
import { ${provider.exportName} } from "${provider.importModule}";

// ${installComment}
export default createHarness({
  model: ${provider.exportName}(${JSON.stringify(model)}),
  system: ${JSON.stringify(system)}, // or delete this and edit instructions.md
  host: localHost(),
});
`;
}
