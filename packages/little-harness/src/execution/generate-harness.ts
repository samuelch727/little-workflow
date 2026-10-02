import {
  generateText,
  isStepCount,
  type ModelMessage,
  type Output,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  findModelReplay,
  findSingleCompletedModelReplay,
  findToolReplay,
  type DurableHarnessEvent,
  type ModelReplay,
  type ToolReplay,
} from "../events/durability.js";
import type { HarnessSessionLog, TraceHarnessEventInput } from "../events/occurrence.js";
import { emitHarnessOccurrence } from "../events/occurrence.js";
import { HarnessInputError } from "../errors.js";
import { createEventId, createTurnId } from "../ids.js";
import type { ResolvedHarnessMcpGateway } from "../mcp.js";
import { buildModelMessages, type BuildModelMessagesOptions } from "../runtime/messages.js";
import { abstractToolHiddenWarning, partitionExecutableTools } from "./abstract-tools.js";
import { assembleTurnTools, disposeTurnRuntime } from "./turn-tools.js";
import { harnessToolExecutionEnd, harnessToolExecutionStart } from "./tool-execution-events.js";
import { wrapToolsWithHarnessContext } from "../runtime/tools.js";
import { resolveTraceOptions } from "../trace/options.js";
import { sanitizeTraceValue } from "../trace/redaction.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import { validateTraceEvent } from "../trace/validate.js";
import type {
  Harness,
  HarnessAgentOptions,
  HarnessEvent,
  HarnessRuntime,
  HarnessRuntimeOptions,
  HarnessSession,
  HarnessToolExecutionContext,
  HarnessWarning,
  JsonObject,
  PersistenceError,
  PreparedTurn,
} from "../types.js";
import { createArtifactAccessor, createEventedFileWriter } from "./evented-file-writer.js";
import {
  durableModelRequest,
  modelCalledEventData,
  modelFailedEventData,
  modelRespondedEventData,
  toolRefsForDurableRequest,
} from "./model-events.js";
import { modelRequestSettings } from "./model-request-settings.js";
import { emitMountedFiles } from "./mount-events.js";
import type { GenerateHarnessResult, HarnessCompletedResult, HarnessParkedResult } from "./result.js";
import { parkedResultFromSteps, parkedThisStep } from "./park-resume.js";
import { stageChatMessages, type StageChatMessagesOptions } from "./stage-message.js";
import { toolCallEventData } from "./tool-events.js";

export type GenerateHarnessOptions<TInput = unknown, TExtraBody = unknown, TOutput = unknown> =
  HarnessAgentOptions & {
    harness: Harness<any, TExtraBody>;
    messages?: UIMessage[];
    type?: string;
    input?: TInput;
    session?: string | HarnessSession;
    extraBody?: TExtraBody;
    output?: Output.Output<TOutput>;
    abortSignal?: AbortSignal;
    restage?: boolean;
    runId?: string;
    /** The session log (durable event log) this run appends to and replays from. */
    sessionLog?: HarnessSessionLog;
    /** Historical alias of `sessionLog`; `sessionLog` wins when both are set. */
    durability?: HarnessSessionLog;
    onTraceError?: (error: unknown, event: TraceHarnessEventInput) => Promise<void> | void;
    onEvent?: (event: HarnessEvent) => void | Promise<void>;
    onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
  };

type PreparedTurnEvent = Omit<HarnessEvent, "timestamp" | "sessionId"> & { payload?: JsonObject };
type EventModel = Parameters<typeof generateText>[0]["model"] | { provider?: string; modelId?: string };
type StartedModelStep = {
  stepNumber: number;
  callId: string;
  occurrenceId: string;
  model: EventModel;
  startedAt: number;
};
type ToolReplayState = {
  replay: ToolReplay;
  callId?: string;
  occurrenceId: string;
};

export async function generateHarness<
  TOutput = string,
  TInput = unknown,
  TExtraBody = unknown,
