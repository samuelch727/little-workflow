import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import { withModelRetry } from "./model-retry";

const here = dirname(fileURLToPath(import.meta.url));

/** `demos/dreamer` — the demo root. */
export const demoRoot = resolve(here, "..", "..");

/**
 * Harness data dir. Absolute so the driver and the `little-harness` CLI agree.
 *
 * `DREAMER_DATA_DIR` overrides it. That is not a test-only affordance: the session store is
 * shared mutable state under the checkout, so two investigations running side by side (two
 * test files, two terminals, a CI matrix) otherwise write into — and clean up — each other's
 * sessions.
 */
export const dataDir = process.env.DREAMER_DATA_DIR ?? join(demoRoot, ".little-harness");

function envCandidates(): string[] {
  const explicit = process.env.DREAMER_ENV_FILE;
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
 * Merge credentials from the nearest `.env.local` files. A real environment variable always
 * wins; a nearer file wins over a further one. Values are never logged. Same loader chain as
 * `demos/kb-chatbot`, so one repo-root `.env.local` serves both demos.
 */
export function loadDreamerEnv(candidates: readonly string[] = envCandidates()): { paths: string[] } {
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

/** The model slot the dreamer runs on by default. */
export const DEFAULT_MODEL_SLOT = "deepseek-v4-flash";

/**
 * The test seam for the model.
 *
 * It has to live on `globalThis` (not in a module-level `let`): `little-harness`'s
 * `importDefault` builds a NEW jiti instance per module, so `agent.ts`, each `tools/*.ts`
 * and each `workflows/*.ts` get their OWN copy of this module. `Symbol.for` is the one
 * registry all of those copies — and a plain `import` from a vitest file — actually share.
 *
 * The workflow modules resolve their model at import time (a `defineWorkflow` captures it),
 * which is also the moment `discoverWorkflows` loads them. Without this seam, loading the
 * agent folder at all would require a live DeepSeek key.
 */
const MODEL_OVERRIDE = Symbol.for("dreamer.model-override");

type ModelHolder = { [MODEL_OVERRIDE]?: LanguageModel };

/** Install (or, with `undefined`, remove) the process-wide model override. Tests only. */
export function setDreamerModel(model: LanguageModel | undefined): void {
  const holder = globalThis as unknown as ModelHolder;
  if (model === undefined) {
    delete holder[MODEL_OVERRIDE];
    return;
  }
  holder[MODEL_OVERRIDE] = model;
}

export function dreamerModelOverride(): LanguageModel | undefined {
  return (globalThis as unknown as ModelHolder)[MODEL_OVERRIDE];
}

/**
 * The model the dreamer and its template workflows run on.
 *
 * Everything model-shaped in this demo comes through here — `agent.ts` for the dreamer's
 * own turns, and each `workflows/*.ts` at module level for its `ai.generate` steps — so
 * this is the one place a cross-cutting model concern can be applied once.
 *
 * The retry wrapper is applied to the OVERRIDE as well as to the real provider. It is
 * transparent to a model that never throws a transport error, so the mock seam is unchanged
 * in every existing test; wrapping both branches is what lets a hermetic test prove the
 * wrapper is actually in this path rather than merely present in the tree.
 */
export function dreamerModel(): LanguageModel {
  return withModelRetry(baseDreamerModel());
}

/**
 * `deepseek-v4-flash` by default. The retired `deepseek-chat` id errors at the provider, so
 * the demo pins a live catalog id rather than the provider's own default.
 */
function baseDreamerModel(): LanguageModel {
  const override = dreamerModelOverride();
  if (override !== undefined) return override;

  loadDreamerEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      `Set DEEPSEEK_API_KEY in the environment or in one of: ${envCandidates().join(", ")}.`,
    );
  }
  const provider = createDeepSeek({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    headers: { "accept-encoding": "identity" },
  });
  return provider(process.env.DREAMER_MODEL_SLOT ?? DEFAULT_MODEL_SLOT);
}

/** The littleDB control plane. The evidence pack, the run store and proposals all hang off it. */
export function controlPlaneUrl(): string {
  loadDreamerEnv();
  return process.env.DREAMER_CONTROL_PLANE_URL ?? process.env.LITTLEDB_URL ?? "http://localhost:3000";
}

/**
 * Fallback engine URL. The evidence pack carries the authoritative `engineUrl`, and
 * `littledb-api.ts` prefers that once a pack has been fetched; this is only what
 * `littledb_load_run` uses if it is somehow called first.
 */
export function fallbackEngineUrl(): string {
  loadDreamerEnv();
  return process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";
}

/** The harness under investigation, when the driver (or the environment) named one. */
export function defaultHarnessSlug(): string | undefined {
  loadDreamerEnv();
  const slug = process.env.DREAMER_HARNESS ?? process.env.LITTLEDB_HARNESS_ID;
  return slug === undefined || slug.length === 0 ? undefined : slug;
}

/** `--dry-run`: build the proposal body, print it, submit nothing. */
export function isDryRun(): boolean {
  return process.env.DREAMER_DRY_RUN === "1";
}

/** Optional project key header, mirroring how kb-chatbot talks to the control plane. */
export function projectKey(): string | undefined {
  loadDreamerEnv();
  const key = process.env.LITTLEDB_PROJECT_KEY;
  return key === undefined || key.length === 0 ? undefined : key;
}
