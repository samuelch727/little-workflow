import type { HarnessInputType } from "../types.js";

export function inputType<TInput, TOutput = unknown, TExtraBody = unknown>(
  definition: HarnessInputType<TInput, TOutput, TExtraBody>,
): HarnessInputType<TInput, TOutput, TExtraBody> {
  return definition;
}