>(
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): Promise<GenerateHarnessResult<TOutput>> {
  const config = resolveTurnConfig(options.harness.config, options);
  const session =
    typeof options.session === "object"
      ? options.session
      : await getOrCreateSession(options.harness, options.session, options.extraBody);
  const turnId = createTurnId();
  const runId = options.runId ?? createEventId();
  const durability =
    options.sessionLog ?? options.durability ?? config.sessionLog ?? config.durability;
  const onTraceError = options.onTraceError ?? config.onTraceError;
  const priorEvents = await durability?.priorEvents?.({ runId }) ?? [];

  return config.host.runExclusive(session, { turnId }, async () => {
    let prepared: PreparedTurn<TExtraBody> | undefined;
    let resolvedMcp: ResolvedHarnessMcpGateway | undefined;
    let turnRuntime: HarnessRuntime | undefined;
    // The turn emitter is built inside the try (it needs `prepared`), but the `finally`
    // that disposes the runtime has to report a disposal failure through it.
    let emitTurnEventForDispose:
      | ((event: PreparedTurnEvent) => Promise<void>)
      | undefined;
    let turnFailed = false;
    let callbackSequence = 0;
    let lastStartedModelStep: StartedModelStep | undefined;
    // AI SDK 7 tool-execution events omit the step number; track the step the model is on.
    let currentModelStepNumber: number | undefined;
    const modelSteps = new Map<number, StartedModelStep>();
    const toolOccurrences = new Map<string, string>();
    const toolReplayStates = new Map<string, ToolReplayState>();
    const nextCallbackSequence = () => {
      callbackSequence += 1;
      return callbackSequence;
    };
    try {
      await setSessionState(session, "running");
      prepared = await config.host.prepareTurn({
        session,
        turnId,
        persistentDirs: config.persistentDirs,
        extraBody: options.extraBody,
      });

      const traceOptions = resolveTraceOptions(config.trace, options.trace);
      const warnings: HarnessWarning[] = [];
      const emitTurnEvent = (event: PreparedTurnEvent) =>
        emitHarnessEvent(
          prepared!,
          session,
          withTurnId(event, turnId),
          traceOptions,
          nextCallbackSequence,
          options,
          { runId, durability, onTraceError },
        );
      emitTurnEventForDispose = emitTurnEvent;
      const agentFiles = createEventedFileWriter(prepared.files, emitTurnEvent, {
        defaultSource: "agent",
        traceOptions,
      });
      await emitTurnEvent({
        type: "harness.session.started",
        turnId,
        payload: { sessionId: session.id, turnId },
      });
      await prepared.loadPersistentDirs({ emit: emitTurnEvent });

      // Abstract tools (declared without an execute) are structural placeholders that become live
      // only on a connector that implements them; they must never be offered to the model on a
      // plain run. Filter them here so the documented rule holds for generateHarness too, mirroring
      // the connector loader's resolveConnectorTools behavior.
      const { executable: modelTools, hidden: hiddenAbstractTools } =
        partitionExecutableTools(config.tools as ToolSet);
      for (const hiddenTool of Object.keys(hiddenAbstractTools)) {
        warnings.push(abstractToolHiddenWarning(hiddenTool));
      }
      // Durable refs for the hidden abstract tools, in the same shape `durableModelRequest` records.
      // Threaded into `findModelReplay` so it can reconstruct a pre-abstract-filter recording's hash.
      const hiddenAbstractToolRefs = toolRefsForDurableRequest(hiddenAbstractTools);

      if (config.mcp !== undefined && options.prepareStep === undefined) {
        const replayedOutput = replayedSimpleModelOutput<TOutput>(
          findSingleCompletedModelReplay(priorEvents as readonly DurableHarnessEvent[]),
          options.output,
        );
        if (replayedOutput !== undefined) {
          const persistence = await prepared.commitPersistentDirs({ emit: emitTurnEvent });
          if (persistence.status === "failed") {
            const error: PersistenceError = { session, failedCommits: persistence.failedCommits };
            await config.onPersistenceError?.(error);
            await options.onPersistenceError?.(error);
          }

          await emitTurnEvent({
            type: "harness.session.completed",
            turnId,
            payload: { sessionId: session.id, turnId },
          });
          await setSessionState(session, "idle");

          return {
            status: "completed",
            text: replayedOutput.text,
            output: replayedOutput.output,
            session,
            artifacts: await session.artifacts.list(),
            trace: prepared.trace,
            persistence,
            commitManual: createManualCommit(prepared, session, emitTurnEvent, options),
            warnings,
          };
        }
      }

      const assembled = await assembleTurnTools({
        config,
        baseTools: modelTools,
        session,
        turnId,
        orchestration: prepared.orchestration ?? config.host.durable,
        abortSignal: options.abortSignal,
      });
      resolvedMcp = assembled.mcp;
      const { resolvedSkills, turnTools } = assembled;
      warnings.push(...assembled.warnings);
      await prepared.stageSkills(resolvedSkills);

      const staging = options.messages
        ? await stageChatMessages(
            stageOptions(options.messages, session, agentFiles, emitTurnEvent, config, options),
          )
        : { notices: [], stagedMessageIds: [], stripStagedFileParts: false };

      const built = await buildModelMessages({
        harness: options.harness,
        config,
        session,
        files: agentFiles,
        stagingNotices: staging.notices,
        stripStagedFileParts: staging.stripStagedFileParts,
        resolvedSkills,
        ...messageInputOptions(options),
      });
      warnings.push(...built.warnings);
      await emitMountedFiles(prepared.files, emitTurnEvent, { persistentDirs: config.persistentDirs });

      const toolFiles = createEventedFileWriter(prepared.files, emitTurnEvent, {
        defaultSource: "tool",
        traceOptions,
      });
      const toolContext: HarnessToolExecutionContext<TExtraBody> = {
        session,
        files: toolFiles,
        artifacts: createArtifactAccessor(toolFiles, session.artifacts),
        toolReplay: {
          get: (toolCallId) => toolCallId === undefined ? undefined : toolReplayStates.get(toolCallId),
        },
      };
      if (options.extraBody !== undefined) {
        toolContext.extraBody = options.extraBody;
      }
      if (options.abortSignal !== undefined) {
        toolContext.abortSignal = options.abortSignal;
      }
      const toolResultSpooling =
        options.toolResultSpooling !== undefined
          ? options.toolResultSpooling
          : config.toolResultSpooling;
      if (toolResultSpooling !== undefined) {
        toolContext.toolResultSpooling = toolResultSpooling;
      }
      const runtimeToolContext: HarnessToolExecutionContext<TExtraBody> = {
        ...toolContext,
        files: prepared.files,
        artifacts: createArtifactAccessor(prepared.files, session.artifacts),
      };
      const runtime = await prepared.createRuntime({
        ...runtimeOptions(config, options, turnTools),
        toolContext: runtimeToolContext,
        runtimeToolReplay: {
          find: (candidate) => findToolReplay(priorEvents as readonly DurableHarnessEvent[], candidate),
        },
        emit: emitTurnEvent,
        emitToolEvents: false,
        traceOptions,
      });
      turnRuntime = runtime;
      const tools = wrapToolsWithHarnessContext(
        toolsForModel(turnTools, runtime, config.runtime),
        toolContext,
      );

      const prepareStep = runtimeAwarePrepareStep(
        options.prepareStep,
        built.system,
        runtime,
        options.activeTools,
      );
      const system = prepareStep === undefined
        ? runtimeSystem(built.system, runtime, options.activeTools)
        : built.system;
      const outputSpec = options.output ?? (built.output as Output.Output<TOutput> | undefined);
      const firstModelReplay =
        options.prepareStep === undefined
          ? findModelReplay(
              priorEvents as readonly DurableHarnessEvent[],
              durableModelRequest({
                stepNumber: 1,
                callId: "replay_probe",
                model: config.model,
                system,
                messages: built.messages,
                tools,
                files: prepared.files,
              traceOptions,
              settings: modelRequestSettings(options),
            }),
              hiddenAbstractToolRefs,
          )
          : ({ kind: "none" } as const);
      const replayedOutput = replayedSimpleModelOutput<TOutput>(firstModelReplay, outputSpec);
      if (replayedOutput !== undefined) {
        const persistence = await prepared.commitPersistentDirs({ emit: emitTurnEvent });
        if (persistence.status === "failed") {
          const error: PersistenceError = { session, failedCommits: persistence.failedCommits };
          await config.onPersistenceError?.(error);
          await options.onPersistenceError?.(error);
        }

        await emitTurnEvent({
          type: "harness.session.completed",
          turnId,
          payload: { sessionId: session.id, turnId },
        });
        await setSessionState(session, "idle");

        return {
          status: "completed",
          text: replayedOutput.text,
          output: replayedOutput.output,
          session,
          artifacts: await session.artifacts.list(),
          trace: prepared.trace,
          persistence,
          commitManual: createManualCommit(prepared, session, emitTurnEvent, options),
          warnings,
        };
      }
      const result = await callGenerateText({
        model: config.model,
        system,
        messages: built.messages,
        tools,
        output: outputSpec,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        stopWhen: stopWhenWithPark(options.stopWhen ?? isStepCount(config.workflowBudgets?.maxModelSteps ?? 20)),
        prepareStep,
        toolChoice: options.toolChoice,
        activeTools: options.activeTools,
        providerOptions: options.providerOptions,
        headers: options.headers,
        maxRetries: options.maxRetries,
        onStepStart: async (event) => {
          const stepNumber = eventStepNumber(event);
          currentModelStepNumber = stepNumber;
          const model = eventModel(event, config.model);
          const eventSystemValue = eventSystem(event, system);
          const eventMessagesValue = eventMessages(event, built.messages);
          const eventToolsValue = eventTools(event, tools);
          const settings = modelRequestSettings(options, event);
          const stepReplay = findModelReplay(
            priorEvents as readonly DurableHarnessEvent[],
            durableModelRequest({
              stepNumber: stepNumber + 1,
              callId: "replay_probe",
              model,
              system: eventSystemValue,
              messages: eventMessagesValue,
              tools: eventToolsValue,
              files: prepared!.files,
              traceOptions,
              settings,
            }),
            hiddenAbstractToolRefs,
          );
          const inflightReplay = stepReplay.kind === "inflight" ? stepReplay : undefined;
          const callId = inflightReplay?.callId ?? createEventId();
          const occurrenceId =
            inflightReplay === undefined
              ? createEventId()
              : modelOccurrenceIdFor(priorEvents as readonly DurableHarnessEvent[], inflightReplay.callId) ?? createEventId();
          lastStartedModelStep = {
            stepNumber: inflightReplay?.turn ?? stepNumber + 1,
            callId,
            occurrenceId,
            model,
            startedAt: Date.now(),
          };
          modelSteps.set(stepNumber, lastStartedModelStep);
          if (inflightReplay !== undefined) {
            return;
          }
          const eventData = await modelCalledEventData({
            callId,
            stepNumber: stepNumber + 1,
            model,
            system: eventSystemValue,
            messages: eventMessagesValue,
            tools: eventToolsValue,
            files: prepared!.files,
            traceOptions,
            settings,
          });
          await emitTurnEvent({
            type: "harness.model.called",
            occurrenceId,
            stepId: stepIdFor(stepNumber),
            payload: eventData.payload,
            metadata: eventData.metadata,
          });
        },
        onStepEnd: async (event) => {
          const stepNumber = eventStepNumber(event);
          const started = modelSteps.get(stepNumber) ?? {
            stepNumber: stepNumber + 1,
            callId: createEventId(),
            occurrenceId: createEventId(),
            model: eventModel(event, config.model),
            startedAt: Date.now(),
          };
          modelSteps.set(stepNumber, started);
          const eventData = await modelRespondedEventData({
            callId: started.callId,
            stepNumber: stepNumber + 1,
            model: eventModel(event, config.model),
            result: event,
            text: eventText(event),
            files: prepared!.files,
            traceOptions,
          });
          await emitTurnEvent({
            type: "harness.model.responded",
            occurrenceId: started.occurrenceId,
            stepId: stepIdFor(stepNumber),
            payload: eventData.payload,
            metadata: eventData.metadata,
          });
        },
        onToolExecutionStart: async (toolEvent) => {
          const event = harnessToolExecutionStart(toolEvent, currentModelStepNumber);
          const replay = toolReplayForEvent(priorEvents as readonly DurableHarnessEvent[], event);
          const callId = replay.kind === "inflight" ? replay.callId : event.toolCall.toolCallId;
          const occurrenceId =
            replay.kind === "none"
              ? toolOccurrenceId(event)
              : toolOccurrenceIdFor(priorEvents as readonly DurableHarnessEvent[], callId) ?? toolOccurrenceId(event);
          toolReplayStates.set(event.toolCall.toolCallId, { replay, callId, occurrenceId });
          if (replay.kind !== "none") {
            return;
          }
          const eventData = await toolCallEventData(
            { ...event, caller: "model" },
            prepared!.files,
            traceOptions,
          );
          return emitTurnEvent({
            type: "harness.tool_call.started",
            occurrenceId,
            payload: eventData.payload,
            metadata: eventData.metadata,
          });
        },
        onToolExecutionEnd: async (toolEnd) => {
          const event = harnessToolExecutionEnd(toolEnd, currentModelStepNumber);
          const state = toolReplayStates.get(event.toolCall.toolCallId);
          if (state?.replay.kind === "completed" || state?.replay.kind === "failed") {
            return;
          }
          const occurrenceId = state?.occurrenceId ?? toolOccurrenceId(event);
          const toolEvent = state?.replay.kind === "inflight" && state.callId !== undefined
            ? toolEventWithCallId(event, state.callId)
            : event;
          const eventData = await toolCallEventData(
            { ...toolEvent, caller: "model" },
            prepared!.files,
            traceOptions,
          );
          return emitTurnEvent({
            type: event.success ? "harness.tool_call.succeeded" : "harness.tool_call.failed",
            occurrenceId,
            payload: eventData.payload,
            metadata: eventData.metadata,
          });
        },
      });
      warnings.push(...providerWarnings(result.warnings));
      const parked = parkedResultFromSteps(result.steps);

      const persistence = await prepared.commitPersistentDirs({ emit: emitTurnEvent });
      if (persistence.status === "failed") {
        const error: PersistenceError = { session, failedCommits: persistence.failedCommits };
        await config.onPersistenceError?.(error);
        await options.onPersistenceError?.(error);
      }

      await emitTurnEvent({
        type: "harness.session.completed",
        turnId,
        payload: { sessionId: session.id, turnId },
      });
      await setSessionState(session, "idle");

      if (parked !== undefined) {
        return {
          ...parked,
          session,
          artifacts: await session.artifacts.list(),
          trace: prepared.trace,
          warnings,
        } as unknown as GenerateHarnessResult<TOutput>;
      }

      const output = outputSpec === undefined ? (result.text as TOutput) : (result.output as TOutput);
      return {
        status: "completed",
        text: result.text,
        output,
        session,
        artifacts: await session.artifacts.list(),
        trace: prepared.trace,
        persistence,
        commitManual: createManualCommit(prepared, session, emitTurnEvent, options),
        warnings,
      };
    } catch (error) {
      turnFailed = true;
      // Failure bookkeeping must never mask the root error: with a remote durability sink,
      // the sink itself may be what failed, and these emits would fail the same way.
      try {
        await setSessionState(session, "failed");
      } catch {
        // Preserve the original turn failure.
      }
      if (prepared) {
        const traceOptions = resolveTraceOptions(options.harness.config.trace, options.trace);
        try {
          if (lastStartedModelStep) {
            await emitHarnessEvent(
              prepared,
              session,
              {
                type: "harness.model.failed",
                occurrenceId: lastStartedModelStep.occurrenceId,
                turnId,
                stepId: stepIdFor(lastStartedModelStep.stepNumber - 1),
                ...modelFailedEventData({
                  callId: lastStartedModelStep.callId,
                  stepNumber: lastStartedModelStep.stepNumber,
                  model: lastStartedModelStep.model,
                  durationMs: Date.now() - lastStartedModelStep.startedAt,
                  error,
                }),
              },
              traceOptions,
              nextCallbackSequence,
              options,
              { runId, durability, onTraceError },
            );
          }
          await emitHarnessEvent(
            prepared,
            session,
            {
              type: "harness.session.failed",
              turnId,
              payload: { sessionId: session.id, turnId, error: error instanceof Error ? error.message : String(error) },
              metadata: { error: error instanceof Error ? error.message : String(error) },
            },
            traceOptions,
            nextCallbackSequence,
            options,
            { runId, durability, onTraceError },
          );
        } catch {
          // Preserve the original turn failure.
        }
      }
      throw error;
    } finally {
      // Dispose the environment first: closing MCP can throw on the success path, and the
      // sandbox child process must be reaped regardless.
      await disposeTurnRuntime(turnRuntime, emitTurnEventForDispose);
      await closeResolvedMcpGateway(resolvedMcp, { suppressErrors: turnFailed });
    }

    function toolOccurrenceId(event: { toolCall: { toolCallId: string } }): string {
      const existing = toolOccurrences.get(event.toolCall.toolCallId);
      if (existing !== undefined) {
        return existing;
      }
      const occurrenceId = createEventId();
      toolOccurrences.set(event.toolCall.toolCallId, occurrenceId);
      return occurrenceId;
    }
  });
}

