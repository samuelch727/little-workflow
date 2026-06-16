import type { JsonObject } from "../types.js";

export type ModelRequestSettingsSource = {
  temperature?: unknown;
  activeTools?: unknown;
  toolChoice?: unknown;
};

type JsonSafeValue =
  | null
  | string
  | number
  | boolean
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

export function modelRequestSettings(
  options: ModelRequestSettingsSource,
  event?: unknown,
): JsonObject | undefined {
  const out: JsonObject = {};
  const eventTemperature = eventField(event, "temperature");
  const temperature = typeof eventTemperature.value === "number" ? eventTemperature.value : options.temperature;
  if (typeof temperature === "number") {
    out.temperature = temperature;
  }

  const activeToolsField = eventField(event, "activeTools");
  const activeTools = normalizedActiveTools(
    activeToolsField.hasOwn ? activeToolsField.value : options.activeTools,
  );
  if (activeTools !== undefined) {
    out.activeTools = activeTools;
  }

  const toolChoiceField = eventField(event, "toolChoice");
  const toolChoiceValue =
    toolChoiceField.hasOwn &&
      (options.toolChoice !== undefined || !isAutoToolChoice(toolChoiceField.value))
      ? toolChoiceField.value
      : options.toolChoice;
  const toolChoice = jsonSafeToolChoice(toolChoiceValue);
  if (toolChoice !== undefined) {
    out.toolChoice = toolChoice;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function eventField(event: unknown, key: string): { hasOwn: boolean; value: unknown } {
  if (!isObject(event) || !Object.hasOwn(event, key)) {
    return { hasOwn: false, value: undefined };
  }
  return { hasOwn: true, value: event[key] };
}

function normalizedActiveTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [...new Set(value.filter((name): name is string => typeof name === "string"))].sort();
}

function jsonSafeToolChoice(toolChoice: unknown): JsonSafeValue | undefined {
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  if (
    isObject(toolChoice) &&
    toolChoice.type === "tool" &&
    typeof toolChoice.toolName === "string"
  ) {
    return { type: "tool", toolName: toolChoice.toolName };
  }
  const commonToolChoice = commonObjectToolChoice(toolChoice);
  if (commonToolChoice !== undefined) {
    return commonToolChoice;
  }
  return jsonSafeValue(toolChoice);
}

function isAutoToolChoice(toolChoice: unknown): boolean {
  return toolChoice === "auto" || (isObject(toolChoice) && toolChoice.type === "auto");
}

function commonObjectToolChoice(toolChoice: unknown): "auto" | "none" | "required" | undefined {
  if (!isObject(toolChoice)) {
    return undefined;
  }
  return toolChoice.type === "auto" || toolChoice.type === "none" || toolChoice.type === "required"
    ? toolChoice.type
    : undefined;
}

function jsonSafeValue(value: unknown): JsonSafeValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const out: JsonSafeValue[] = [];
    for (const item of value) {
      const safe = jsonSafeValue(item);
      if (safe === undefined) {
        return undefined;
      }
      out.push(safe);
    }
    return out;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: { [key: string]: JsonSafeValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const safe = jsonSafeValue(item);
    if (safe === undefined) {
      return undefined;
    }
    out[key] = safe;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
