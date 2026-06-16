import { createHmac } from "node:crypto";
import { sha256Digest } from "./canonical.js";

type JsonRecord = Record<string, unknown>;

export type ExpressionContext = {
  readonly input: unknown;
  readonly item?: unknown;
  readonly step?: unknown;
  readonly workflow?: unknown;
  readonly steps: Record<
    string,
    { readonly output?: unknown; readonly visits?: readonly unknown[] }
  >;
};

const TEMPLATE_ONLY_PATTERN = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/u;
const TEMPLATE_EXPRESSION_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const COMPARISON_OPERATORS = ["===", "!==", ">=", "<=", "==", "!=", ">", "<"] as const;

export function resolveExpressionValue(value: unknown, context: ExpressionContext): unknown {
  if (typeof value === "string") {
    return resolveString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveExpressionValue(item, context));
  }
  if (isRecord(value)) {
    const resolved = Object.create(null) as JsonRecord;
    for (const [key, item] of Object.entries(value)) {
      assertSafePathSegment(key);
      resolved[key] = resolveExpressionValue(item, context);
    }
    return resolved;
  }
  return value;
}

function resolveString(value: string, context: ExpressionContext): unknown {
  const onlyMatch = TEMPLATE_ONLY_PATTERN.exec(value);
  if (onlyMatch !== null) {
    const expression = onlyMatch[1];
    if (expression === undefined) {
      throw new Error(`Unsupported empty expression: ${value}`);
    }
    return evaluateExpression(expression.trim(), context);
  }
  if (!value.includes("{{") && !value.includes("}}")) {
    return value;
  }
  if (value.match(/\{\{/gu)?.length !== value.match(/\}\}/gu)?.length) {
    throw new Error(`Malformed embedded expression: ${value}`);
  }
  return value.replace(TEMPLATE_EXPRESSION_PATTERN, (_match, expression: string) =>
    stringifyEmbeddedValue(evaluateExpression(expression.trim(), context))
  );
}

function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  const disjunction = splitTopLevelByToken(expression, "||");
  if (disjunction.length > 1) {
    return disjunction.some((part) => Boolean(evaluateExpression(part.trim(), context)));
  }

  const conjunction = splitTopLevelByToken(expression, "&&");
  if (conjunction.length > 1) {
    return conjunction.every((part) => Boolean(evaluateExpression(part.trim(), context)));
  }

  const comparison = findTopLevelComparison(expression);
  if (comparison !== undefined) {
    const left = evaluateExpression(expression.slice(0, comparison.index).trim(), context);
    const right = evaluateExpression(
      expression.slice(comparison.index + comparison.operator.length).trim(),
      context,
    );
    return compareValues(left, right, comparison.operator);
  }

  return evaluateOperand(expression, context);
}

function evaluateOperand(value: string, context: ExpressionContext): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Unsupported empty expression.");
  }
  const stringLiteral = parseStringLiteral(trimmed);
  if (stringLiteral !== undefined) {
    return stringLiteral;
  }
  if (isNumberLiteral(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  const call = parseFunctionCall(trimmed);
  if (call !== undefined) {
    return evaluateFunctionCall(call.name, call.args, context);
  }
  return resolvePathExpression(trimmed, context);
}

function resolvePathExpression(expression: string, context: ExpressionContext): unknown {
  const path = parsePathExpression(expression);
  if (path === undefined) {
    throw new Error(`Unsupported expression: ${expression}`);
  }
  switch (path.root) {
    case "input":
      return readPath(context.input, path.segments, expression);
    case "item":
      if (!("item" in context)) {
        throw new Error(`Expression references item outside a parallel branch: ${expression}`);
      }
      return readPath(context.item, path.segments, expression);
    case "step":
      return readPath(context.step, path.segments, expression);
    case "workflow":
      return readPath(context.workflow, path.segments, expression);
    case "steps": {
      const [stepId, property, ...rest] = path.segments;
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error(`Unsupported step expression: ${expression}`);
      }
      const step = context.steps[stepId];
      if (step === undefined) {
        throw new Error(`Expression references incomplete step '${stepId}'.`);
      }
      if (property === "lastOutput") {
        const lastOutput = step.visits !== undefined && step.visits.length > 0
          ? step.visits[step.visits.length - 1]
          : step.output;
        return readPath(lastOutput, rest, expression);
      }
      if (property === "allVisits") {
        const allVisits: unknown = step.visits !== undefined
          ? step.visits
          : step.output !== undefined ? [step.output] : [];
        return readPath(allVisits, rest, expression);
      }
      return readPath(step, property === undefined ? [] : [property, ...rest], expression);
    }
  }
}