async function closeResolvedMcpGateway(
  resolvedMcp: ResolvedHarnessMcpGateway | undefined,
  options: { suppressErrors: boolean },
): Promise<void> {
  if (resolvedMcp === undefined) {
    return;
  }
  if (!options.suppressErrors) {
    await resolvedMcp.close();
    return;
  }
  try {
    await resolvedMcp.close();
  } catch {
    // Preserve the original turn failure.
  }
}

function toolReplayForEvent(
  events: readonly DurableHarnessEvent[],
  event: { stepNumber?: number | undefined; toolCall: { toolName: string; input?: unknown } },
): ToolReplay {
  if (!("input" in event.toolCall)) {
    return { kind: "none" };
  }
  return findToolReplay(events, {
    caller: "model",
    toolName: event.toolCall.toolName,
    args: event.toolCall.input,
    ...(event.stepNumber === undefined ? {} : { turn: event.stepNumber + 1 }),
  });
}

function toolOccurrenceIdFor(
  events: readonly DurableHarnessEvent[],
  callId: string | undefined,
): string | undefined {
  if (callId === undefined) {
    return undefined;
  }
  return events.find((event) =>
    event.type === "harness.tool_call.started" &&
    isObject(event.payload) &&
    event.payload.callId === callId
  )?.occurrenceId;
}

