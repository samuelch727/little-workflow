import { asSchema, type FlexibleSchema, type Schema } from "ai";

export type RemoteToolContract<I = any, O = any, N extends string = string> = Readonly<{
  name: N;
  description: string;
  inputSchema: Schema<I>;
  outputSchema?: Schema<O>;
}>;

// Keep this boundary module independent of the Node runtime and tool implementations.
const RESERVED = new Set([
  "bash", "__proto__", "constructor", "prototype", "checkpoint",
  "start_agent_group", "spawn_agent", "watch_agent_group", "join_agent_group", "cancel_agent_group",
  "ask_person", "await_tasks", "run_ad_hoc_plan", "define_workflow",
]);

export function assertRemoteToolName(name: string): void {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(name) || RESERVED.has(name)) {
    throw new Error("Remote tool name is reserved or invalid.");
  }
}

function validatedSchema<T>(schema: FlexibleSchema<T>): Schema<T> {
  if (isObject(schema) && "~standard" in schema &&
    (!isObject(schema["~standard"]) || typeof schema["~standard"].validate !== "function")) {
    throw new Error("Remote tool Standard Schemas must carry a validator.");
  }
  const result = asSchema(schema);
  if (typeof result.validate !== "function") {
    throw new Error("Remote tool schemas must carry a validator (Standard Schema or jsonSchema with validate).");
  }
  return result;
}

/** A shared contract contains schemas and descriptions, never execute code or credentials. */
export function remoteTool<I, O = unknown, const N extends string = string>(options: {
  name: N;
  description: string;
  inputSchema: FlexibleSchema<I>;
  outputSchema?: FlexibleSchema<O>;
}): RemoteToolContract<I, O, N> {
  assertRemoteToolName(options.name);
  if (typeof options.description !== "string") throw new Error("Remote tool description must be a string.");
  return Object.freeze({
    name: options.name,
    description: options.description,
    inputSchema: validatedSchema(options.inputSchema),
    ...(options.outputSchema === undefined ? {} : { outputSchema: validatedSchema(options.outputSchema) }),
  });
}

export function uniqueContracts<T extends RemoteToolContract>(contracts: readonly T[]): Map<string, T> {
  const byName = new Map<string, T>();
  for (const contract of contracts) {
    // Recheck at both construction boundaries, including structurally supplied contracts.
    remoteTool(contract);
    if (byName.has(contract.name)) throw new Error("Duplicate remote tool name.");
    byName.set(contract.name, contract);
  }
  return byName;
}

/** Only this deliberate, bounded error may cross the server-to-model boundary. */
export class RemoteToolError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    if (!validError({ message, ...(code === undefined ? {} : { code }) })) {
      throw new Error("RemoteToolError needs a message of 1–500 characters and a valid optional code.");
    }
    this.name = "RemoteToolError";
    if (code !== undefined) this.code = code;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validError(value: unknown): value is { message: string; code?: string } {
  return isObject(value) && Object.keys(value).every(key => key === "message" || key === "code") &&
    typeof value.message === "string" && value.message.length > 0 && value.message.length <= 500 &&
    (value.code === undefined || typeof value.code === "string" && /^[a-z0-9_.-]{1,64}$/u.test(value.code));
}
