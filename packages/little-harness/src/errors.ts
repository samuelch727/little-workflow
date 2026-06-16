export class LittleHarnessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
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

export class HarnessInputError extends LittleHarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "harness_input_error", details);
    this.name = "HarnessInputError";
  }
}