function toolEventWithCallId<TEvent extends { toolCall: { toolCallId: string } }>(
  event: TEvent,
  callId: string,
): TEvent {
  return {
    ...event,
    toolCall: {
      ...event.toolCall,
      toolCallId: callId,
    },
  };
}

function replayedSimpleModelOutput<TOutput>(
  replay: ModelReplay<unknown>,
  outputSpec: Output.Output<TOutput> | undefined,
): { text: string; output: TOutput } | undefined {
  if (replay.kind !== "completed" || !isObject(replay.response)) {
    return undefined;
  }
  if (Array.isArray(replay.response.toolCalls) && replay.response.toolCalls.length > 0) {
    return undefined;
  }
  if (typeof replay.response.text !== "string") {
    return undefined;
  }
  if (outputSpec === undefined) {
    return { text: replay.response.text, output: replay.response.text as TOutput };
  }
  if (!("output" in replay.response)) {
    return undefined;
  }
  return { text: replay.response.text, output: replay.response.output as TOutput };
}

function modelOccurrenceIdFor(
  events: readonly DurableHarnessEvent[],
  callId: string,
): string | undefined {
  return events.find((event) =>
    event.type === "harness.model.called" &&
    isObject(event.payload) &&
    event.payload.callId === callId
  )?.occurrenceId;
}

