import { canonicalJson, sha256Digest } from "./canonical.js";

export type WorkflowVersionReusePolicy = "never" | "exact" | "structure" | "any";

export const DEFAULT_WORKFLOW_VERSION_REUSE_POLICY: WorkflowVersionReusePolicy = "never";

export type WorkflowVersionReuseStrategy = "planner_reviewed" | "always_fresh";

export const DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY: WorkflowVersionReuseStrategy =
  "planner_reviewed";

export function resolveWorkflowVersionReuseStrategy(options: {
  readonly call?: WorkflowVersionReuseStrategy;
  readonly workflow?: WorkflowVersionReuseStrategy;
} = {}): WorkflowVersionReuseStrategy {
  return options.call ?? options.workflow ?? DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY;
}

export type ConcreteInputStructure =
  | { readonly kind: "null" }
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | {
      readonly kind: "array";
      readonly length: "empty" | "single" | "many";
      readonly elements: readonly ConcreteInputStructure[];
    }
  | {
      readonly kind: "object";
      readonly fields: readonly (readonly [string, ConcreteInputStructure])[];
    };

export type AdaptiveArrayPath = {
  readonly path: readonly string[];
  readonly maxBranches: number;
};

export function resolveWorkflowVersionReusePolicy(options: {
  readonly call?: WorkflowVersionReusePolicy;
  readonly workflow?: WorkflowVersionReusePolicy;
} = {}): WorkflowVersionReusePolicy {
  return options.call ?? options.workflow ?? DEFAULT_WORKFLOW_VERSION_REUSE_POLICY;
}

export function concreteInputStructure(value: unknown): ConcreteInputStructure {
  if (value === null) {
    return { kind: "null" };
  }
  switch (typeof value) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "object":
      if (Array.isArray(value)) {
        return {
          kind: "array",
          length: arrayLengthCategory(value.length),
          elements: uniqueStructures(value.map((entry) => concreteInputStructure(entry))),
        };
      }
      return {
        kind: "object",
        fields: Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([key, entry]) => [key, concreteInputStructure(entry)] as const),
      };
    default:
      return { kind: "null" };
  }
}

export function concreteInputStructureHash(value: unknown): string {
  return sha256Digest(concreteInputStructure(value));
}

export function assertWorkflowVersionInputCompatible(options: {
  readonly policy: WorkflowVersionReusePolicy;
  readonly plannedInputHash: string;
  readonly plannedInputStructure?: ConcreteInputStructure;
  readonly plannedInputStructureHash: string;
  readonly runInput: unknown;
  readonly adaptiveArrayPaths?: readonly AdaptiveArrayPath[];
}): void {
  switch (options.policy) {
    case "never":
      throw new Error("WorkflowVersion reuse is disabled.");
    case "exact":
      if (sha256Digest(options.runInput) !== options.plannedInputHash) {
        throw new Error("WorkflowVersion planned input hash does not match run input.");
      }
      return;
    case "structure":
      if (!isStructureReuseCompatible(options)) {
        throw new Error("WorkflowVersion planned input structure does not match run input.");
      }
      return;
    case "any":
      return;
    default:
      throw new Error(`Unknown WorkflowVersion reuse policy "${String(options.policy)}".`);
  }
}

function isStructureReuseCompatible(options: {
  readonly plannedInputStructure?: ConcreteInputStructure;
  readonly plannedInputStructureHash: string;
  readonly runInput: unknown;
  readonly adaptiveArrayPaths?: readonly AdaptiveArrayPath[];
}): boolean {
  const runInputStructure = concreteInputStructure(options.runInput);
  if (!options.adaptiveArrayPaths || options.adaptiveArrayPaths.length === 0) {
    return sha256Digest(runInputStructure) === options.plannedInputStructureHash;
  }
  if (!options.plannedInputStructure) {
    return false;
  }
  return structuresCompatibleAtPath({
    planned: options.plannedInputStructure,
    run: runInputStructure,
    runInput: options.runInput,
    adaptiveArrayPaths: options.adaptiveArrayPaths,
    path: [],
  });
}

function structuresCompatibleAtPath(options: {
  readonly planned: ConcreteInputStructure;
  readonly run: ConcreteInputStructure;
  readonly runInput: unknown;
  readonly adaptiveArrayPaths: readonly AdaptiveArrayPath[];
  readonly path: readonly string[];
}): boolean {
  if (options.planned.kind !== options.run.kind) {
    return false;
  }
  switch (options.planned.kind) {
    case "null":
    case "string":
    case "number":
    case "boolean":
      return true;
    case "array": {
      if (options.run.kind !== "array") {
        return false;
      }
      const adaptiveMaxBranches = strictestAdaptiveMaxBranches(options.path, options.adaptiveArrayPaths);
      if (adaptiveMaxBranches !== undefined) {
        const runCount = arrayValueLengthAtPath(options.runInput, options.path);
        return runCount !== undefined
          && runCount <= adaptiveMaxBranches
          && structuresEqual(options.planned.elements, options.run.elements);
      }
      return options.planned.length === options.run.length
        && structuresEqual(options.planned.elements, options.run.elements);
    }
    case "object":
      if (options.run.kind !== "object" || options.planned.fields.length !== options.run.fields.length) {
        return false;
      }
      return options.planned.fields.every(([plannedKey, plannedField], index) => {
        const runField = options.run.kind === "object" ? options.run.fields[index] : undefined;
        return runField !== undefined
          && plannedKey === runField[0]
          && structuresCompatibleAtPath({
            planned: plannedField,
            run: runField[1],
            runInput: options.runInput,
            adaptiveArrayPaths: options.adaptiveArrayPaths,
            path: [...options.path, plannedKey],
          });
      });
  }
}

function arrayLengthCategory(length: number): "empty" | "single" | "many" {
  if (length === 0) {
    return "empty";
  }
  return length === 1 ? "single" : "many";
}

function strictestAdaptiveMaxBranches(
  path: readonly string[],
  adaptiveArrayPaths: readonly AdaptiveArrayPath[],
): number | undefined {
  let maxBranches: number | undefined;
  for (const entry of adaptiveArrayPaths) {
    if (pathsEqual(entry.path, path)) {
      maxBranches = maxBranches === undefined
        ? entry.maxBranches
        : Math.min(maxBranches, entry.maxBranches);
    }
  }
  return maxBranches;
}

function arrayValueLengthAtPath(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return Array.isArray(current) ? current.length : undefined;
}

function structuresEqual(
  left: readonly ConcreteInputStructure[] | ConcreteInputStructure,
  right: readonly ConcreteInputStructure[] | ConcreteInputStructure,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function uniqueStructures(
  structures: readonly ConcreteInputStructure[],
): readonly ConcreteInputStructure[] {
  const byCanonical = new Map<string, ConcreteInputStructure>();
  for (const structure of structures) {
    byCanonical.set(canonicalJson(structure), structure);
  }
  return [...byCanonical.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, structure]) => structure);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
