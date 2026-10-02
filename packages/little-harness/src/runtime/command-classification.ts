import { BashTransformPipeline, CommandCollectorPlugin, parse } from "just-bash";
import type { HarnessRuntimeOptions } from "../types.js";
import {
  tier0CapabilityMatrix,
  type Tier0Capability,
  type Tier0CapabilityMatrix,
  type Tier0RealExecReason,
} from "./tier0-capability-matrix.js";

/**
 * What a Tier-0 host should do with a shell script, decided *before* anything runs.
 *
 * - `"run"` — every command the script names is emulated at the caller's runtime settings.
 * - `"escalate"` — the script needs an execution tier just-bash cannot provide. This is
 *   not an error: the script is well-formed and a real environment would run it.
 * - `"deny"` — policy forbids it. Escalating would not help.
 */
export type ClassificationDecision = "run" | "escalate" | "deny";

/**
 * Why {@link classifyCommand} decided what it decided. Every classification carries at
 * least one, and each one names the command it is about wherever a command is knowable,
 * so a consumer can report or meter escalation without re-deriving anything.
 */
export type ClassificationReason =
  /** The named commands are all emulated at the caller's runtime settings. */
  | { readonly kind: "tier0-supported"; readonly commands: readonly string[] }
  /** The script names no commands at all (empty, whitespace, comments only). */
  | { readonly kind: "empty-script" }
  /** Not in the capability matrix and not on the needs-real-exec list. */
  | { readonly kind: "unknown-command"; readonly command: string }
  /** Known to require a real process/toolchain/network stack. */
  | {
      readonly kind: "needs-real-exec";
      readonly command: string;
      readonly reason: Tier0RealExecReason;
    }
  /**
   * just-bash *can* emulate this command, but the runtime toggle that registers it is
   * off. Escalation territory, not denial: a tier with the capability enabled runs it.
   */
  | {
      readonly kind: "capability-disabled";
      readonly command: string;
      readonly capability: Exclude<Tier0Capability, "always">;
    }
  /** Blocked by the caller's policy. */
  | { readonly kind: "policy-blocked"; readonly command: string; readonly rule: string }
  /** A command name that cannot be read statically (`$CMD`, `eval "$x"`, a glob). */
  | { readonly kind: "dynamic-command"; readonly source: string }
  /** A script file whose contents classification cannot see (`./x.sh`, `source x.sh`). */
  | { readonly kind: "opaque-script"; readonly command: string }
  /** just-bash's parser rejected the script. */
  | { readonly kind: "parse-failed"; readonly message: string }
  /** The just-bash AST surface this module depends on did not behave as expected. */
  | { readonly kind: "classifier-unavailable"; readonly detail: string };

export type CommandClassification = {
  readonly decision: ClassificationDecision;
  readonly reasons: readonly ClassificationReason[];
};

/** Caller policy applied on top of the capability matrix. */
export type Tier0ClassificationPolicy = {
  /**
   * Command names that must never run, at any tier. Checked before shell-function
   * shadowing, so a script cannot define `curl() { ... }` to slip past a `curl` denial.
   */
  readonly denyCommands?: readonly string[];
  /** Label recorded on the resulting `policy-blocked` reasons. */
  readonly rule?: string;
};

export type ClassifyCommandOptions = {
  /** The runtime toggles the script would run under. Interpreted like `bashOptionsForRuntime`. */
  readonly runtime?: HarnessRuntimeOptions | undefined;
  readonly policy?: Tier0ClassificationPolicy | undefined;
  /** Override the matrix (tests, or a host pinning an older matrix version). */
  readonly matrix?: Tier0CapabilityMatrix | undefined;
};

/** The runtime toggles that decide which conditionally-registered commands exist. */
export type Tier0RuntimeCapabilities = {
  readonly python: boolean;
  readonly javascript: boolean;
  readonly network: boolean;
};

/**
 * Mirrors `bashOptionsForRuntime`: python and javascript are on unless explicitly
 * `false`, and network is off unless a policy is supplied. Classification and execution
 * must agree about this or the classifier would clear commands the shell then rejects.
 */