function stageOptions<TInput, TExtraBody, TOutput>(
  messages: UIMessage[],
  session: HarnessSession,
  files: PreparedTurn<TExtraBody>["files"],
  emit: (event: PreparedTurnEvent) => Promise<void>,
  config: Harness<any, TExtraBody>["config"],
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): StageChatMessagesOptions<TExtraBody> {
  const out: StageChatMessagesOptions<TExtraBody> = {
    messages,
    session,
    files,
    emit,
    traceOptions: resolveTraceOptions(config.trace, options.trace),
  };
  if (config.chat !== undefined) {
    out.chat = config.chat;
  }
  if (options.extraBody !== undefined) {
    out.extraBody = options.extraBody;
  }
  if (options.abortSignal !== undefined) {
    out.abortSignal = options.abortSignal;
  }
  if (options.restage !== undefined) {
    out.restage = options.restage;
  }
  return out;
}

function messageInputOptions<TInput, TExtraBody, TOutput>(
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): Pick<
  BuildModelMessagesOptions<TExtraBody>,
  "messages" | "type" | "input" | "extraBody"
> {
  const out: Pick<
    BuildModelMessagesOptions<TExtraBody>,
    "messages" | "type" | "input" | "extraBody"
  > = {};
  if (options.messages !== undefined) {
    out.messages = options.messages;
  }
  if (options.type !== undefined) {
    out.type = options.type;
  }
  if (options.input !== undefined) {
    out.input = options.input;
  }
  if (options.extraBody !== undefined) {
    out.extraBody = options.extraBody;
  }
  return out;
}

