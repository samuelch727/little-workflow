import * as defaultAiSdkModule from "ai";
import { createEventId, sha256Hex } from "../ids.js";
import {
  findModelReplay,
  findToolReplay,
  hashHarnessPrompt,
  hashHarnessToolCall,
  type DurableHarnessEvent,
} from "../events/durability.js";
import { emitHarnessOccurrence } from "../events/occurrence.js";
import { toolRefsForDurableRequest } from "../execution/model-events.js";
import type { JsonObject } from "../types.js";
import {
  WORKFLOW_HARNESS_ID,
  type WorkflowHarness,
  type WorkflowHarnessContext,
  type WorkflowHarnessDurabilitySink,
  type WorkflowHarnessResult,
  type WorkflowHarnessTask,
  type WorkflowSkillDescriptor,
  type WorkflowHarnessTraceSink,
  type WorkflowStepContext,
  type WorkflowStep,
} from "./types.js";

export type AiLoopResult = {
  readonly output?: unknown;
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly {
    readonly toolName: string;
    readonly args: unknown;
    readonly toolCallId?: string;
  }[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly reasoningTokens?: number;
  };
};

export type AiLoopAdapter = {
  readonly generate: (options: {
    readonly model: unknown;
    readonly system?: string;
    readonly messages: readonly unknown[];
    readonly tools: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly step: unknown;
    readonly input: unknown;
  }) => Promise<AiLoopResult>;
};

type AiSdkOutputHelper = (options?: JsonObject) => unknown;
type NormalizedUsage = Required<Pick<NonNullable<AiLoopResult["usage"]>, "inputTokens" | "outputTokens">> &
  Pick<NonNullable<AiLoopResult["usage"]>, "cachedInputTokens" | "reasoningTokens">;

export type AiSdkModuleLike = {
  readonly generateText?: (options: JsonObject) => Promise<unknown> | unknown;
  readonly streamText?: (options: JsonObject) => unknown;
  readonly jsonSchema?: (schema: unknown) => unknown;
  readonly Output?: {
    readonly text?: AiSdkOutputHelper;
    readonly object?: AiSdkOutputHelper;
    readonly array?: AiSdkOutputHelper;
    readonly choice?: AiSdkOutputHelper;
    readonly json?: AiSdkOutputHelper;
  };
};

export type CreateWorkflowHarnessOptions = {
  readonly aiLoop?: AiLoopAdapter;
  readonly aiSdkModule?: AiSdkModuleLike;
  readonly modelCallTimeoutMs?: number;
  readonly modelCallMaxRetries?: number;
  readonly modelCallRetryDelayMs?: number;
  readonly conversationCompaction?: Partial<{
    readonly maxChars: number;
    readonly keepRecentMessages: number;
    readonly minElideChars: number;
  }>;
};

export function createWorkflowHarness(options: CreateWorkflowHarnessOptions = {}): WorkflowHarness {
  const aiLoop = options.aiLoop ??
    aiLoopFromAiSdkModule(options.aiSdkModule ?? (defaultAiSdkModule as unknown as AiSdkModuleLike));
  const resolvedOptions: CreateWorkflowHarnessOptions = aiLoop === undefined ? options : { ...options, aiLoop };
  return {
    harnessId: WORKFLOW_HARNESS_ID,
    run: (task, ctx) => runWorkflowHarnessTask(task, ctx, resolvedOptions),
  };
}

export const workflowHarness = createWorkflowHarness();

async function runWorkflowHarnessTask(
  task: WorkflowHarnessTask,
  ctx: WorkflowHarnessContext,
  options: CreateWorkflowHarnessOptions,
): Promise<WorkflowHarnessResult> {
  if (task.kind === "execute_step") {
    return executeStep(task.step, task.stepInput, task.stepContext, ctx, options);
  }
  if (task.kind === "fix_step" || task.kind === "plan" || task.kind === "orchestrate") {
    return runModelLikeTask(task, ctx, options);
  }
  assertNever(task);
}

async function executeStep(
  step: WorkflowStep,
  stepInput: unknown,
  stepContext: WorkflowStepContext,
  ctx: WorkflowHarnessContext,
  options: CreateWorkflowHarnessOptions,
): Promise<WorkflowHarnessResult> {
  await emitExecuteStep(ctx, "harness.execute_step.started", step, stepContext);
  if (step.uses === "tool.call") {
    const output = await executeToolStep(step, stepInput, stepContext, ctx);
    await emitExecuteStep(ctx, "harness.execute_step.succeeded", step, stepContext, { output });
    return { kind: "execute_step", output, artifactRefs: [] };
  }
  if (step.uses === "ai.generate") {
    const result = await runAiGenerateStep(step, stepInput, stepContext, ctx, options);
    if (result.kind === "delegate_to_default") {
      return result;
    }
    await emitExecuteStep(ctx, "harness.execute_step.succeeded", step, stepContext, { output: result.output });
    return result;
  }
  if (step.uses === "code.run") {
    const output = await executeCodeRunStep(step, stepInput, stepContext, ctx);
    await emitExecuteStep(ctx, "harness.execute_step.succeeded", step, stepContext, { output });
    return { kind: "execute_step", output, artifactRefs: [] };
  }
  if (step.uses === "decision" || step.uses === "parallel") {
    return { kind: "delegate_to_default" };
  }
  assertNever(step);
}