export function tier0RuntimeCapabilities(
  runtime: HarnessRuntimeOptions | undefined,
): Tier0RuntimeCapabilities {
  return {
    python: runtime?.python ?? true,
    javascript: runtime?.javascript ?? true,
    network: runtime?.network !== undefined && runtime.network !== false,
  };
}

/**
 * How many levels of `bash -c` / `eval` payload are followed before falling back to a
 * `dynamic-command` escalation.
 */
const MAX_NESTED_DEPTH = 3;

/**
 * Decides whether a shell script can run on Tier-0 (just-bash), needs a real execution
 * environment, or is forbidden — *without executing any of it*.
 *
 * The ordering matters more than the verdict. An unsupported command discovered by
 * running the script is discovered halfway through a pipeline, after `rm -rf build` has
 * already happened and before `cargo build` failed; the same script re-run on a real tier
 * repeats the destructive prefix. Classifying first means escalation happens before any
 * side effect exists to repeat.
 *
 * The verdict is derived from two static passes over the same script:
 *
 * 1. just-bash's own `CommandCollectorPlugin`, which walks the parsed AST and reports
 *    every command name the script references — through pipes, `&&`, subshells, command
 *    substitutions, loop bodies, and heredoc-fed commands alike. This is the authoritative
 *    list of names, and it is why quoting is not a problem: `echo "docker ps"` references
 *    `echo` only.
 * 2. A walk of `parse(script)` for the three facts the collector cannot express — shell
 *    functions defined in the script (which shadow matrix entries), command names that are
 *    not statically readable, and literal `bash -c` / `eval` payloads worth following.
 *
 * A name that resolves to nothing runnable escalates rather than fails: `cargo` is not a
 * broken command, it is a command this tier does not have.
 *
 * Known blind spots, all of which fall through to {@link detectEmulationGap}: a command
 * passed as an argument to a runner (`xargs cargo build`, `timeout 5 docker ps`,
 * `env FOO=1 cargo build`), the contents of a script file, and which *flags* each emulated
 * command implements.
 */
export function classifyCommand(
  script: string,
  options: ClassifyCommandOptions = {},
): CommandClassification {
  const context: ClassifyContext = {
    matrix: options.matrix ?? tier0CapabilityMatrix(),
    capabilities: tier0RuntimeCapabilities(options.runtime),
    denied: new Set(options.policy?.denyCommands ?? []),
    rule: options.policy?.rule ?? "denyCommands",
    reasons: new Map(),
    supported: new Set(),
  };
  classifyInto(script, context, 0);
  return finalize(context);
}

/**
 * Detects that a *finished* Tier-0 execution failed because just-bash lacks the command
 * or the flag, rather than because the command ran and reported a real problem.
 *
 * Classification cannot be complete: it cannot read the contents of `./build.sh`, and it
 * has no model of which *flags* each emulated command implements. This detector is the
 * narrow back-stop for both, matching the exact strings just-bash produces:
 *
 * - `bash: <name>: command not found` — the interpreter's command-resolution miss.
 * - `bash: <name>: command not available in browser environments. …` — the same miss for a
 *   command that exists but is unavailable in this build/configuration (python3).
 * - `<name>: unrecognized option '--x'` / `<name>: invalid option -- 'x'` — the shared
 *   option-parser rejection, counted only when `<name>` is a matrix command, which is
 *   what makes it a *coverage* gap rather than a genuine user error.
 *
 * Deliberately not treated as gaps: `Permission denied` (126) and `No such file or
 * directory` (a real shell reports these identically), and exit 126 execution-limit
 * failures (a limit was hit, not a missing capability).
 *
 * It does not catch every flag gap. Only commands that reject through just-bash's shared
 * option parser produce a matchable line; a command that ignores or mishandles a flag it
 * does not implement (`grep --include=x` exits 1 with empty stderr) is invisible to both
 * layers, and Tier-0 returns a wrong-but-plausible result. Nothing here fixes that.
 *
 * Two properties consumers must respect:
 *
 * - **stderr is matched, not the exit code.** A pipeline's exit code is its last command's,
 *   so `cargo build | cat` exits 0 with the gap only in stderr.
 *  - **stderr is attacker-writable.** A model can print these lines itself
 *    (`echo 'bash: x: command not found' >&2`). The containment is the consumer's, not
 *    this function's: LIT-55 must bound this signal to **one escalation per command**, so a
 *    forged line costs at most one extra tier attempt and can never loop.
 */
