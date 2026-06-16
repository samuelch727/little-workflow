import { existsSync, readFileSync } from "node:fs";

export type ModelInfo = {
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly pricing: {
    readonly input: number;
    readonly output: number;
    readonly currency: "USD";
  };
  readonly contextWindow: number;
};

const MODEL_REGISTRY = readModelRegistry();

export function getModelInfoFor(providerId: string, modelId: string): ModelInfo | undefined {
  return MODEL_REGISTRY[`${providerId}/${modelId}`.toLowerCase()];
}

function readModelRegistry(): Readonly<Record<string, ModelInfo>> {
  for (const url of modelRegistryUrls()) {
    if (!existsSync(url)) {
      continue;
    }
    return JSON.parse(readFileSync(url, "utf8")) as Readonly<Record<string, ModelInfo>>;
  }
  throw new Error("Unable to locate model-registry.json.");
}

function modelRegistryUrls(): readonly URL[] {
  return [
    new URL("./model-registry.json", import.meta.url),
    new URL("../src/model-registry.json", import.meta.url),
  ];
}