function runtimeOptions<TInput, TExtraBody, TOutput>(
  config: Harness<any, TExtraBody>["config"],
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
  tools: ToolSet,
): Parameters<PreparedTurn<TExtraBody>["createRuntime"]>[0] {
  const out: Parameters<PreparedTurn<TExtraBody>["createRuntime"]>[0] = {
    tools,
  };
  const runtime = resolveRuntimeOptions(config.runtime, options.runtime);
  if (runtime !== undefined) {
    out.runtime = runtime;
  }
  if (options.extraBody !== undefined) {
    out.extraBody = options.extraBody;
  }
  if (options.abortSignal !== undefined) {
    out.abortSignal = options.abortSignal;
  }
  return out;
}

function resolveTurnConfig<TInput, TExtraBody, TOutput>(
  config: Harness<any, TExtraBody>["config"],
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): Harness<any, TExtraBody>["config"] {
  const model = (options.model ?? config.model) as Harness<any, TExtraBody>["config"]["model"] | undefined;
  if (model === undefined) {
    throw new HarnessInputError(
      "Little Harness model is required. Provide model to createHarness(...) or to this harness call.",
      { option: "model" },
    );
  }

  const out: Harness<any, TExtraBody>["config"] = {
    ...config,
    model,
  };
  if (options.system !== undefined) {
    out.system = options.system;
  }
  const runtime = resolveRuntimeOptions(config.runtime, options.runtime);
  if (runtime !== undefined) {
    out.runtime = runtime;
  }
  return out;
}

function resolveRuntimeOptions(
  configRuntime: HarnessRuntimeOptions | undefined,
  optionsRuntime: HarnessRuntimeOptions | undefined,
): HarnessRuntimeOptions | undefined {
  if (configRuntime === undefined) {
    return optionsRuntime;
  }
  if (optionsRuntime === undefined) {
    return configRuntime;
  }
  return { ...configRuntime, ...optionsRuntime };
}

function toolsForModel(
  tools: ToolSet,
  runtime: { shellTool(): ToolSet[string] },
  runtimeOptions: HarnessRuntimeOptions | undefined,
): ToolSet {
  if (runtimeOptions?.bash === false) {
    return { ...tools };
  }
  return { ...tools, bash: runtime.shellTool() };
}

function stopWhenWithPark(stopWhen: Parameters<typeof generateText>[0]["stopWhen"]): Parameters<typeof generateText>[0]["stopWhen"] {
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen ?? isStepCount(20)];
  return [...conditions, parkedThisStep];
}

function runtimeSystem(
  system: string,
  runtime: Pick<HarnessRuntime, "systemHints">,
  activeTools: readonly string[] | undefined,
): string {
  return systemWithRuntimeHints(system, runtime.systemHints({ activeTools })) as string;
}

function runtimeAwarePrepareStep(
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"],
  baseSystem: string,
  runtime: Pick<HarnessRuntime, "systemHints">,
  activeTools: readonly string[] | undefined,
): Parameters<typeof generateText>[0]["prepareStep"] {
  if (prepareStep === undefined) {
    return undefined;
  }

  return (async (event: Parameters<NonNullable<Parameters<typeof generateText>[0]["prepareStep"]>>[0]) => {
    const result = await prepareStep(event as never);
    const resultRecord = isObject(result) ? result : {};
    return {
      ...resultRecord,
      system: systemWithRuntimeHints(
        resultRecord.system !== undefined ? resultRecord.system : baseSystem,
        runtime.systemHints({
          activeTools: prepareStepActiveTools(resultRecord, activeTools),
        }),
      ),
    };
  }) as Parameters<typeof generateText>[0]["prepareStep"];
}

function prepareStepActiveTools(
  prepareStepResult: Record<string, unknown>,
  fallback: readonly string[] | undefined,
): readonly string[] | undefined {
  if (prepareStepResult.activeTools === undefined) {
    return fallback;
  }
  return Array.isArray(prepareStepResult.activeTools)
    ? prepareStepResult.activeTools.filter((toolName): toolName is string => typeof toolName === "string")
    : undefined;
}

