import { isStepCount, type StopCondition } from "ai";

/** The configured cap always applies, independently of caller stop conditions. */
export function modelStepBudget(
  maxModelSteps: number,
  caller: StopCondition<any> | StopCondition<any>[] | undefined,
  onSoftStop?: (reason: "step-limit" | "stop-condition") => void,
): StopCondition<any> {
  const cap = isStepCount(maxModelSteps);
  const conditions = caller === undefined ? [] : Array.isArray(caller) ? caller : [caller];
  return async (event) => {
    // One composite condition makes source attribution deterministic even when both fire.
    if (await cap(event)) {
      if (event.steps.at(-1)?.toolCalls.length) onSoftStop?.("step-limit");
      return true;
    }
    for (const condition of conditions) {
      if (await condition(event)) {
        if (event.steps.at(-1)?.toolCalls.length) onSoftStop?.("stop-condition");
        return true;
      }
    }
    return false;
  };
}