function readPath(
  value: unknown,
  segments: readonly (string | number)[],
  expression: string,
): unknown {
  let current = value;
  for (const segment of segments) {
    if (typeof segment === "string") {
      assertSafePathSegment(segment);
    }
    if (typeof segment === "number" && Array.isArray(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
      continue;
    }
    if (typeof segment === "string" && isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
      continue;
    }
    throw new Error(`Expression '${expression}' could not be resolved at '${segment}'.`);
  }
  return current;
}

function parsePathExpression(
  value: string,
): { readonly root: ExpressionRoot; readonly segments: readonly (string | number)[] } | undefined {
  const first = readPathSegment(value, 0, false);
  if (first === undefined || !isExpressionRoot(first.segment)) {
    return undefined;
  }
  const segments: (string | number)[] = [];
  let index = first.nextIndex;
  while (index < value.length) {
    const char = value[index];
    if (char === ".") {
      const next = readPathSegment(value, index + 1, true);
      if (next === undefined) {
        return undefined;
      }
      segments.push(next.segment);
      index = next.nextIndex;
      continue;
    }
    if (char === "[") {
      const next = readPathIndex(value, index);
      if (next === undefined) {
        return undefined;
      }
      segments.push(next.segment);
      index = next.nextIndex;
      continue;
    }
    return undefined;
  }
  return { root: first.segment, segments };
}

type ExpressionRoot = "input" | "item" | "step" | "steps" | "workflow";

function isExpressionRoot(value: string): value is ExpressionRoot {
  return value === "input" ||
    value === "item" ||
    value === "step" ||
    value === "steps" ||
    value === "workflow";
}

function readPathSegment(
  value: string,
  index: number,
  allowHyphen: boolean,
): { readonly segment: string; readonly nextIndex: number } | undefined {
  const pattern = allowHyphen ? /[A-Za-z_$][\w$-]*/uy : /[A-Za-z_$][\w$]*/uy;
  pattern.lastIndex = index;
  const match = pattern.exec(value);
  const segment = match?.[0];
  if (segment === undefined || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
    return undefined;
  }
  return { segment, nextIndex: index + segment.length };
}

function readPathIndex(
  value: string,
  index: number,
): { readonly segment: string | number; readonly nextIndex: number } | undefined {
  let cursor = index + 1;
  const first = value[cursor];
  if (first === '"' || first === "'") {
    const literal = readQuotedLiteral(value, cursor);
    if (literal === undefined || value[literal.nextIndex] !== "]") {
      return undefined;
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(literal.value)) {
      return undefined;
    }
    return { segment: literal.value, nextIndex: literal.nextIndex + 1 };
  }

  const numberMatch = /\d+/uy;
  numberMatch.lastIndex = cursor;
  const match = numberMatch.exec(value);
  if (match === null) {
    return undefined;
  }
  cursor += match[0].length;
  return value[cursor] === "]"
    ? { segment: Number(match[0]), nextIndex: cursor + 1 }
    : undefined;
}

function readQuotedLiteral(
  value: string,
  index: number,
): { readonly value: string; readonly nextIndex: number } | undefined {
  const quote = value[index];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  let result = "";
  for (let cursor = index + 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (char === "\\" && cursor + 1 < value.length) {
      result += value[cursor + 1] ?? "";
      cursor += 1;
      continue;
    }
    if (char === quote) {
      return { value: result, nextIndex: cursor + 1 };
    }
    result += char;
  }
  return undefined;
}

function parseStringLiteral(value: string): string | undefined {
  const literal = readQuotedLiteral(value, 0);
  return literal?.nextIndex === value.length ? literal.value : undefined;
}

function isNumberLiteral(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}

function parseFunctionCall(
  value: string,
): { readonly name: string; readonly args: readonly string[] } | undefined {
  const match = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(value);
  if (match === null || !value.endsWith(")")) {
    return undefined;
  }
  const openIndex = value.indexOf("(", match[1]?.length ?? 0);
  if (matchingCloseParenIndex(value, openIndex) !== value.length - 1) {
    return undefined;
  }
  const inner = value.slice(openIndex + 1, -1).trim();
  return {
    name: match[1] ?? "",
    args: inner.length === 0 ? [] : splitTopLevelByToken(inner, ","),
  };
}

function matchingCloseParenIndex(value: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function splitTopLevelByToken(value: string, token: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        return [value];
      }
      continue;
    }
    if (depth === 0 && value.startsWith(token, index)) {
      parts.push(value.slice(start, index));
      index += token.length - 1;
      start = index + 1;
    }
  }

  if (parts.length === 0) {
    return [value];
  }
  parts.push(value.slice(start));
  return parts;
}

