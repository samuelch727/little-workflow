import {
  generateText,
  isStepCount,
  type StopCondition,
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
import {
  createHarnessAppendIdempotencyKey,
  emitHarnessOccurrence,
} from "../events/occurrence.js";
import {
  HarnessInputError,
  HarnessTerminalStageError,
} from "../errors.js";
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
  ArtifactRef,
  Harness,
  HarnessAgentOptions,
  HarnessEvent,
  HarnessSandbox,
  HarnessRuntimeOptions,
  HarnessSession,
  HarnessToolExecutionContext,
  HarnessTrigger,
  HarnessTurnStart,
  HarnessWarning,
  JsonObject,
  PersistenceError,
  PersistenceStatus,
  PreparedTurn,
} from "../types.js";
import { createArtifactAccessor, createEventedFileWriter } from "./evented-file-writer.js";
import { stableHash } from "../utils/canonical-hash.js";
import {
  durableModelRequest,
  modelCalledEventData,
  modelFailedEventData,
  modelRespondedEventData,
  toolRefsForDurableRequest,
} from "./model-events.js";
import { modelRequestSettings } from "./model-request-settings.js";
import { emitMountedFiles } from "./mount-events.js";
import type { HarnessTurnResult, HarnessCompletedResult, HarnessParkedResult } from "./result.js";
import { parkedResultFromSteps, parkedThisStep } from "./park-resume.js";
import { recordWaitingPark, RERUN_STEP_ID, waitingPark } from "./waiting-tools.js";
import { requiredRecords, settleRequiredRecords, type RequiredRecords } from "./required-records.js";
import {
  closeParkedTurn,
  loadParkedTurn,
  parkedTurnDecision,
  requireOrchestration,
  resumedModelMessages,
  parkedTurnBudgetRef,
  saveParkedTurn,
} from "./parked-turns.js";
import { stageChatMessages, type StageChatMessagesOptions } from "./stage-message.js";
import { toolCallEventData } from "./tool-events.js";
import { uncachedInstructions, withPromptCaching } from "./prompt-caching.js";
import { withTurnMessages } from "./turn-messages.js";
import { withTurnOptions } from "./turn-options.js";
import { bindSnapshotEvents, guardSnapshotInvocation, snapshotConfig, snapshotState } from "./snapshot-turn.js";
import { inboxPrepareStep, type HarnessInbox } from "./inbox.js";
import { logicalTurnBudget, modelInvocationGuard } from "./logical-turn-budget.js";
import { createTurnLimiter, HarnessTurnLimitError, turnLimitCause } from "./turn-limits.js";
import { triggerMetadata } from "./turn-trigger.js";

export type GenerateHarnessOptions<TInput = unknown, TExtraBody = unknown, TOutput = unknown> =
  HarnessAgentOptions & {
    harness: Harness<any, TExtraBody>;
    /** One user message, as plain text. Use this or `messages`, not both. */
    prompt?: string;
    messages?: UIMessage[];
    type?: string;
    input?: TInput;
    session?: string | HarnessSession;
    extraBody?: TExtraBody;
    output?: Output.Output<TOutput>;
    abortSignal?: AbortSignal;
    /** Awaited at each actual provider invocation; rejection blocks I/O. Requires concrete model handles. */
    beforeInvocation?: () => void | Promise<void>;
    restage?: boolean;
    runId?: string;
    /** How this turn started (a message, a schedule, an API call), for trace readers such as LittleDB. */
    trigger?: HarnessTrigger;
    /** The session log (durable event log) this run appends to and replays from. */
    sessionLog?: HarnessSessionLog;
    onTraceError?: (error: unknown, event: TraceHarnessEventInput) => Promise<void> | void;
    onEvent?: (event: HarnessEvent) => void | Promise<void>;
    onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
    /** Messages that arrive while the turn runs, read before each model step. See {@link HarnessInbox}. */
    inbox?: HarnessInbox;
    /** Called once the turn's id and its `turnOptions` metadata are known, before it runs. */
    onTurnStart?: (turn: HarnessTurnStart) => void | Promise<void>;
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
  invocationId?: string | undefined;
};

export async function generateHarness<
  TOutput = string,
  TInput = unknown,
  TExtraBody = unknown,
>(
  turnOptions: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): Promise<HarnessTurnResult<TOutput>> {
  return runGenerateHarness(turnOptions);
}

/**
 * generateHarness, or with `resume`, a turn that continues a parked one from its saved
 * conversation instead of new messages. `resumeParked` is the only caller that passes it.
 */
