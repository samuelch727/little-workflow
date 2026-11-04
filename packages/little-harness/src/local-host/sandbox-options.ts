import type {
  CreateSandboxOptions,
  HarnessSession,
  HarnessWorkspaceSpec,
  PreparedTurn,
} from "../types.js";

type TurnSandboxRequest<TExtraBody> = Parameters<PreparedTurn<TExtraBody>["createSandbox"]>[0];

/**
 * What a host hands its sandbox factory for one turn: the workspace, the session's files, and
 * whichever per-turn runtime options the turn set.
 */
export function turnSandboxOptions<TExtraBody>(
  session: HarnessSession,
  workspace: HarnessWorkspaceSpec,
  emit: NonNullable<CreateSandboxOptions<TExtraBody>["emit"]>,
  request: TurnSandboxRequest<TExtraBody>,
): CreateSandboxOptions<TExtraBody> {
  const options: CreateSandboxOptions<TExtraBody> = {
    workspace,
    files: session.files,
    emit: request.emit ?? emit,
  };
  if (request.tools !== undefined) {
    options.tools = request.tools;
    // The environment factory never sees the session, so the host supplies the
    // default execution context for bridge-invoked tools.
    options.toolContext = request.toolContext ?? {
      session,
      files: session.files,
      artifacts: session.artifacts,
      ...(request.extraBody === undefined ? {} : { extraBody: request.extraBody }),
      ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
    };
  }
  if (request.runtimeToolReplay !== undefined) {
    options.runtimeToolReplay = request.runtimeToolReplay;
  }
  if (request.runtime !== undefined) {
    options.runtime = request.runtime;
  }
  if (request.mounts !== undefined) {
    options.mounts = request.mounts;
  }
  if (request.emitToolEvents !== undefined) {
    options.emitToolEvents = request.emitToolEvents;
  }
  if (request.traceOptions !== undefined) {
    options.traceOptions = request.traceOptions;
  }
  if (request.extraBody !== undefined) {
    options.extraBody = request.extraBody;
  }
  if (request.abortSignal !== undefined) {
    options.abortSignal = request.abortSignal;
  }
  return options;
}