export function detectEmulationGap(
  result: { readonly stderr: string; readonly exitCode: number },
  options: { readonly matrix?: Tier0CapabilityMatrix | undefined } = {},
): Tier0EmulationGap | undefined {
  const matrix = options.matrix ?? tier0CapabilityMatrix();
  for (const line of result.stderr.split("\n")) {
    const notFound = /^bash: (.+): command not found$/.exec(line);
    if (notFound?.[1] !== undefined) {
      return { kind: "emulation-gap", signal: "command-not-found", command: notFound[1] };
    }
    const unavailable = /^bash: (.+): command not available in /.exec(line);
    if (unavailable?.[1] !== undefined) {
      return { kind: "emulation-gap", signal: "command-unavailable", command: unavailable[1] };
    }
    const longOption = /^(\S+): unrecognized option '(.+)'$/.exec(line);
    if (longOption?.[1] !== undefined && longOption[2] !== undefined) {
      const gap = optionGap(matrix, longOption[1], longOption[2]);
      if (gap !== undefined) {
        return gap;
      }
    }
    const shortOption = /^(\S+): invalid option -- '(.+)'$/.exec(line);
    if (shortOption?.[1] !== undefined && shortOption[2] !== undefined) {
      const gap = optionGap(matrix, shortOption[1], `-${shortOption[2]}`);
      if (gap !== undefined) {
        return gap;
      }
    }
  }
  return undefined;
}

/**
 * A Tier-0 miss recovered from an execution result rather than from classification.
 * Structurally distinct from {@link ClassificationReason} so a consumer can never confuse
 * "we knew before running" with "we found out by running".
 */
export type Tier0EmulationGap = {
  readonly kind: "emulation-gap";
  readonly signal: "command-not-found" | "command-unavailable" | "unsupported-option";
  readonly command: string;
  readonly option?: string;
};

type ClassifyContext = {
  readonly matrix: Tier0CapabilityMatrix;
  readonly capabilities: Tier0RuntimeCapabilities;
  readonly denied: ReadonlySet<string>;
  readonly rule: string;
  readonly reasons: Map<string, ClassificationReason>;
  readonly supported: Set<string>;
};

type ScriptFacts = {
  readonly functionNames: Set<string>;
  readonly dynamicSources: Set<string>;
  readonly opaqueScripts: Set<string>;
  readonly nestedScripts: string[];
};

