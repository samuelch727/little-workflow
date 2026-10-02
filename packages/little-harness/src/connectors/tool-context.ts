import type { ToolExecutionOptions } from "ai";
import { HarnessInputError } from "../errors.js";
import type { HarnessToolExecutionContext } from "../types.js";

/**
 * The full second argument a connector tool's `execute(input, options)` receives at runtime: the AI
 * SDK's {@link ToolCallOptions} (toolCallId, messages, abortSignal, ...) plus the Little Harness
 * context ({@link HarnessToolExecutionContext}) the runtime spreads in (session, files, artifacts,
 * connector, extraBody, ...). The static AI SDK types do not declare the harness half, so tool
 * authors read it through {@link harnessToolContext} / {@link tryHarnessToolContext} instead of
 * casting.
 */
export type HarnessToolCallContext<TExtraBody = unknown> = ToolExecutionOptions<unknown> &
  HarnessToolExecutionContext<TExtraBody>;

function hasHarnessToolContext(options: unknown): boolean {
  if (typeof options !== "object" || options === null) {
    return false;
  }
  const candidate = options as { session?: unknown; files?: unknown };
  return (
    typeof candidate.session === "object" &&
    candidate.session !== null &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}

/**
 * Read the Little Harness execution context out of a connector tool's `execute(input, options)`
 * second argument, typed and cast-free. Returns `undefined` when the tool was invoked outside a
 * Little Harness run — use this for tools that also run standalone.
 */
export function tryHarnessToolContext<TExtraBody = unknown>(
  options: unknown,
): HarnessToolExecutionContext<TExtraBody> | undefined {
  return hasHarnessToolContext(options)
    ? (options as HarnessToolExecutionContext<TExtraBody>)
    : undefined;
}

/**
 * Read the Little Harness execution context out of a connector tool's `execute(input, options)`
 * second argument, typed and cast-free. Throws when the tool was invoked outside a Little Harness
 * run (no `session`/`files` present) — use {@link tryHarnessToolContext} for tools that also run
 * standalone.
 */
export function harnessToolContext<TExtraBody = unknown>(
  options: unknown,
): HarnessToolExecutionContext<TExtraBody> {
  const ctx = tryHarnessToolContext<TExtraBody>(options);
  if (ctx === undefined) {
    throw new HarnessInputError("Tool was executed outside a Little Harness run.", {
      hint:
        "This tool reads Little Harness context (session/files/connector/extraBody) from its " +
        "execute() options. Run it through a Little Harness connector or streamHarness/generateHarness, " +
        "or use tryHarnessToolContext() to guard when the tool may also run standalone.",
    });
  }
  return ctx;
}