function findTopLevelComparison(
  value: string,
): { readonly index: number; readonly operator: string } | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    for (const operator of COMPARISON_OPERATORS) {
      if (value.startsWith(operator, index)) {
        return { index, operator };
      }
    }
  }
  return undefined;
}

function compareValues(left: unknown, right: unknown, operator: string): boolean {
  switch (operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case ">":
      return (left as number | string) > (right as number | string);
    case "<":
      return (left as number | string) < (right as number | string);
    case ">=":
      return (left as number | string) >= (right as number | string);
    case "<=":
      return (left as number | string) <= (right as number | string);
    default:
      throw new Error(`Unsupported comparison operator '${operator}'.`);
  }
}

function evaluateFunctionCall(
  name: string,
  args: readonly string[],
  context: ExpressionContext,
): unknown {
  switch (name) {
    case "coalesce": {
      if (args.length < 2) {
        throw new Error("coalesce() requires at least two arguments.");
      }
      for (const arg of args) {
        const value = evaluateOptionalExpression(arg.trim(), context);
        if (value !== undefined && value !== null) {
          return value;
        }
      }
      return undefined;
    }
    case "date":
    case "hmac":
    case "json":
    case "len":
    case "lower":
    case "sha256":
    case "upper":
      return evaluateEagerFunctionCall(name, args, context);
    default:
      throw new Error(`Unsupported expression function '${name}'.`);
  }
}

function evaluateEagerFunctionCall(
  name: string,
  args: readonly string[],
  context: ExpressionContext,
): unknown {
  const values = args.map((arg) => evaluateExpression(arg.trim(), context));
  switch (name) {
    case "date":
      if (values.length !== 1) {
        throw new Error("date() requires one argument.");
      }
      return new Date(String(values[0])).toISOString();
    case "hmac":
      if (values.length !== 2) {
        throw new Error("hmac() requires two arguments.");
      }
      return `sha256:${createHmac("sha256", String(values[0]))
        .update(stringifyStable(values[1]))
        .digest("hex")}`;
    case "json":
      if (values.length !== 1) {
        throw new Error("json() requires one argument.");
      }
      return JSON.stringify(values[0]);
    case "len":
      if (values.length !== 1) {
        throw new Error("len() requires one argument.");
      }
      return lengthOf(values[0]);
    case "lower":
      if (values.length !== 1) {
        throw new Error("lower() requires one argument.");
      }
      return String(values[0]).toLowerCase();
    case "sha256":
      if (values.length < 1) {
        throw new Error("sha256() requires at least one argument.");
      }
      return sha256Digest(values.length === 1 ? values[0] : values);
    case "upper":
      if (values.length !== 1) {
        throw new Error("upper() requires one argument.");
      }
      return String(values[0]).toUpperCase();
    default:
      throw new Error(`Unsupported expression function '${name}'.`);
  }
}

function evaluateOptionalExpression(expression: string, context: ExpressionContext): unknown {
  try {
    return evaluateExpression(expression, context);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("could not be resolved") ||
        error.message.includes("references incomplete step"))
    ) {
      return undefined;
    }
    throw error;
  }
}

function lengthOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value)) {
    return Object.keys(value).length;
  }
  throw new Error("len() supports strings, arrays, and objects.");
}

function assertSafePathSegment(segment: string): void {
  if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
    throw new Error(`Unsafe expression path segment '${segment}'.`);
  }
}

function stringifyEmbeddedValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function stringifyStable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