function systemWithRuntimeHints(system: unknown, hints: readonly string[]): unknown {
  if (hints.length === 0) {
    return system;
  }
  if (typeof system === "string") {
    return [system, ...hints].filter(Boolean).join("\n\n");
  }
  const hintMessages = hints.map((content) => ({ role: "system" as const, content }));
  if (Array.isArray(system)) {
    return [...system, ...hintMessages];
  }
  if (isObject(system) && system.role === "system") {
    return [system, ...hintMessages];
  }
  return [stableStringify(system), ...hints].filter(Boolean).join("\n\n");
}

async function getOrCreateSession<TExtraBody>(
  harness: Harness<any, TExtraBody>,
  id: string | undefined,
  extraBody: TExtraBody | undefined,
): Promise<HarnessSession> {
  const request: { id?: string; extraBody?: TExtraBody } = {};
  if (id !== undefined) {
    request.id = id;
  }
  if (extraBody !== undefined) {
    request.extraBody = extraBody;
  }
  return harness.sessions.getOrCreate(request);
}

async function callGenerateText(options: {
  model: Parameters<typeof generateText>[0]["model"];
  system: string;
  messages: Parameters<typeof generateText>[0]["messages"];
  tools: ToolSet;
  output?: Output.Output<unknown> | undefined;
  temperature?: Parameters<typeof generateText>[0]["temperature"];
  abortSignal?: AbortSignal | undefined;
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
  prepareStep?: Parameters<typeof generateText>[0]["prepareStep"];
  toolChoice?: Parameters<typeof generateText>[0]["toolChoice"];
  activeTools?: Parameters<typeof generateText>[0]["activeTools"];
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  headers?: Parameters<typeof generateText>[0]["headers"];
  maxRetries?: Parameters<typeof generateText>[0]["maxRetries"];
  onToolExecutionStart?: Parameters<typeof generateText>[0]["onToolExecutionStart"];
  onToolExecutionEnd?: Parameters<typeof generateText>[0]["onToolExecutionEnd"];
  onStepStart?: Parameters<typeof generateText>[0]["onStepStart"];
  onStepEnd?: Parameters<typeof generateText>[0]["onStepEnd"];
}) {
  const request: Record<string, unknown> = {
    model: options.model,
    instructions: options.system,
    messages: options.messages,
    tools: options.tools,
  };
  if (options.output !== undefined) {
    request.output = options.output;
  }
  if (options.temperature !== undefined) {
    request.temperature = options.temperature;
  }
  if (options.abortSignal !== undefined) {
    request.abortSignal = options.abortSignal;
  }
  if (options.stopWhen !== undefined) {
    request.stopWhen = options.stopWhen;
  }
  if (options.prepareStep !== undefined) {
    request.prepareStep = options.prepareStep;
  }
  if (options.toolChoice !== undefined) {
    request.toolChoice = options.toolChoice;
  }
  if (options.activeTools !== undefined) {
    request.activeTools = options.activeTools;
  }
  if (options.providerOptions !== undefined) {
    request.providerOptions = options.providerOptions;
  }
  if (options.headers !== undefined) {
    request.headers = options.headers;
  }
  if (options.maxRetries !== undefined) {
    request.maxRetries = options.maxRetries;
  }
  if (options.onStepStart !== undefined) {
    request.onStepStart = options.onStepStart;
  }
  if (options.onStepEnd !== undefined) {
    request.onStepEnd = options.onStepEnd;
  }
  if (options.onToolExecutionStart !== undefined) {
    request.onToolExecutionStart = options.onToolExecutionStart;
  }
  if (options.onToolExecutionEnd !== undefined) {
    request.onToolExecutionEnd = options.onToolExecutionEnd;
  }
  return generateText(request as Parameters<typeof generateText>[0]);
}

async function emitHarnessEvent<TExtraBody>(
  prepared: PreparedTurn<TExtraBody>,
  session: HarnessSession,
  event: PreparedTurnEvent,
  traceOptions: ResolvedHarnessTraceOptions,
  nextSequence: () => number,
  options: {
    harness: Harness<any, TExtraBody>;
    onEvent?: (event: HarnessEvent) => void | Promise<void>;
  },
  occurrence: {
    runId: string;
    durability?: HarnessSessionLog | undefined;
    onTraceError?: ((error: unknown, event: TraceHarnessEventInput) => Promise<void> | void) | undefined;
  },
): Promise<void> {
  const sanitizedEvent = sanitizeHarnessEvent(event, traceOptions);
  const { payload, ...traceEvent } = sanitizedEvent;
  await emitHarnessOccurrence({
    type: traceEvent.type,
    runId: occurrence.runId,
    ...(traceEvent.occurrenceId === undefined ? {} : { occurrenceId: traceEvent.occurrenceId }),
    ...(payload === undefined ? {} : { payload }),
    ...(traceEvent.metadata === undefined ? {} : { metadata: traceEvent.metadata }),
    ...(occurrence.durability === undefined ? {} : { durability: occurrence.durability }),
    trace: {
      append: async () => {
        const fullEvent: HarnessEvent = traceOptions.enabled
          ? await prepared.emit(traceEvent)
          : validateTraceEvent({
              ...traceEvent,
              schemaVersion: "lh.trace.v2",
              eventId: createEventId(),
              sequence: nextSequence(),
              sessionId: session.id,
              timestamp: new Date().toISOString(),
              metadata: traceEvent.metadata ?? {},
            }) as HarnessEvent;
        await options.harness.config.onEvent?.(fullEvent);
        await options.onEvent?.(fullEvent);
      },
    },
    ...(occurrence.onTraceError === undefined ? {} : { onTraceError: occurrence.onTraceError }),
  });
}