async function executeCodeRunStep(
  step: Extract<WorkflowStep, { uses: "code.run" }>,
  _stepInput: unknown,
  _stepContext: WorkflowStepContext,
  _ctx: WorkflowHarnessContext,
): Promise<unknown> {
  validateCodeRunSandbox(step);
  throw new Error(
    `Workflow code.run step '${step.id}' cannot safely execute code.run in the default workflow harness. ` +
      "The declared sandbox.env/fs/network deny policy requires an isolated runtime.",
  );
}

function validateCodeRunSandbox(
  step: Extract<WorkflowStep, { uses: "code.run" }>,
): void {
  const sandbox = step.with.sandbox;
  if (!isRecord(sandbox)) {
    throw new Error(`Workflow code.run step '${step.id}' requires a sandbox policy.`);
  }
  const unsupportedKeys = Object.keys(sandbox).filter((key) => key !== "network" && key !== "env" && key !== "fs");
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Workflow code.run step '${step.id}' has unsupported sandbox keys: ${unsupportedKeys.join(", ")}.`,
    );
  }
  if (sandbox.network !== "deny" && sandbox.network !== false) {
    throw new Error(`Workflow code.run step '${step.id}' only supports sandbox.network deny.`);
  }
  if (sandbox.env !== undefined && sandbox.env !== "deny" && sandbox.env !== false) {
    throw new Error(`Workflow code.run step '${step.id}' only supports sandbox.env deny.`);
  }
  if (sandbox.fs !== undefined && sandbox.fs !== "deny" && sandbox.fs !== false) {
    throw new Error(`Workflow code.run step '${step.id}' only supports sandbox.fs deny.`);
  }
}

async function executeToolStep(
  step: Extract<WorkflowStep, { uses: "tool.call" }>,
  stepInput: unknown,
  stepContext: WorkflowStepContext,
  ctx: WorkflowHarnessContext,
): Promise<unknown> {
  const toolName = step.with?.tool;
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new Error(`Workflow tool.call step '${step.id}' requires with.tool.`);
  }
  return executeScopedToolCall(
    toolName,
    stepInput,
    toolCallScopeForStepContext(stepContext),
    1,
    ctx,
    { toolExecutionContext: stepContext.toolExecutionContext },
  );
}

async function executeScopedToolCall(
  toolName: string,
  input: unknown,
  scope: Record<string, unknown>,
  callIndex: number,
  ctx: WorkflowHarnessContext,
  options: {
    readonly caller?: "model" | "code";
    readonly turn?: number;
    readonly toolSet?: Record<string, unknown>;
    readonly toolExecutionContext?: unknown;
  } = {},
): Promise<unknown> {
  const caller = options.caller ?? "code";
  const turn = options.turn;
  const toolSet = options.toolSet ?? ctx.tools;
  await assertToolAllowed(toolName, input, ctx);
  const tool = toolSet[toolName];
  if (!isObject(tool) || typeof tool.execute !== "function") {
    throw new Error(`Workflow tool '${toolName}' is not executable.`);
  }

  const durableInput = workflowRunToolInput(toolName, input, {
    ctx,
    caller,
    callIndex,
    scope,
    ...(caller === "model" ? { turn: turn ?? 1 } : {}),
  });
  const toolCall = {
    caller,
    toolName,
    args: durableInput,
    callIndex,
    ...(caller === "model" ? { turn: turn ?? 1 } : {}),
    scope,
  };
  const priorEvents = await ctx.durability.priorEvents?.({ runId: ctx.session.runId }) ?? [];
  const replay = findToolReplay(priorEvents as readonly DurableHarnessEvent[], toolCall);
  if (replay.kind === "completed") {
    return replay.result;
  }
  if (replay.kind === "failed") {
    throw errorFromReplayEnvelope(replay.error);
  }
  const callId = replay.kind === "inflight" ? replay.callId : createEventId();
  const occurrenceId = replay.kind === "inflight"
    ? findInflightToolOccurrenceId(priorEvents as readonly DurableHarnessEvent[], toolCall, callId) ?? createEventId()
    : createEventId();
  if (replay.kind === "none") {
    await emitHarnessOccurrence({
      type: "harness.tool_call.started",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        caller,
        toolName,
        args: durableInput,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        scope,
      },
      metadata: {
        toolName,
        toolCallId: callId,
        caller,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        scope,
      },
      ...occurrenceSinks(ctx),
    });
  }

  try {
    const executionContext = {
      ...runtimeToolExecutionContext(options.toolExecutionContext),
      runId: runtimeToolContextString(options.toolExecutionContext, "runId") ?? ctx.session.runId,
      stepPath: runtimeToolContextString(options.toolExecutionContext, "stepPath") ??
        (typeof scope.stepPath === "string" ? scope.stepPath : ""),
      attempt: runtimeToolContextNumber(options.toolExecutionContext, "attempt") ??
        (typeof scope.attempt === "number" ? scope.attempt : 1),
      signal: runtimeToolContextSignal(options.toolExecutionContext) ?? ctx.abortSignal,
      caller,
    };
    const output = await tool.execute(durableInput, {
      ...executionContext,
      toolCallId: callId,
      messages: [],
      abortSignal: executionContext.signal,
      experimental_context: isRecord(options.toolExecutionContext) ? options.toolExecutionContext : executionContext,
    });
    const durableResult = output === undefined ? null : output;
    await emitHarnessOccurrence({
      type: "harness.tool_call.succeeded",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        caller,
        toolName,
        args: durableInput,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        result: durableResult,
        ...(output === undefined ? { resultUndefined: true } : {}),
        scope,
      },
      metadata: {
        toolName,
        toolCallId: callId,
        caller,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        output: traceContentRef(output),
        scope,
      },
      ...occurrenceSinks(ctx),
    });
    return output;
  } catch (error) {
    await emitHarnessOccurrence({
      type: "harness.tool_call.failed",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        caller,
        toolName,
        args: durableInput,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        error: errorEnvelope(error),
        scope,
      },
      metadata: {
        toolName,
        toolCallId: callId,
        caller,
        callIndex,
        ...(caller === "model" ? { turn: turn ?? 1 } : {}),
        error: errorEnvelope(error),
        scope,
      },
      ...occurrenceSinks(ctx),
    });
    throw error;
  }
}

function workflowRunToolInput(
  toolName: string,
  input: unknown,
  options: {
    readonly ctx: WorkflowHarnessContext;
    readonly caller: "model" | "code";
    readonly callIndex: number;
    readonly turn?: number;
    readonly scope: Record<string, unknown>;
  },
): unknown {
  if (toolName !== "start_workflow" && toolName !== "run_workflow") {
    return input;
  }
  if (!isRecord(input)) {
    return input;
  }
  if (typeof input.subRunId === "string" && input.subRunId.length > 0) {
    return input;
  }
  return {
    ...input,
    subRunId: deterministicSubRunId(toolName, input, options),
  };
}

function deterministicSubRunId(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    readonly ctx: WorkflowHarnessContext;
    readonly caller: "model" | "code";
    readonly callIndex: number;
    readonly turn?: number;
    readonly scope: Record<string, unknown>;
  },
): string {
  const digest = hashHarnessPrompt({
    parentRunId: options.ctx.session.runId,
    toolName,
    caller: options.caller,
    callIndex: options.callIndex,
    ...(options.turn === undefined ? {} : { turn: options.turn }),
    scope: options.scope,
    args: input,
  });
  return `run_${digest.slice(7, 23)}`;
}

async function runAiGenerateStep(
  step: Extract<WorkflowStep, { uses: "ai.generate" }>,
  stepInput: unknown,
  stepContext: WorkflowStepContext,
  ctx: WorkflowHarnessContext,
  options: CreateWorkflowHarnessOptions,
): Promise<Extract<WorkflowHarnessResult, { kind: "execute_step" }> | { readonly kind: "delegate_to_default" }> {
  const messages = [{ role: "user", content: stepInput }];
  const model = ctx.model.model;
  const system = systemWithSkills(ctx.system, ctx.skills);
  const scope = toolCallScopeForStepContext(stepContext);
  const executableTools = workflowToolsForContext(ctx);
  const tools = workflowToolRefs(executableTools);
  const request = {
    model: ctx.model.modelId,
    system,
    messages,
    tools,
    scope,
    step,
  };
  const priorEvents = await ctx.durability.priorEvents?.({ runId: ctx.session.runId }) ?? [];
  const replay = findStrictModelReplay<AiLoopResult>(priorEvents as readonly DurableHarnessEvent[], request);
  if (replay.kind === "completed") {
    const output = replay.response.output ?? replay.response.text ?? "";
    return { kind: "execute_step", output, artifactRefs: [] };
  }
  if (options.aiLoop === undefined) {
    return { kind: "delegate_to_default" };
  }
  const callId = replay.kind === "inflight" ? replay.callId : createEventId();
  const turn = replay.kind === "inflight" ? replay.turn : 1;
  const occurrenceId = replay.kind === "inflight" && replay.occurrenceId !== undefined
    ? replay.occurrenceId
    : createEventId();

  if (replay.kind === "none") {
    await emitHarnessOccurrence({
      type: "harness.model.called",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        turn,
        promptHash: hashHarnessPrompt(request),
        request,
      },
      metadata: {
        stepNumber: 1,
        model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
        request: {
          promptHash: sha256Hex(JSON.stringify({ system, messages })),
          system: traceContentRef(system),
          messages: messages.map((message) => ({
            role: message.role,
            content: traceContentRef(message.content),
          })),
          tools,
        },
      },
      ...occurrenceSinks(ctx),
    });
  }

  try {
    const result = await options.aiLoop.generate({
      model,
      system,
      messages,
      tools: executableTools,
      signal: ctx.abortSignal,
      step,
      input: stepInput,
    });
    const output = result.output ?? result.text ?? "";
    const usage = normalizeHarnessUsage(result.usage);
    const responseText = modelResponseText(result, output);
    await emitHarnessOccurrence({
      type: "harness.model.responded",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        turn,
        response: {
          text: responseText,
          output,
          usage,
          ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
        },
      },
      metadata: {
        stepNumber: 1,
        model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
        text: traceContentRef(responseText),
        usage,
        ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
      },
      ...occurrenceSinks(ctx),
    });
    return { kind: "execute_step", output, artifactRefs: [] };
  } catch (error) {
    await emitHarnessOccurrence({
      type: "harness.model.failed",
      runId: ctx.session.runId,
      occurrenceId,
      payload: {
        callId,
        turn,
        durationMs: 0,
        error: errorEnvelope(error),
      },
      metadata: {
        stepNumber: 1,
        model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
        durationMs: 0,
        error: errorEnvelope(error),
      },
      ...occurrenceSinks(ctx),
    });
    throw error;
  }
}

async function runModelLikeTask(
  task: Exclude<WorkflowHarnessTask, { kind: "execute_step" }>,
  ctx: WorkflowHarnessContext,
  options: CreateWorkflowHarnessOptions,
): Promise<WorkflowHarnessResult> {
  const messages: unknown[] = [{ role: "user", content: task }];
  const system = modelLikeSystem(task, ctx);
  const executableTools = workflowToolsForContext(ctx);
  const tools = workflowToolRefs(executableTools);
  const scope = { role: ctx.session.role };
  const taskDescriptor = { kind: task.kind };
  const maxTurns = 25;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const request = {
      model: ctx.model.modelId,
      system,
      messages: [...messages],
      tools,
      scope,
      task: taskDescriptor,
    };
    const priorEvents = await ctx.durability.priorEvents?.({ runId: ctx.session.runId }) ?? [];
    const replay = findStrictModelReplay<AiLoopResult>(priorEvents as readonly DurableHarnessEvent[], request);
    let result: AiLoopResult;
    let callId: string;
    let occurrenceId: string;
    const replayTurn = replay.kind === "inflight" ? replay.turn : turn;

    if (replay.kind === "completed") {
      result = replay.response;
      callId = replay.callId;
      occurrenceId = replay.occurrenceId ?? createEventId();
    } else {
      if (options.aiLoop === undefined) {
        return { kind: "delegate_to_default" };
      }
      callId = replay.kind === "inflight" ? replay.callId : createEventId();
      occurrenceId = replay.kind === "inflight" && replay.occurrenceId !== undefined
        ? replay.occurrenceId
        : createEventId();
      if (replay.kind === "none") {
        await emitHarnessOccurrence({
          type: "harness.model.called",
          runId: ctx.session.runId,
          occurrenceId,
          payload: {
            callId,
            turn,
            promptHash: hashHarnessPrompt(request),
            request,
          },
          metadata: {
            stepNumber: turn,
            model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
            request: {
              promptHash: sha256Hex(JSON.stringify({ system, messages })),
              system: traceContentRef(system),
              messages: messages.map((message) => traceMessageForMetadata(message)),
              tools,
            },
          },
          ...occurrenceSinks(ctx),
        });
      }

      try {
        result = await options.aiLoop.generate({
          model: ctx.model.model,
          system,
          messages,
          tools: executableTools,
          signal: ctx.abortSignal,
          step: "step" in task ? task.step : taskDescriptor,
          input: "input" in task ? task.input : undefined,
        });
      } catch (error) {
        await emitHarnessOccurrence({
          type: "harness.model.failed",
          runId: ctx.session.runId,
          occurrenceId,
          payload: {
            callId,
            turn,
            durationMs: 0,
            error: errorEnvelope(error),
          },
          metadata: {
            stepNumber: turn,
            model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
            durationMs: 0,
            error: errorEnvelope(error),
          },
          ...occurrenceSinks(ctx),
        });
        throw error;
      }

      const output = result.output ?? result.text ?? "";
      const usage = normalizeHarnessUsage(result.usage);
      const responseText = modelResponseText(result, output);
      await emitHarnessOccurrence({
        type: "harness.model.responded",
        runId: ctx.session.runId,
        occurrenceId,
        payload: {
          callId,
          turn,
          response: {
            text: responseText,
            output,
            usage,
            ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
          },
        },
        metadata: {
          stepNumber: turn,
          model: { provider: ctx.model.providerId, modelId: ctx.model.modelId },
          text: traceContentRef(responseText),
          usage,
          ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
        },
        ...occurrenceSinks(ctx),
      });
    }

    const toolCalls = result.toolCalls ?? [];
    const hasTerminalOutput = result.output !== undefined || result.text !== undefined;
    if (hasTerminalOutput) {
      return modelLikeResultFromAiResult(task, result);
    }
    if (toolCalls.length === 0) {
      return modelLikeResultFromAiResult(task, result);
    }

    const toolResults = [];
    for (const [index, toolCall] of toolCalls.entries()) {
      const toolResult = await executeScopedToolCall(
        toolCall.toolName,
        toolCall.args,
        scope,
        index + 1,
        ctx,
        {
          caller: "model",
          turn: replayTurn,
          toolSet: executableTools,
        },
      );
      toolResults.push({
        toolName: toolCall.toolName,
        ...(toolCall.toolCallId === undefined ? {} : { toolCallId: toolCall.toolCallId }),
        result: toolResult,
      });
    }
    messages.push({
      role: "assistant",
      content: result.text ?? "",
      toolCalls,
    });
    messages.push({
      role: "tool",
      content: toolResults,
    });
  }

  throw new Error(`Workflow ${task.kind} task exceeded ${maxTurns} model turns.`);
}

function modelLikeResultFromAiResult(
  task: Exclude<WorkflowHarnessTask, { kind: "execute_step" }>,
  result: AiLoopResult,
): WorkflowHarnessResult {
  if (task.kind === "fix_step") {
    const output = result.output;
    const fixedSource = isObject(output) && typeof output.fixedSource === "string"
      ? output.fixedSource
      : "";
    const fixedOutput = isObject(output) && Object.hasOwn(output, "output") ? output.output : output;
    return {
      kind: "fix_step",
      output: fixedOutput,
      fixedSource,
      attempts: task.priorFixAttempts + 1,
    };
  }
  if (task.kind === "plan") {
    const output = result.output;
    const lwir = isObject(output) && Object.hasOwn(output, "lwir") ? output.lwir : output ?? result.text;
    return { kind: "plan", lwir };
  }
  return { kind: "orchestrate", output: result.output ?? result.text };
}

function normalizeHarnessUsage(usage: AiLoopResult["usage"] | undefined): NormalizedUsage {
  return stripUndefined({
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens,
    reasoningTokens: usage?.reasoningTokens,
  }) as NormalizedUsage;
}

function modelResponseText(result: AiLoopResult, output: unknown): string {
  const text = result.text ?? String(output);
  if (text.length > 0) {
    return text;
  }
  return (result.toolCalls?.length ?? 0) > 0 ? "[tool_calls]" : "[empty]";
}

function modelLikeSystem(
  task: Exclude<WorkflowHarnessTask, { kind: "execute_step" }>,
  ctx: WorkflowHarnessContext,
): string {
  const base = systemWithSkills(ctx.system, ctx.skills);
  if (task.kind === "plan" && typeof task.systemMessage === "string") {
    return base.length === 0
      ? task.systemMessage
      : `${base}\n\n${task.systemMessage}`;
  }
  return base;
}

function systemWithSkills(system: string | undefined, skills: readonly WorkflowSkillDescriptor[]): string {
  const skillSection = skillPromptSection(skills);
  if (skillSection === undefined) {
    return system ?? "";
  }
  if (system === undefined || system.length === 0) {
    return skillSection;
  }
  if (system.includes("<available_skills>")) {
    return system;
  }
  return `${system}\n\n${skillSection}`;
}

function skillPromptSection(skills: readonly WorkflowSkillDescriptor[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const lines = [
    "Skills are specialized instructions for specific tasks. When a task matches a skill's description, read that skill before acting and follow it. A skill lives in its own directory under .agents/skills/ - resolve any relative paths it mentions (e.g. references/, scripts/) against that directory.",
    "",
    "<available_skills>",
  ];
  for (const entry of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(entry.name)}</name>`);
    lines.push(`    <description>${escapeXml(entry.description)}</description>`);
    lines.push(`    <read>cat .agents/skills/${escapeXml(entry.name)}/SKILL.md</read>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function emitExecuteStep(
  ctx: WorkflowHarnessContext,
  type: "harness.execute_step.started" | "harness.execute_step.succeeded",
  step: WorkflowStep,
  stepContext: WorkflowStepContext,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const safeExtra = eventSafeRecord(extra);
  await emitHarnessOccurrence({
    type,
    runId: ctx.session.runId,
    payload: {
      runId: ctx.session.runId,
      stepId: step.id,
      uses: step.uses,
      stepPath: stepContext.stepPath,
      visitIndex: stepContext.visitIndex,
      ...safeExtra,
    },
    metadata: {
      runId: ctx.session.runId,
      stepId: step.id,
      uses: step.uses,
      stepPath: stepContext.stepPath,
      visitIndex: stepContext.visitIndex,
      ...safeExtra,
    },
    ...occurrenceSinks(ctx),
  });
}

function eventSafeRecord(value: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = eventSafeValue(item);
    if (key === "output" && item === undefined) {
      out.outputUndefined = true;
    }
  }
  return out as JsonObject;
}

function eventSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => eventSafeValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = eventSafeValue(item);
  }
  return out;
}

function occurrenceSinks(
  ctx: WorkflowHarnessContext,
): { durability: WorkflowHarnessDurabilitySink; trace?: WorkflowHarnessTraceSink } {
  return {
    durability: ctx.durability,
    ...(ctx.trace === undefined ? {} : { trace: ctx.trace }),
  };
}

function workflowToolRefs(tools: Readonly<Record<string, unknown>>): JsonObject[] {
  return toolRefsForDurableRequest(tools as Parameters<typeof toolRefsForDurableRequest>[0]);
}

function workflowToolsForContext(ctx: WorkflowHarnessContext): Record<string, unknown> {
  const tools = { ...ctx.tools };
  const bash = (ctx as WorkflowHarnessContext & { readonly bash?: unknown }).bash;
  if (!Object.hasOwn(tools, "bash") && bash !== undefined) {
    tools.bash = bash;
  }
  return tools;
}

function traceMessageForMetadata(message: unknown): JsonObject {
  if (isRecord(message)) {
    return {
      ...(typeof message.role === "string" ? { role: message.role } : {}),
      content: traceContentRef(Object.hasOwn(message, "content") ? message.content : message),
    };
  }
  return { content: traceContentRef(message) };
}

type StrictModelReplay<TResponse> =
  | { readonly kind: "none" }
  | {
      readonly kind: "inflight";
      readonly turn: number;
      readonly callId: string;
      readonly occurrenceId?: string;
    }
  | {
      readonly kind: "completed";
      readonly turn: number;
      readonly callId: string;
      readonly response: TResponse;
      readonly occurrenceId?: string;
    };

function findStrictModelReplay<TResponse>(
  events: readonly DurableHarnessEvent[],
  request: {
    readonly model: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly system?: string;
    readonly scope?: Record<string, unknown>;
    readonly step?: unknown;
    readonly task?: unknown;
  },
): StrictModelReplay<TResponse> {
  const replay = findModelReplay<TResponse>(events, request);
  if (replay.kind === "none") {
    return replay;
  }
  const started = findStrictModelStartedEvent(events, request, replay.callId, replay.turn);
  if (started === undefined) {
    return { kind: "none" };
  }
  return {
    ...replay,
    ...(started.occurrenceId === undefined ? {} : { occurrenceId: started.occurrenceId }),
  };
}

function findStrictModelStartedEvent(
  events: readonly DurableHarnessEvent[],
  request: unknown,
  callId: string,
  turn: number,
): DurableHarnessEvent | undefined {
  const promptHash = hashHarnessPrompt(request);
  return [...events]
    .filter((event) =>
      event.type === "harness.model.called" &&
      event.payload.promptHash === promptHash &&
      event.payload.callId === callId &&
      event.payload.turn === turn
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function findInflightToolOccurrenceId(
  events: readonly DurableHarnessEvent[],
  candidate: {
    readonly caller: "model" | "code";
    readonly toolName: string;
    readonly args: unknown;
    readonly callIndex: number;
    readonly turn?: number;
    readonly scope: Record<string, unknown>;
  },
  callId: string,
): string | undefined {
  const replayHash = hashHarnessToolCall(candidate);
  const event = [...events]
    .filter((item) =>
      item.type === "harness.tool_call.started" &&
      item.payload.callId === callId &&
      hashToolCallEvent(item) === replayHash
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  return event?.occurrenceId;
}

function hashToolCallEvent(event: DurableHarnessEvent): string | undefined {
  const caller = event.payload.caller;
  const toolName = event.payload.toolName;
  if ((caller !== "code" && caller !== "model") || typeof toolName !== "string" || !Object.hasOwn(event.payload, "args")) {
    return undefined;
  }
  const scope = isRecord(event.payload.scope) ? event.payload.scope : undefined;
  const turn = typeof event.payload.turn === "number" ? event.payload.turn : undefined;
  return hashHarnessToolCall({
    caller,
    toolName,
    args: event.payload.args,
    ...(typeof event.payload.callIndex === "number" ? { callIndex: event.payload.callIndex } : {}),
    ...(caller === "model" ? { turn: turn ?? 1 } : {}),
    ...(scope === undefined ? {} : { scope }),
  });
}

async function assertToolAllowed(
  toolName: string,
  args: unknown,
  ctx: WorkflowHarnessContext,
): Promise<void> {
  const rules = ctx.permissions?.ruleset ?? [];
  const matchingRules = rules.filter((rule) => rule.tool === toolName);
  if (matchingRules.some((rule) => rule.action === "deny")) {
    throw new Error(`Tool '${toolName}' denied by workflow permissions.`);
  }
  if (!matchingRules.some((rule) => rule.action === "ask")) {
    return;
  }
  if (ctx.permissions?.onAsk === undefined) {
    throw new Error(`Tool '${toolName}' requires approval but no approval callback is configured.`);
  }
  const approved = await ctx.permissions.onAsk({ tool: toolName, args });
  if (!approved) {
    throw new Error(`Tool '${toolName}' approval declined.`);
  }
}

function aiLoopFromAiSdkModule(aiSdkModule: AiSdkModuleLike | undefined): AiLoopAdapter | undefined {
  if (aiSdkModule === undefined) {
    return undefined;
  }
  if (typeof aiSdkModule.generateText !== "function") {
    throw new TypeError("workflowHarness aiSdkModule requires generateText.");
  }

  return {
    async generate(options): Promise<AiLoopResult> {
      const outputSpec = aiSdkOutputSpec(aiSdkModule, outputSpecForAiSdkStep(options.step));
      const request = stripUndefined({
        model: options.model,
        system: options.system,
        messages: toAiSdkMessages(options),
        tools: modelFacingTools(options.tools, aiSdkModule.jsonSchema),
        abortSignal: options.signal,
        output: outputSpec,
      });
      const rawResult = await callAiSdkGenerate(aiSdkModule, request);
      const result = isRecord(rawResult) ? rawResult : {};
      const text = safeRead(result, "text");
      const reasoning = safeRead(result, "reasoningText");
      const output = outputFromAiSdkResult(result);
      const toolCalls = toolCallsFromAiSdkRaw(result);
      const usage = normalizeAiSdkUsage(result);
      return {
        ...(output === undefined ? {} : { output }),
        ...(typeof text === "string" ? { text } : {}),
        ...(typeof reasoning === "string" && reasoning.length > 0 ? { reasoning } : {}),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

async function callAiSdkGenerate(aiSdkModule: AiSdkModuleLike, request: JsonObject): Promise<unknown> {
  if (typeof aiSdkModule.streamText === "function") {
    const stream = aiSdkModule.streamText(request);
    return resolveAiSdkStreamResult(stream);
  }
  return aiSdkModule.generateText!(request);
}

async function resolveAiSdkStreamResult(stream: unknown): Promise<JsonObject> {
  if (!isRecord(stream)) {
    throw new TypeError("workflowHarness aiSdkModule.streamText did not return an object.");
  }
  return stripUndefined({
    text: await settleValue(stream.text),
    reasoningText: await settleValue(stream.reasoningText),
    toolCalls: await settleValue(stream.toolCalls),
    output: await settleValue(stream.output),
    object: await settleValue(stream.object),
    usage: await settleValue(stream.usage),
    totalUsage: await settleValue(stream.totalUsage),
    finishReason: await settleValue(stream.finishReason),
    providerMetadata: await settleValue(stream.providerMetadata),
  });
}

function settleValue(value: unknown): Promise<unknown> {
  return Promise.resolve(value).then((resolved) => resolved, () => undefined);
}

function outputSpecForAiSdkStep(step: unknown): JsonObject {
  if (isRecord(step)) {
    const output = step.output;
    if (isRecord(output) && typeof output.mode === "string") {
      return output;
    }
    if (step.kind === "plan") {
      return {
        mode: "object",
        schema: { type: "object", additionalProperties: true },
        name: "lwir",
      };
    }
    if (step.kind === "orchestrate") {
      return { mode: "text" };
    }
  }
  return { mode: "text" };
}

function aiSdkOutputSpec(aiSdkModule: AiSdkModuleLike, output: JsonObject): unknown {
  const mode = typeof output.mode === "string" ? output.mode : "text";
  if (mode === "text") {
    return requiredAiSdkOutputHelper(aiSdkModule, "text")();
  }
  if (mode === "choice") {
    return requiredAiSdkOutputHelper(aiSdkModule, "choice")(stripUndefined({
      options: Array.isArray(output.values) ? output.values : undefined,
      name: output.name,
      description: output.description,
    }));
  }
  if (mode === "json") {
    return requiredAiSdkOutputHelper(aiSdkModule, "json")(stripUndefined({
      name: output.name,
      description: output.description,
    }));
  }
  return requiredAiSdkOutputHelper(aiSdkModule, "object")(stripUndefined({
    schema: wrapAiSdkJsonSchema(aiSdkModule, output.schema),
    name: output.name,
    description: output.description,
  }));
}

function requiredAiSdkOutputHelper(
  aiSdkModule: AiSdkModuleLike,
  name: "text" | "object" | "array" | "choice" | "json",
): AiSdkOutputHelper {
  const helper = aiSdkModule.Output?.[name];
  if (typeof helper !== "function") {
    throw new TypeError(`workflowHarness aiSdkModule requires Output.${name}.`);
  }
  return helper;
}

function wrapAiSdkJsonSchema(aiSdkModule: AiSdkModuleLike, schema: unknown): unknown {
  if (typeof aiSdkModule.jsonSchema !== "function" || !isPlainJsonSchemaObject(schema)) {
    return schema;
  }
  return aiSdkModule.jsonSchema(schema);
}

function modelFacingTools(
  tools: Record<string, unknown>,
  jsonSchemaHelper: ((schema: unknown) => unknown) | undefined,
): Record<string, unknown> {
  const facing: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isRecord(tool)) {
      facing[name] = tool;
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tool)) {
      if (key === "execute") {
        continue;
      }
      if ((key === "inputSchema" || key === "outputSchema") && isPlainJsonSchemaObject(value)) {
        next[key] = jsonSchemaHelper === undefined ? value : jsonSchemaHelper(value);
        continue;
      }
      next[key] = value;
    }
    facing[name] = next;
  }
  return facing;
}

function toAiSdkMessages(options: Parameters<AiLoopAdapter["generate"]>[0]): readonly JsonObject[] {
  const configuredPrompt = stringProperty(propertyValue(options.step, "with"), "prompt");
  const messages: JsonObject[] = [];
  let userSeen = false;

  for (const raw of options.messages) {
    const role = stringProperty(raw, "role");
    const content = propertyValue(raw, "content");

    if (role === "assistant") {
      const toolCalls = arrayProperty(raw, "toolCalls") ?? arrayProperty(content, "toolCalls");
      if (toolCalls !== undefined) {
        messages.push({
          role: "assistant",
          content: toolCalls.map((toolCall, index) => ({
            type: "tool-call",
            toolCallId: stringProperty(toolCall, "toolCallId") ?? `call_${index + 1}`,
            toolName: stringProperty(toolCall, "toolName") ?? "tool",
            input: propertyValue(toolCall, "args") ?? {},
          })),
        });
      } else {
        messages.push({ role: "assistant", content: jsonForPrompt(content) });
      }
      continue;
    }

    if (role === "tool") {
      const entries = Array.isArray(content) ? content : [content];
      messages.push({
        role: "tool",
        content: entries.map((entry, index) => ({
          type: "tool-result",
          toolCallId: stringProperty(entry, "toolCallId") ?? `call_${index + 1}`,
          toolName: stringProperty(entry, "toolName") ?? "tool",
          output: { type: "json", value: propertyValue(entry, "result") ?? null },
        })),
      });
      continue;
    }

    const base = jsonForPrompt(content);
    const text = !userSeen && configuredPrompt !== undefined
      ? `${configuredPrompt}\n\nInput:\n${base}`
      : base;
    userSeen = true;
    messages.push({ role: "user", content: text });
  }

  return messages;
}

function outputFromAiSdkResult(result: Record<string, unknown>): unknown {
  if (Object.hasOwn(result, "output")) {
    return safeRead(result, "output");
  }
  if (Object.hasOwn(result, "object")) {
    return safeRead(result, "object");
  }
  if (Object.hasOwn(result, "text")) {
    return safeRead(result, "text");
  }
  return undefined;
}

function toolCallsFromAiSdkRaw(raw: Record<string, unknown>): AiLoopResult["toolCalls"] | undefined {
  const candidate = safeRead(raw, "toolCalls");
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  const toolCalls: Array<NonNullable<AiLoopResult["toolCalls"]>[number]> = [];
  for (const [index, rawToolCall] of candidate.entries()) {
    const toolName = stringProperty(rawToolCall, "toolName");
    if (toolName === undefined) {
      continue;
    }
    toolCalls.push({
      toolName,
      args: propertyValue(rawToolCall, "args") ?? propertyValue(rawToolCall, "input"),
      toolCallId: stringProperty(rawToolCall, "toolCallId") ?? `call_${index + 1}`,
    });
  }
  return toolCalls.length === 0 ? undefined : toolCalls;
}

function normalizeAiSdkUsage(result: Record<string, unknown>): AiLoopResult["usage"] | undefined {
  const usage = isRecord(result.totalUsage) ? result.totalUsage : result.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  return stripUndefined({
    inputTokens: numberValue(usage.inputTokens, usage.promptTokens),
    outputTokens: numberValue(usage.outputTokens, usage.completionTokens),
    cachedInputTokens: numberValue(
      usage.cachedInputTokens,
      nestedNumber(usage, "inputTokenDetails", "cachedTokens"),
      nestedNumber(usage, "promptTokensDetails", "cachedTokens"),
    ),
    reasoningTokens: numberValue(
      nestedNumber(usage, "outputTokenDetails", "reasoningTokens"),
      usage.reasoningTokens,
      nestedNumber(usage, "completionTokensDetails", "reasoningTokens"),
    ),
  }) as AiLoopResult["usage"];
}

function nestedNumber(record: Record<string, unknown>, outer: string, inner: string): unknown {
  const nested = record[outer];
  return isRecord(nested) ? nested[inner] : undefined;
}

function numberValue(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function safeRead(result: Record<string, unknown>, key: string): unknown {
  try {
    return result[key];
  } catch {
    return undefined;
  }
}

function propertyValue(value: unknown, key: string): unknown {
  return isObject(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = propertyValue(value, key);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function arrayProperty(value: unknown, key: string): readonly unknown[] | undefined {
  const candidate = propertyValue(value, key);
  return Array.isArray(candidate) ? candidate : undefined;
}

function jsonForPrompt(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isPlainJsonSchemaObject(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if ((schema as Record<symbol, unknown>)[Symbol.for("vercel.ai.schema")] === true) {
    return false;
  }
  if (typeof (schema as { parse?: unknown }).parse === "function") {
    return false;
  }
  if (typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    return false;
  }
  const jsonSchemaKeys = [
    "$ref",
    "$defs",
    "type",
    "properties",
    "items",
    "required",
    "additionalProperties",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
  ];
  return jsonSchemaKeys.some((key) => Object.hasOwn(schema, key));
}

function toolCallScopeForStepContext(stepContext: WorkflowStepContext): Record<string, unknown> {
  return stripUndefined({
    ...(isRecord(stepContext.toolCallScope) ? stepContext.toolCallScope : {}),
    stepPath: stepContext.stepPath,
    visitIndex: stepContext.visitIndex,
    attempt: stepContext.attempt,
  });
}

function runtimeToolExecutionContext(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function runtimeToolContextString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function runtimeToolContextNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function runtimeToolContextSignal(value: unknown): AbortSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.signal instanceof AbortSignal ? value.signal : undefined;
}

function stripUndefined(value: Record<string, unknown>): JsonObject {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result as JsonObject;
}

function traceContentRef(value: unknown): JsonObject {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const preview = text === undefined ? "" : text.slice(0, 200);
  return {
    captured: true,
    preview,
    truncated: text !== undefined && text.length > preview.length,
    bytes: new TextEncoder().encode(text ?? "").byteLength,
    sha256: sha256Hex(text ?? ""),
  };
}

function errorEnvelope(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "NonError", message: String(error) };
}

function errorFromReplayEnvelope(value: unknown): Error {
  const envelope = isObject(value) ? value : {};
  const error = new Error(typeof envelope.message === "string" ? envelope.message : "Workflow tool call failed.");
  error.name = typeof envelope.name === "string" ? envelope.name : "Error";
  return Object.assign(error, envelope);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workflow harness task: ${JSON.stringify(value)}`);
}