export async function runGenerateHarness<
  TOutput = string,
  TInput = unknown,
  TExtraBody = unknown,
>(
  turnOptions: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
  resume?: { readonly continuationId: string },
): Promise<HarnessTurnResult<TOutput>> {
  const called = withTurnMessages(turnOptions);
  const session =
    typeof called.session === "object"
      ? called.session
      : await getOrCreateSession(called.harness, called.session, called.extraBody);
  // The harness's per-turn hook decides this turn's model and prompt, now that its session is known.
  // A continued turn goes on with the prompt it saved when it parked, so its hook gets the pin and
  // metadata it saved too, to decide the same again.
  const hooked = await withTurnOptions(
    called,
    session,
    resume === undefined
      ? undefined
      : {
          continuationId: resume.continuationId,
          ...(await parkedTurnDecision({
            services: called.harness.config.host.durable,
            session,
            continuationId: resume.continuationId,
          })),
        },
  );
  // Step, cost and time limits: the deadline joins the caller's abort signal, so tools see it too.
  const limits = createTurnLimiter(
    hooked.turnLimits ?? hooked.harness.config.turnLimits,
    hooked.abortSignal,
    modelName(hooked.model ?? hooked.harness.config.model),
  );
  const options = limits.signal === undefined ? hooked : { ...hooked, abortSignal: limits.signal };
  const config = resolveTurnConfig(options.harness.config, options);
  const turnId = createTurnId();
  const runId = options.runId ?? createEventId();
  const durability =
    options.sessionLog ?? config.sessionLog;
  const onTraceError = options.onTraceError ?? config.onTraceError;
  const priorEvents = await durability?.priorEvents?.({ runId }) ?? [];

  return config.host.runExclusive(session, { turnId }, async () => {
    let prepared: PreparedTurn<TExtraBody> | undefined;
    let resolvedMcp: ResolvedHarnessMcpGateway | undefined;
    let turnRuntime: HarnessSandbox | undefined;
    // The turn emitter is built inside the try (it needs `prepared`), but the `finally`
    // that disposes the runtime has to report a disposal failure through it.
    let emitTurnEventForDispose:
      | ((event: PreparedTurnEvent) => Promise<void>)
      | undefined;
    let turnFailed = false;
    // AI SDK deliberately swallows callback failures in its notify helper. Keep the
    // first failed required append from a step or tool callback local, so no tool runs
    // unrecorded and the completed model call cannot be mistaken for a successful turn.
    const records = requiredRecords<PreparedTurnEvent>();
    let callbackSequence = 0;
    let lastStartedModelStep: StartedModelStep | undefined;
    let currentModelStepNumber: number | undefined;
    const modelSteps = new Map<number, StartedModelStep>();
    const modelToolPositions = new Map<
      string,
      Readonly<{ modelStepId: string; sequenceIndex: number }>
    >();
    const nextModelToolSequenceByStep = new Map<number, number>();
    const toolOccurrences = new Map<string, string>();
    const toolReplayStates = new Map<string, ToolReplayState>();
    /** Recorded model tool calls this run has replayed or run again, so no other call takes them. */
    const claimedReplays = new Set<string>();
    const nextCallbackSequence = () => {
      callbackSequence += 1;
      return callbackSequence;
    };
    try {
      // In the session's turn, so a turn waiting behind another doesn't announce itself first.
      await options.onTurnStart?.({
        sessionId: session.id,
        turnId,
        ...(options.turnMetadata === undefined ? {} : { metadata: options.turnMetadata }),
      });
      limits.start();
      await setSessionState(session, "running");
      prepared = await config.host.prepareTurn({
        session,
        turnId,
        persistentDirs: config.persistentDirs,
        extraBody: options.extraBody,
      });
      options.abortSignal?.throwIfAborted();
      const orchestration = prepared.orchestration ?? config.host.durable;
      const beforeInvocation = async () => {
        records.throwIfFailed();
        options.abortSignal?.throwIfAborted();
        await options.beforeInvocation?.();
        await guardSnapshotInvocation(options);
        records.throwIfFailed();
        options.abortSignal?.throwIfAborted();
      };
      const budget = await logicalTurnBudget({ limits: options.turnLimits ?? config.turnLimits, services: orchestration, sessionId: session.id, runId, priorEvents, beforeInvocation, resumed: resume !== undefined, budgetRef: resume === undefined ? undefined : await parkedTurnBudgetRef({ services: orchestration, session, continuationId: resume.continuationId }), ...(options.abortSignal ? { signal: options.abortSignal } : {}) });

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
      const commitTerminalPersistence = async () => {
        try {
          return await prepared!.commitPersistentDirs({ emit: emitTurnEvent });
        } catch {
          throw new HarnessTerminalStageError("persistence");
        }
      };
      const reportTerminalPersistence = async (persistence: PersistenceStatus): Promise<void> => {
        if (persistence.status !== "failed") return;
        try {
          const error: PersistenceError = { session, failedCommits: persistence.failedCommits };
          await config.onPersistenceError?.(error);
          await options.onPersistenceError?.(error);
        } catch {
          throw new HarnessTerminalStageError("persistence");
        }
      };
      const emitSessionCompleted = async (): Promise<void> => {
        try {
          await emitTurnEvent({
            type: "harness.session.completed",
            turnId,
            payload: { sessionId: session.id, turnId },
          });
        } catch {
          throw new HarnessTerminalStageError("session_completed");
        }
      };
      const setIdle = async (): Promise<void> => {
        try {
          await setSessionState(session, "idle");
        } catch {
          throw new HarnessTerminalStageError("session_status");
        }
      };
      const listArtifacts = async (): Promise<ArtifactRef[]> => {
        try {
          return await session.artifacts.list();
        } catch {
          throw new HarnessTerminalStageError("artifact_list");
        }
      };
      const agentFiles = createEventedFileWriter(prepared.files, emitTurnEvent, {
        defaultSource: "agent",
        traceOptions,
      });
      const startedMetadata = triggerMetadata(options.trigger);
      await emitTurnEvent({
        type: "harness.session.started",
        turnId,
        payload: { sessionId: session.id, turnId },
        ...(startedMetadata === undefined ? {} : { metadata: startedMetadata }),
      });
      await bindSnapshotEvents(options, emitTurnEvent);
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
          const persistence = await commitTerminalPersistence();
          await reportTerminalPersistence(persistence);

          await emitSessionCompleted();
          await setIdle();

          return {
            status: "completed",
            text: replayedOutput.text,
            output: replayedOutput.output,
            session,
            artifacts: await listArtifacts(),
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
        orchestration,
        abortSignal: options.abortSignal,
        files: prepared.files,
        hostDataDir: prepared.dataDir,
        hostDataFs: prepared.dataFs,
      });
      resolvedMcp = assembled.mcp;
      const snapshot = snapshotState(options);
      const resolvedSkills = snapshot ? snapshot.registry.skills(snapshot.snapshot) : assembled.resolvedSkills;
      const turnTools = snapshot?.tools ?? assembled.turnTools;
      warnings.push(...assembled.warnings);
      await prepared.stageSkills(resolvedSkills);

      const resumed = resume === undefined
        ? undefined
        : await loadParkedTurn({
            services: requireOrchestration(orchestration),
            session,
            continuationId: resume.continuationId,
          });
      const staging = options.messages && resumed === undefined
        ? await stageChatMessages(
            stageOptions(options.messages, session, agentFiles, emitTurnEvent, config, options),
          )
        : { notices: [], stagedMessageIds: [], stripStagedFileParts: false };

      const built = resumed !== undefined
        ? resumedModelMessages(resumed, config)
        : await buildModelMessages({
            harness: options.harness,
            config,
            session,
            files: agentFiles,
            stagingNotices: staging.notices,
            stripStagedFileParts: staging.stripStagedFileParts,
            resolvedSkills: snapshot ? [] : resolvedSkills,
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
      toolContext.beforeInvocation = beforeInvocation;
      if (options.extraBody !== undefined) {
        toolContext.extraBody = options.extraBody;
      }
      if (options.abortSignal !== undefined) {
        toolContext.abortSignal = options.abortSignal;
      }
      if (assembled.ask !== undefined) {
        toolContext.ask = assembled.ask;
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
      const runtime = await prepared.createSandbox({
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
        modelToolPositions,
        records,
        toolReplayStates,
      );

      const prepareStep = runtimeAwarePrepareStep(
        options.prepareStep,
        built.system,
        runtime,
        options.activeTools,
        snapshot !== undefined,
      );
      const modelAbortController = new AbortController();
      const modelAbortSignal = options.abortSignal === undefined
        ? modelAbortController.signal
        : AbortSignal.any([options.abortSignal, modelAbortController.signal]);
      // Messages that arrive while the turn runs are read before the next step.
      const inbox = inboxPrepareStep(guardedModelPrepareStep(prepareStep, records), options.inbox);
      await inbox.restore({ stepNumber: 0, at: built.messages.length });
      const invocationGuard = budget ?? modelInvocationGuard({ beforeInvocation, requireConcrete: options.beforeInvocation !== undefined || snapshot !== undefined, ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
      const guardedPrepareStep = invocationGuard.wrapPrepareStep(inbox.prepareStep);
      const system = !snapshot && prepareStep === undefined
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
                messages: inbox.withArrived(built.messages),
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
        const persistence = await commitTerminalPersistence();
        await reportTerminalPersistence(persistence);

        await disposeTurnRuntime(turnRuntime, emitTurnEvent);
        turnRuntime = undefined;
        await emitSessionCompleted();
        await setIdle();

        return {
          status: "completed",
          text: replayedOutput.text,
          output: replayedOutput.output,
          session,
          artifacts: await listArtifacts(),
          trace: prepared.trace,
          persistence,
          commitManual: createManualCommit(prepared, session, emitTurnEvent, options),
          warnings,
        };
      }
      let result: Awaited<ReturnType<typeof callGenerateText>>;
      try {
        result = await callGenerateText({
          promptCaching: config.promptCaching !== false,
          model: invocationGuard.wrapModel(config.model),
          system,
          messages: built.messages,
          tools,
          output: outputSpec,
          temperature: options.temperature,
          abortSignal: modelAbortSignal,
          stopWhen: stopWhenWithPark(
          options.stopWhen ?? isStepCount(limits.maxSteps ?? config.workflowBudgets?.maxModelSteps ?? 20),
          limits.stopWhen,
        ),
          prepareStep: guardedPrepareStep,
          toolChoice: options.toolChoice,
          activeTools: options.activeTools,
          providerOptions: options.providerOptions,
          headers: options.headers,
          maxRetries: options.maxRetries,
          onStepStart: (event) => records.record(async () => {
          records.throwIfFailed();
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
          await options.inbox?.modelRequested?.({ stepNumber, occurrenceId });
        }),
          onStepEnd: async (event) => {
            const stepNumber = eventStepNumber(event);
            records.throwIfFailed();
            const started = modelSteps.get(stepNumber) ?? {
              stepNumber: stepNumber + 1,
              callId: createEventId(),
              occurrenceId: createEventId(),
              model: eventModel(event, config.model),
              startedAt: Date.now(),
            };
            modelSteps.set(stepNumber, started);
            let eventToRetry: PreparedTurnEvent | undefined;
            try {
              const eventData = await modelRespondedEventData({
                callId: started.callId,
                stepNumber: stepNumber + 1,
                model: eventModel(event, config.model),
                result: event,
                text: eventText(event),
                files: prepared!.files,
                traceOptions,
              });
              eventToRetry = {
                type: "harness.model.responded",
                occurrenceId: started.occurrenceId,
                stepId: stepIdFor(stepNumber),
                payload: eventData.payload,
                metadata: eventData.metadata,
              };
              await emitTurnEvent(eventToRetry);
              await options.inbox?.modelResponded?.({ stepNumber, occurrenceId: started.occurrenceId });
            } catch (error) {
              const terminalError = error instanceof HarnessTerminalStageError
                ? error
                : new HarnessTerminalStageError("model_responded");
              if (!isFinalModelResponse(event)) {
                modelAbortController.abort();
              }
              records.fail({
                stepNumber,
                ...(eventToRetry === undefined ? {} : { event: eventToRetry }),
                laterStep: false,
                error: terminalError,
              });
              throw terminalError;
            }
        },
        onToolExecutionStart: (toolEvent) => records.recordToolStart(toolEvent.toolCall.toolCallId, async () => {
          const event = harnessToolExecutionStart(toolEvent, currentModelStepNumber);
          const stepNumber = eventStepNumber(event);
          const sequenceIndex = nextModelToolSequenceByStep.get(stepNumber) ?? 0;
          nextModelToolSequenceByStep.set(stepNumber, sequenceIndex + 1);
          modelToolPositions.set(event.toolCall.toolCallId, Object.freeze({
            // Before the first model step, a continued turn runs again the calls that waited in `ask`.
            modelStepId: currentModelStepNumber === undefined ? RERUN_STEP_ID : stepIdFor(stepNumber),
            sequenceIndex,
          }));
          const replay = toolReplayForEvent(priorEvents as readonly DurableHarnessEvent[], event, claimedReplays);
          const callId = replay.kind === "inflight" ? replay.callId : event.toolCall.toolCallId;
          const originalOccurrence = toolOccurrenceIdFor(priorEvents as readonly DurableHarnessEvent[], callId);
          const occurrenceId = replay.kind === "none" ? toolOccurrenceId(event) : originalOccurrence ?? toolOccurrenceId(event);
          // Keep event occurrence behavior unchanged. A legacy unfinished replay's replacement
          // occurrence is not safe to expose as the original write's deduplication identity.
          const invocationId = replay.kind === "none" ? occurrenceId : originalOccurrence;
          toolReplayStates.set(event.toolCall.toolCallId, { replay, callId, occurrenceId, invocationId });
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
          }),
          onToolExecutionEnd: (toolEnd) => records.record(async () => {
            const event = harnessToolExecutionEnd(toolEnd, currentModelStepNumber);
            // A call refused before it ran has no outcome to record. One that did run is
            // recorded even after another record failed, so a rerun does not repeat it.
            if (!records.ran(event.toolCall.toolCallId)) {
              return;
            }
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
          }),
        });
      } catch (error) {
        if (records.failure !== undefined) throw records.failure.error;
        throw limits.exceeded() ?? error;
      }
      await settleRequiredRecords(records, result.steps.length - 1, emitTurnEvent);
      // A step or cost limit stopped the model while it still wanted to call tools.
      const limited = limits.exceeded();
      if (limited !== undefined) throw limited;
      warnings.push(...providerWarnings(result.warnings));
      const found = parkedResultFromSteps(result.steps);
      // Tools that waited in `ask` park the turn on their step's one continuation.
      const waiting = found === undefined || orchestration === undefined
        ? undefined
        : await waitingPark({ services: orchestration, sessionId: session.id, turnId, steps: result.steps });
      const parked = found === undefined || waiting === undefined
        ? found
        : { ...found, continuationId: waiting.continuationId, pending: waiting.pending };
      if (parked !== undefined && orchestration !== undefined) {
        await saveParkedTurn({
          services: orchestration,
          session,
          continuationId: parked.continuationId,
          system: built.system,
          // Every step's messages: `response.messages` holds only the last step's.
          messages: inbox.withArrived([...built.messages, ...result.responseMessages]),
          type: resumed?.type ?? options.type,
          pin: options.turnPin,
          metadata: options.turnMetadata,
          ...(budget === undefined ? {} : { budgetRef: budget.ref }),
        });
        if (waiting !== undefined) await recordWaitingPark(waiting, orchestration);
      }
      if (resumed !== undefined) {
        await closeParkedTurn(requireOrchestration(orchestration), resumed.continuationId);
      }

      const persistence = await commitTerminalPersistence();
      await reportTerminalPersistence(persistence);

      // The sandbox is disposed before the turn closes, so its usage event (what the turn
      // ran on and what that cost) lands inside the turn's trace.
      await disposeTurnRuntime(turnRuntime, emitTurnEvent);
      turnRuntime = undefined;
      await emitSessionCompleted();
      await setIdle();

      if (parked !== undefined) {
        return {
          ...parked,
          session,
          artifacts: await listArtifacts(),
          trace: prepared.trace,
          warnings,
        };
      }

      const output = outputSpec === undefined ? (result.text as TOutput) : (result.output as TOutput);
      return {
        status: "completed",
        text: result.text,
        output,
        session,
        artifacts: await listArtifacts(),
        trace: prepared.trace,
        persistence,
        commitManual: createManualCommit(prepared, session, emitTurnEvent, options),
        warnings,
      };
    } catch (caught) {
      const error = turnLimitCause(caught);
      turnFailed = true;
      // The sandbox first, for the same reason as on the success path: its usage event has to
      // precede the terminal session event. Disposal never throws.
      await disposeTurnRuntime(turnRuntime, emitTurnEventForDispose);
      turnRuntime = undefined;
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
              payload: {
                sessionId: session.id,
                turnId,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof HarnessTurnLimitError ? { reason: error.reason } : {}),
              },
              metadata: {
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof HarnessTurnLimitError ? { reason: error.reason } : {}),
              },
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
      limits.dispose();
      // Dispose the environment first: closing MCP can throw on the success path, and the
      // sandbox child process must be reaped regardless. Normally it is already gone (both
      // paths above dispose before their terminal event); this covers a turn that parked.
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
    try {
      await resolvedMcp.close();
    } catch {
      throw new HarnessTerminalStageError("mcp_close");
    }
    return;
  }
  try {
    await resolvedMcp.close();
  } catch {
    // Preserve the original turn failure.
  }
}

/**
 * What an earlier run recorded for this call: its own record first (by `toolCallId`), else the
 * latest matching one no other call of this run has taken. Marks the record taken.
 */
function toolReplayForEvent(
  events: readonly DurableHarnessEvent[],
  event: { stepNumber?: number | undefined; toolCall: { toolCallId: string; toolName: string; input?: unknown } },
  claimed: Set<string>,
): ToolReplay {
  if (!("input" in event.toolCall)) {
    return { kind: "none" };
  }
  const replay = findToolReplay(events, {
    caller: "model",
    toolName: event.toolCall.toolName,
    args: event.toolCall.input,
    ...(event.stepNumber === undefined ? {} : { turn: event.stepNumber + 1 }),
  }, { callId: event.toolCall.toolCallId, claimed });
  if (replay.kind !== "none" && replay.callId !== undefined) claimed.add(replay.callId);
  return replay;
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
): Parameters<PreparedTurn<TExtraBody>["createSandbox"]>[0] {
  const out: Parameters<PreparedTurn<TExtraBody>["createSandbox"]>[0] = {
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

/** A turn's config: the harness's, with the call's options applied and a model chosen. */
type TurnConfig<TExtraBody> = Harness<any, TExtraBody>["config"] & { model: NonNullable<Harness<any, TExtraBody>["config"]["model"]> };

function resolveTurnConfig<TInput, TExtraBody, TOutput>(
  config: Harness<any, TExtraBody>["config"],
  options: GenerateHarnessOptions<TInput, TExtraBody, TOutput>,
): TurnConfig<TExtraBody> {
  const model = options.model ?? config.model;
  if (model === undefined) {
    throw new HarnessInputError(
      "Little Harness model is required. Provide model to createHarness(...) or to this harness call.",
      { option: "model" },
    );
  }

  const out: TurnConfig<TExtraBody> = {
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
  return snapshotConfig(out, options);
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

function stopWhenWithPark(
  stopWhen: Parameters<typeof generateText>[0]["stopWhen"],
  limit?: StopCondition<any>,
): Parameters<typeof generateText>[0]["stopWhen"] {
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen ?? isStepCount(20)];
  return [...conditions, ...(limit === undefined ? [] : [limit]), parkedThisStep];
}

/** The model's id, for a `price` function. */
function modelName(model: unknown): string {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && typeof (model as { modelId?: unknown }).modelId === "string") {
    return (model as { modelId: string }).modelId;
  }
  return "unknown";
}

function runtimeSystem(
  system: string,
  runtime: Pick<HarnessSandbox, "systemHints">,
  activeTools: readonly string[] | undefined,
): string {
  return systemWithRuntimeHints(system, runtime.systemHints({ activeTools })) as string;
}

function runtimeAwarePrepareStep(
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"],
  baseSystem: string,
  runtime: Pick<HarnessSandbox, "systemHints">,
  activeTools: readonly string[] | undefined,
  snapshot = false,
): Parameters<typeof generateText>[0]["prepareStep"] {
  if (snapshot || prepareStep === undefined) {
    return prepareStep;
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

function guardedModelPrepareStep(
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"],
  records: Pick<RequiredRecords<unknown>, "throwIfFailed">,
): NonNullable<Parameters<typeof generateText>[0]["prepareStep"]> {
  return async (event) => {
    records.throwIfFailed();
    if (prepareStep === undefined) return undefined;
    return await prepareStep(event as never);
  };
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
  promptCaching: boolean;
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
  if (options.promptCaching) {
    withPromptCaching(request);
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
  const appendIdempotencyKey = createHarnessAppendIdempotencyKey({
    runId: occurrence.runId,
    eventType: traceEvent.type,
    logicalEventId:
      traceEvent.occurrenceId ??
      stableHash({
        turnId: traceEvent.turnId,
        stepId: traceEvent.stepId,
        parentEventId: traceEvent.parentEventId,
        type: traceEvent.type,
        payload,
        metadata: traceEvent.metadata,
      }),
  });
  await emitHarnessOccurrence({
    type: traceEvent.type,
    runId: occurrence.runId,
    appendIdempotencyKey,
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
  const value = uncachedInstructions(isObject(event) ? event.instructions ?? event.system : undefined);
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

function isFinalModelResponse(event: unknown): boolean {
  if (!isObject(event)) return false;
  return event.finishReason === "stop" &&
    (!Array.isArray(event.toolCalls) || event.toolCalls.length === 0);
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
