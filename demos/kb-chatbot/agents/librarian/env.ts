import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";

const here = dirname(fileURLToPath(import.meta.url));

/** `demos/kb-chatbot` — the demo root, and the harness `projectRoot`. */
export const demoRoot = resolve(here, "..", "..");

/** Tracked seed copied into the live knowledge base on first run. */
export const seedKnowledgeDir = join(demoRoot, "seed-knowledge");

/**
 * The LIVE knowledge base: the one static `sourceDir` every thread shares. Deliberately
 * gitignored — the demo writes into it, so a tracked directory would make every run dirty
 * the working tree and make step 3 of the driver pass for the wrong reason on a re-run.
 */
export const knowledgeDir = join(demoRoot, "knowledge");

/** Harness data dir. Absolute so the driver and `little-harness outcomes` agree. */
export const dataDir = join(demoRoot, ".little-harness");

function envCandidates(): string[] {
  const explicit = process.env.KB_CHATBOT_ENV_FILE;
  return [
    ...(explicit === undefined || explicit.length === 0 ? [] : [explicit]),
    join(demoRoot, ".env.local"),
    resolve(demoRoot, "..", "..", ".env.local"),
    resolve(demoRoot, "..", "..", "..", "..", ".env.local"),
  ];
}

function parseEnvLine(line: string): readonly [string, string] | undefined {
  const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match === null) return undefined;
  const [, key, rawValue] = match;
  if (key === undefined || rawValue === undefined) return undefined;
  return [key, rawValue.trim().replace(/^["']|["']$/g, "")] as const;
}

/**
 * Merge DeepSeek credentials from the nearest `.env.local` files. A real environment
 * variable always wins; a nearer file wins over a further one. Values are never logged.
 */
export function loadKbEnv(candidates: readonly string[] = envCandidates()): { paths: string[] } {
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    paths.push(candidate);
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const parsed = parseEnvLine(line);
      if (parsed === undefined) continue;
      const [key, value] = parsed;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  }
  return { paths };
}

/**
 * The model slot name the littleDB managed config resolves against. littleDB stores a
 * SLOT (`ConfigBundle.modelSlot`), and `modelFor` maps it back to a provider instance;
 * a promoted config naming a slot this map does not know throws at session creation.
 */
export const DEFAULT_MODEL_SLOT = "deepseek-v4-flash";

/**
 * `deepseek-v4-flash` by default. The retired `deepseek-chat` id errors at the provider,
 * so the demo pins a live catalog id rather than the provider's own default.
 */
export function modelForSlot(slot: string): LanguageModel | undefined {
  loadKbEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      `Set DEEPSEEK_API_KEY in the environment or in one of: ${envCandidates().join(", ")}.`,
    );
  }
  const known = new Set([DEFAULT_MODEL_SLOT, "deepseek-v4-pro"]);
  if (!known.has(slot)) return undefined;
  const provider = createDeepSeek({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    headers: { "accept-encoding": "identity" },
  });
  return provider(slot);
}

/** The model the demo runs on when littleDB is not in the loop. */
export function librarianModel(): LanguageModel {
  const slot = process.env.KB_CHATBOT_MODEL_SLOT ?? DEFAULT_MODEL_SLOT;
  const model = modelForSlot(slot);
  if (model === undefined) throw new Error(`Unknown model slot "${slot}".`);
  return model;
}