function classifyInto(script: string, context: ClassifyContext, depth: number): void {
  let ast: unknown;
  try {
    ast = parse(script);
  } catch (error) {
    addReason(context, {
      kind: "parse-failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let collected: string[];
  try {
    collected = collectCommands(script);
  } catch (error) {
    addReason(context, {
      kind: "classifier-unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const facts: ScriptFacts = {
    functionNames: new Set(),
    dynamicSources: new Set(),
    opaqueScripts: new Set(),
    nestedScripts: [],
  };
  inspectNode(ast, facts);

  for (const command of collected) {
    classifyName(command, facts, context);
  }
  for (const source of facts.dynamicSources) {
    addReason(context, { kind: "dynamic-command", source });
  }
  for (const command of facts.opaqueScripts) {
    addReason(context, { kind: "opaque-script", command });
  }
  for (const nested of facts.nestedScripts) {
    if (depth + 1 > MAX_NESTED_DEPTH) {
      addReason(context, { kind: "dynamic-command", source: "nested script beyond depth limit" });
      continue;
    }
    classifyInto(nested, context, depth + 1);
  }
}

function classifyName(command: string, facts: ScriptFacts, context: ClassifyContext): void {
  // Policy first: a denial must not be defeatable by shadowing the name with a function.
  if (context.denied.has(command)) {
    addReason(context, { kind: "policy-blocked", command, rule: context.rule });
    return;
  }
  // A function defined in this very script shadows whatever the matrix says — real bash
  // semantics, and the reason `cargo() { echo stub; }; cargo build` is Tier-0 runnable.
  if (facts.functionNames.has(command)) {
    context.supported.add(command);
    return;
  }
  if (context.matrix.builtins.has(command)) {
    context.supported.add(command);
    return;
  }
  const capability = context.matrix.commands.get(command);
  if (capability !== undefined) {
    if (capability === "always" || context.capabilities[capability]) {
      context.supported.add(command);
    } else {
      addReason(context, { kind: "capability-disabled", command, capability });
    }
    return;
  }
  const realExec = context.matrix.needsRealExec.get(command);
  if (realExec !== undefined) {
    addReason(context, { kind: "needs-real-exec", command, reason: realExec });
    return;
  }
  // A path-like name is a script file: just-bash executes it with its own interpreter, so
  // the invocation itself is fine and any gap inside surfaces through `detectEmulationGap`.
  if (command.includes("/")) {
    addReason(context, { kind: "opaque-script", command });
    return;
  }
  addReason(context, { kind: "unknown-command", command });
}

function finalize(context: ClassifyContext): CommandClassification {
  if (context.supported.size > 0) {
    addReason(context, { kind: "tier0-supported", commands: [...context.supported].sort() });
  }
  if (context.reasons.size === 0) {
    addReason(context, { kind: "empty-script" });
  }
  const reasons = [...context.reasons.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, reason]) => reason);
  let decision: ClassificationDecision = "run";
  for (const reason of reasons) {
    const contribution = decisionFor(reason.kind);
    if (contribution === "deny") {
      return { decision: "deny", reasons };
    }
    if (contribution === "escalate") {
      decision = "escalate";
    }
  }
  return { decision, reasons };
}

function decisionFor(kind: ClassificationReason["kind"]): ClassificationDecision {
  switch (kind) {
    case "policy-blocked":
      return "deny";
    case "unknown-command":
    case "needs-real-exec":
    case "capability-disabled":
    case "dynamic-command":
    case "parse-failed":
    case "classifier-unavailable":
      return "escalate";
    case "tier0-supported":
    case "empty-script":
    case "opaque-script":
      return "run";
  }
}

function addReason(context: ClassifyContext, reason: ClassificationReason): void {
  context.reasons.set(`${reason.kind} ${JSON.stringify(reason)}`, reason);
}

/**
 * just-bash 3.0.1 exports `CommandCollectorPlugin` and `BashTransformPipeline` at runtime
 * exactly as its README documents, but ships no declarations for them (`files` in its
 * package.json omits `dist/transform/`), so both are `any` under `skipLibCheck`. Everything
 * crossing that boundary is therefore shape-checked here rather than trusted, and a
 * matrix test pins the surface so an upgrade that moves it fails loudly.
 */
function collectCommands(script: string): string[] {
  const pipeline: unknown = new BashTransformPipeline().use(new CommandCollectorPlugin());
  const transform = (pipeline as { transform?: (input: string) => unknown }).transform;
  if (typeof transform !== "function") {
    throw new Error("just-bash BashTransformPipeline has no transform() method.");
  }
  const result = transform.call(pipeline, script) as { metadata?: { commands?: unknown } };
  const commands = result?.metadata?.commands;
  if (!Array.isArray(commands)) {
    throw new Error("just-bash CommandCollectorPlugin did not report a commands array.");
  }
  return commands.filter((command): command is string => typeof command === "string");
}

/**
 * Structural walk of the parsed script. Deliberately generic — it descends through every
 * object and array rather than enumerating the ten compound-command node types — so a
 * construct just-bash adds later still gets inspected instead of silently skipped.
 */
function inspectNode(node: unknown, facts: ScriptFacts): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      inspectNode(child, facts);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record["type"] === "FunctionDef" && typeof record["name"] === "string") {
    facts.functionNames.add(record["name"]);
  }
  if (record["type"] === "SimpleCommand") {
    inspectSimpleCommand(record, facts);
  }
  for (const value of Object.values(record)) {
    inspectNode(value, facts);
  }
}

function inspectSimpleCommand(node: Record<string, unknown>, facts: ScriptFacts): void {
  const name = node["name"];
  if (name === null || name === undefined) {
    return; // assignment-only command: `FOO=1`
  }
  const literal = wordLiteral(name);
  const args = Array.isArray(node["args"]) ? node["args"] : [];
  if (literal === undefined) {
    facts.dynamicSources.add(describeWord(name));
    return;
  }
  if (literal === "bash" || literal === "sh") {
    inspectShellInvocation(literal, args, facts);
    return;
  }
  if (literal === "eval") {
    const parts = args.map((arg) => wordLiteral(arg));
    if (parts.length > 0 && parts.every((part) => part !== undefined)) {
      facts.nestedScripts.push(parts.join(" "));
    } else if (parts.length > 0) {
      facts.dynamicSources.add("eval");
    }
    return;
  }
  if (literal === "source" || literal === ".") {
    const target = args.length > 0 ? wordLiteral(args[0]) : undefined;
    if (target !== undefined) {
      facts.opaqueScripts.add(target);
    }
  }
}

function inspectShellInvocation(shell: string, args: unknown[], facts: ScriptFacts): void {
  const index = args.findIndex((arg) => wordLiteral(arg) === "-c");
  if (index >= 0) {
    const payload = index + 1 < args.length ? wordLiteral(args[index + 1]) : undefined;
    if (payload === undefined) {
      facts.dynamicSources.add(`${shell} -c`);
    } else {
      facts.nestedScripts.push(payload);
    }
    return;
  }
  for (const arg of args) {
    const value = wordLiteral(arg);
    if (value !== undefined && !value.startsWith("-")) {
      facts.opaqueScripts.add(value);
      return;
    }
  }
}

/**
 * The literal text of a word, or `undefined` when any part of it depends on runtime state
 * (parameter expansion, command substitution, arithmetic, globs, tilde, brace expansion).
 */
function wordLiteral(word: unknown): string | undefined {
  if (word === null || typeof word !== "object") {
    return undefined;
  }
  const parts = (word as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }
  let text = "";
  for (const part of parts) {
    const value = partLiteral(part);
    if (value === undefined) {
      return undefined;
    }
    text += value;
  }
  return text;
}

function partLiteral(part: unknown): string | undefined {
  if (part === null || typeof part !== "object") {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  switch (record["type"]) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return typeof record["value"] === "string" ? record["value"] : undefined;
    case "DoubleQuoted":
      return wordLiteral(record);
    default:
      return undefined;
  }
}

/** A short, stable label for a command name that cannot be read statically. */
function describeWord(word: unknown): string {
  const parts = (word as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return "<unreadable command name>";
  }
  let text = "";
  for (const part of parts) {
    const literal = partLiteral(part);
    if (literal !== undefined) {
      text += literal;
      continue;
    }
    const record = part as Record<string, unknown>;
    switch (record["type"]) {
      case "ParameterExpansion":
        text += `\${${typeof record["parameter"] === "string" ? record["parameter"] : "?"}}`;
        break;
      case "CommandSubstitution":
        text += "$(...)";
        break;
      case "ArithmeticExpansion":
        text += "$((...))";
        break;
      case "Glob":
        text += typeof record["pattern"] === "string" ? record["pattern"] : "*";
        break;
      case "TildeExpansion":
        text += "~";
        break;
      default:
        text += `<${String(record["type"])}>`;
        break;
    }
  }
  return text;
}

function optionGap(
  matrix: Tier0CapabilityMatrix,
  command: string,
  option: string,
): Tier0EmulationGap | undefined {
  if (!matrix.commands.has(command) && !matrix.builtins.has(command)) {
    return undefined;
  }
  return { kind: "emulation-gap", signal: "unsupported-option", command, option };
}
