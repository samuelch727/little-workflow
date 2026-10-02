import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import { demoRoot } from "./episode";
import { withModelRetry } from "./model-retry";

export { demoRoot };

/**
 * Harness data dir. Absolute so the driver and the `little-harness` CLI agree.
 *
 * `SUPPORT_DATA_DIR` overrides it. Not a test-only affordance: the session store is shared
 * mutable state under the checkout, so two experiment runs side by side (two terminals, two
 * test files, a CI matrix) would otherwise clean up each other's sessions.
 */
export const dataDir = process.env.SUPPORT_DATA_DIR ?? join(demoRoot, ".little-harness");

function envCandidates(): string[] {
  const explicit = process.env.SUPPORT_DESK_ENV_FILE;
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
 * `demos/kb-chatbot` and `demos/dreamer`, so one repo-root `.env.local` serves all three.
 */
export function loadSupportEnv(candidates: readonly string[] = envCandidates()): { paths: string[] } {
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
 * The model slot name littleDB's managed config resolves against. littleDB stores a SLOT
 * (`ConfigBundle.modelSlot`) and `modelFor` maps it back to a provider instance; a promoted
 * config naming a slot this map does not know throws at session creation.
 */
export const DEFAULT_MODEL_SLOT = "deepseek-v4-flash";

/**
 * The test seam for the model.
 *
 * It lives on `globalThis` rather than in a module-level `let` because `little-harness`'s
 * `importDefault` builds a NEW jiti instance per module: `agent.ts` and each `tools/*.ts`
 * get their own copy of this file, and `Symbol.for` is the one registry all of them — and a
 * plain `import` from a vitest file, and the driver's `--import` preload — actually share.
 */
const MODEL_OVERRIDE = Symbol.for("support-desk.model-override");

type ModelHolder = { [MODEL_OVERRIDE]?: LanguageModel };

/** Install (or, with `undefined`, remove) the process-wide model override. Tests only. */
export function setSupportModel(model: LanguageModel | undefined): void {
  const holder = globalThis as unknown as ModelHolder;
  if (model === undefined) {
    delete holder[MODEL_OVERRIDE];
    return;
  }
  holder[MODEL_OVERRIDE] = model;
}

export function supportModelOverride(): LanguageModel | undefined {
  return (globalThis as unknown as ModelHolder)[MODEL_OVERRIDE];
}

/**
 * Resolve a model for a littleDB model slot. `undefined` for a slot this demo does not know,
 * which is what makes a promoted config naming a strange slot fail loudly.
 */
export function modelForSlot(slot: string): LanguageModel | undefined {
  const override = supportModelOverride();
  if (override !== undefined) return withModelRetry(override);

  const known = new Set([DEFAULT_MODEL_SLOT, "deepseek-v4-pro"]);
  if (!known.has(slot)) return undefined;

  loadSupportEnv();
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
  return withModelRetry(provider(slot));
}

/**
 * The model the agent runs on when littleDB is not in the loop.
 *
 * The retry wrapper is applied to the OVERRIDE as well as to the real provider (see
 * `modelForSlot`). It is transparent to a model that never throws a transport error, so the
 * mock seam is unchanged in every test — and wrapping both branches is what lets a hermetic
 * test prove the wrapper is really in this path rather than merely present in the tree.
 */
export function supportModel(): LanguageModel {
  const slot = process.env.SUPPORT_MODEL_SLOT ?? DEFAULT_MODEL_SLOT;
  const model = modelForSlot(slot);
  if (model === undefined) throw new Error(`Unknown model slot "${slot}".`);
  return model;
}
