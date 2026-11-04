/**
 * Base class of every error Little Harness throws on purpose, so one `instanceof` check catches
 * them all. `code` is a stable snake_case identifier; subclasses narrow it.
 */
export class LittleHarnessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LittleHarnessError";
  }
}

export class HarnessPathError extends LittleHarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "harness_path_error", details);
    this.name = "HarnessPathError";
  }
}

export class HarnessConcurrencyError extends LittleHarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "harness_concurrency_error", details);
    this.name = "HarnessConcurrencyError";
  }
}

export class HarnessPersistenceError extends LittleHarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "harness_persistence_error", details);
    this.name = "HarnessPersistenceError";
  }
}

/**
 * A failure in the small set of terminal bookkeeping operations that happen
 * after a model has produced its final response.  Keeping this stage marker
 * on the Harness side lets a trusted adapter expose a bounded diagnostic code
 * without replaying the model turn or leaking the underlying error.
 */
export type HarnessTerminalStage =
  | "model_responded"
  | "persistence"
  | "session_completed"
  | "session_status"
  | "artifact_list"
  | "mcp_close";

export class HarnessTerminalStageError extends LittleHarnessError {
  readonly stage: HarnessTerminalStage;

  constructor(stage: HarnessTerminalStage) {
    super(`Little Harness terminal ${stage} stage failed.`,
      `harness_terminal_${stage}_failed`);
    this.name = "HarnessTerminalStageError";
    this.stage = stage;
  }
}

export class HarnessInputError extends LittleHarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "harness_input_error", details);
    this.name = "HarnessInputError";
  }
}
