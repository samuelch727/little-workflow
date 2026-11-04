import type { ResolvedModel } from "./contract.js";

export type { ResolvedModel } from "./contract.js";

/**
 * The model LittleDB holds for a harness, turned into the model your app calls. A version names
 * its model as `provider/model` (`deepseek/deepseek-flash`); resolve answers it with who pays.
 * Your own key: the provider's package with the key from your environment, no fee. LittleDB
 * credits: the same package pointed at LittleDB's model gateway, which bills the project. A model
 * on your key with no key set fails with the key's name; it never falls back to credits.
 */

/** The content key a harness version names its model under. */
export const MODEL_KEY = "model";

/** `provider/model`: an id LittleDB runs. A bare name or a slot ("fast") is the app's own. */
export function isModelId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\/\S+$/i.test(value.trim());
}

/** The `provider/model` a version's content names, or undefined. */
export function modelOfContent(content: unknown): string | undefined {
  const model = content !== null && typeof content === "object" ? (content as Record<string, unknown>)[MODEL_KEY] : undefined;
  return typeof model === "string" && isModelId(model) ? model.trim().toLowerCase() : undefined;
}

/** The content without LittleDB's model: what your code reads. The same object when it names none. */
export function withoutModel<C>(content: C): C {
  if (modelOfContent(content) === undefined) return content;
  const { [MODEL_KEY]: _model, ...rest } = content as Record<string, unknown>;
  return rest as C;
}

/** The secret each provider's own key goes in (AI SDK's names). */
export const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
};

/** An AI SDK provider factory, such as `createDeepSeek` from `@ai-sdk/deepseek`. */
export type ModelProvider<M> = (settings: { apiKey?: string; baseURL?: string; fetch?: typeof globalThis.fetch }) => (modelId: string) => M;

export type ModelResolverOptions<M> = {
  /** The provider packages your app has, by the provider part of the id: `{ deepseek: createDeepSeek }`. */
  readonly providers: Readonly<Record<string, ModelProvider<M>>>;
  /** Where your own keys are: an object such as `process.env`, or a lookup. Default `process.env`. */
  readonly keys?: Readonly<Record<string, string | undefined>> | ((name: string) => string | undefined) | undefined;
  /**
   * LittleDB's model gateway, for models paid with credits: `{ baseURL, apiKey }` with the
   * project's `ldbak_` key, or a `fetch` that reaches it (a managed agent's binding).
   */
  readonly credits?: { readonly baseURL: string; readonly apiKey?: string | undefined; readonly fetch?: typeof globalThis.fetch | undefined } | undefined;
};

/** Why a model LittleDB named can't be called here; the message says what to set. */
export class ModelUnavailableError extends Error {
  readonly model: string;
  constructor(model: string, message: string) {
    super(message);
    this.name = "ModelUnavailableError";
    this.model = model;
  }
}

/**
 * Turn LittleDB's model into a model object, made once per id and payer. `managedHarness({
 * resolveModel })` and LittleDB's managed runtime call it on every turn.
 */
export function createModelResolver<M>(options: ModelResolverOptions<M>): (model: ResolvedModel) => M {
  const made = new Map<string, M>();
  const keyOf = (name: string): string | undefined => {
    const keys = options.keys ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const value = typeof keys === "function" ? keys(name) : keys[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  return (model) => {
    const cacheKey = `${model.paidBy}\u0000${model.id}`;
    const hit = made.get(cacheKey);
    if (hit !== undefined) return hit;
    const slash = model.id.indexOf("/");
    if (slash <= 0) throw new ModelUnavailableError(model.id, `LittleDB named the model "${model.id}", which is not a provider/model id.`);
    const provider = model.id.slice(0, slash);
    const name = model.id.slice(slash + 1);
    const factory = options.providers[provider];
    if (factory === undefined) {
      throw new ModelUnavailableError(model.id, `LittleDB runs ${model.id}, but this app has no "${provider}" provider. Add it to providers.`);
    }
    let created: M;
    if (model.paidBy === "credits") {
      const credits = options.credits;
      if (credits === undefined) {
        throw new ModelUnavailableError(model.id, `${model.id} is paid with LittleDB credits, but this app has no model gateway configured (credits).`);
      }
      created = factory({
        baseURL: `${credits.baseURL.replace(/\/+$/, "")}/${provider}`,
        // The gateway knows the project from the binding or the key; a provider needs some key to send.
        apiKey: credits.apiKey ?? "littledb-credits",
        ...(credits.fetch === undefined ? {} : { fetch: credits.fetch }),
      })(name);
    } else {
      const keyName = PROVIDER_KEYS[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      const apiKey = keyOf(keyName);
      if (apiKey === undefined) {
        throw new ModelUnavailableError(
          model.id,
          `${model.id} is paid with your own key, but ${keyName} is not set. Set it, or pay for it with LittleDB credits (Settings, Agent models).`,
        );
      }
      created = factory({ apiKey })(name);
    }
    made.set(cacheKey, created);
    return created;
  };
}