function sanitizeHarnessEvent(
  event: PreparedTurnEvent,
  traceOptions: ResolvedHarnessTraceOptions,
): PreparedTurnEvent {
  if (event.metadata === undefined) {
    return event;
  }
  return {
    ...event,
    metadata: sanitizeTraceValue(event.metadata, traceOptions)
      .value as NonNullable<PreparedTurnEvent["metadata"]>,
  };
}

function withTurnId(event: PreparedTurnEvent, turnId: string): PreparedTurnEvent {
  return event.turnId ? event : { ...event, turnId };
}

function stepIdFor(zeroBasedStepNumber: number): string {
  return `step_${zeroBasedStepNumber + 1}`;
}

function eventStepNumber(event: unknown): number {
  if (isObject(event) && Number.isInteger(event.stepNumber)) {
    return event.stepNumber as number;
  }
  return 0;
}

function eventModel(event: unknown, fallback: Parameters<typeof generateText>[0]["model"]): EventModel {
  if (isObject(event) && isObject(event.model)) {
    return event.model as { provider?: string; modelId?: string };
  }
  // AI SDK 7 step-start events flatten the model into top-level provider/modelId.
  if (isObject(event) && typeof event.provider === "string" && typeof event.modelId === "string") {
    return { provider: event.provider, modelId: event.modelId };
  }
  return fallback;
}

function modelMetadata(model: EventModel): { provider?: string; modelId?: string } {
  const value = model as { provider?: unknown; modelId?: unknown };
  const out: { provider?: string; modelId?: string } = {};
  if (typeof value.provider === "string") {
    out.provider = value.provider;
  }
  if (typeof value.modelId === "string") {
    out.modelId = value.modelId;
  }
  return out;
}

function eventSystem(event: unknown, fallback: string): string {
  // AI SDK 7 renamed the step's system prompt to `instructions`; `system` is the v6 name.
  const value = isObject(event) ? event.instructions ?? event.system : undefined;
  if (value === undefined) {
    return fallback;
  }
  return typeof value === "string" ? value : stableStringify(value);
}

function eventMessages(
  event: unknown,
  fallback: ModelMessage[],
): ModelMessage[] {
  return isObject(event) && Array.isArray(event.messages)
    ? (event.messages as ModelMessage[])
    : fallback;
}

function eventTools(event: unknown, fallback: ToolSet): ToolSet {
  return isObject(event) && isObject(event.tools) ? (event.tools as ToolSet) : fallback;
}

function eventText(event: unknown): string {
  return isObject(event) && typeof event.text === "string" ? event.text : "";
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createManualCommit<TExtraBody>(
  prepared: PreparedTurn<TExtraBody>,
  session: HarnessSession,
  emit: (event: PreparedTurnEvent) => Promise<void>,
  options: {
    harness: Harness<any, TExtraBody>;
    onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
  },
): HarnessCompletedResult["commitManual"] {
  let commit: ReturnType<HarnessCompletedResult["commitManual"]> | undefined;
  return () => {
    commit ??= options.harness.config.host
      .runExclusive(session, { turnId: createTurnId() }, () =>
        prepared.commitPersistentDirs({ mode: "manual", emit }),
      )
      .then(async (status) => {
        if (status.status === "failed") {
          const error: PersistenceError = { session, failedCommits: status.failedCommits };
          await options.harness.config.onPersistenceError?.(error);
          await options.onPersistenceError?.(error);
        }
        return status;
      });
    return commit;
  };
}

function providerWarnings(warnings: unknown[] | undefined): HarnessWarning[] {
  return (warnings ?? []).map((warning) => ({
    code: "provider_warning",
    message: providerWarningMessage(warning),
    metadata: { warning: warning as Record<string, unknown> },
  }));
}

function providerWarningMessage(warning: unknown): string {
  if (warning && typeof warning === "object") {
    if ("message" in warning && typeof warning.message === "string") {
      return warning.message;
    }
    if ("feature" in warning && typeof warning.feature === "string") {
      return `Provider warning for ${warning.feature}`;
    }
  }
  return "Provider warning";
}

async function setSessionState(
  session: HarnessSession,
  state: "idle" | "running" | "failed",
): Promise<void> {
  // Optional call: sessions written against the pre-port contract may not implement the
  // typed mutators yet; state tracking degrades gracefully instead of failing every turn.
  await session.setStatus?.({ state });
}
