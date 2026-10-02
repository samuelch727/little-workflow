import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeek } from "@ai-sdk/deepseek";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const worktreeRoot = resolve(appRoot, "..", "..");
const mainRepoRoot = resolve(appRoot, "..", "..", "..", "..");

export type LoadedSupportEnv = {
  loaded: boolean;
  /** Candidate `.env.local` files that existed and were merged, in nearest-first order. */
  paths: string[];
  /** Keys this call injected into `process.env`. Never their (secret) values. */
  keys: string[];
};

export type SupportModelConfig = {
  apiKey: string;
  baseURL: string;
  modelId: string;
};

function defaultEnvCandidates(): string[] {
  const explicit = process.env.SUPPORT_COMMAND_CENTER_ENV_FILE;
  return [
    ...(explicit === undefined || explicit.length === 0 ? [] : [explicit]),
    join(appRoot, ".env.local"),
    join(worktreeRoot, ".env.local"),
    join(mainRepoRoot, ".env.local"),
  ];
}

function parseEnvLine(line: string): readonly [string, string] | undefined {
  // Accepts `KEY=value` and shell-style `export KEY=value` (the `export` prefix is ignored).
  const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match === null) return undefined;
  const [, key, rawValue] = match;
  if (key === undefined || rawValue === undefined) return undefined;
  const value = rawValue.trim();
  return [key, value.replace(/^["']|["']$/g, "")] as const;
}

/**
 * Merges DeepSeek credentials from every candidate `.env.local` file, so a key living only in the
 * repo-root file is picked up even when a nearer file exists (holding, say, only `DISCORD_*`).
 *
 * Precedence (highest wins):
 *   1. `process.env` — a real environment variable is NEVER overwritten by a file.
 *   2. Nearest file — candidates are consulted nearest-first (an explicit
 *      `SUPPORT_COMMAND_CENTER_ENV_FILE`, then the app dir, then the worktree root, then the main
 *      repo checkout root); the FIRST file to define a key wins and later files only fill gaps.
 *
 * Because each applied key is written straight into `process.env`, both rules fall out of a single
 * "skip if already set" check. Secret VALUES are never returned or logged — only KEY names / PATHS.
 */
export function loadSupportEnv(candidates: readonly string[] = defaultEnvCandidates()): LoadedSupportEnv {
  const keys: string[] = [];
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    paths.push(candidate);
    const text = readFileSync(candidate, "utf8");
    for (const line of text.split("\n")) {
      const parsed = parseEnvLine(line);
      if (parsed === undefined) continue;
      const [key, value] = parsed;
      // process.env wins, and a nearer file's key (already applied above) wins over this one.
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: paths.length > 0, paths, keys };
}

export function resolveSupportModelConfig(): SupportModelConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const consulted = defaultEnvCandidates().join(", ");
    throw new Error(
      `Set DEEPSEEK_API_KEY in the environment or add it to one of the merged .env.local files: ${consulted}.`,
    );
  }
  return {
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    modelId: process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-pro",
  };
}

export function getSupportModel() {
  loadSupportEnv();
  const config = resolveSupportModelConfig();
  const provider = createDeepSeek({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: { "accept-encoding": "identity" },
  });
  return provider(config.modelId);
}
