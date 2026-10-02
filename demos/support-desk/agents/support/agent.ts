import { createHarness, localHost } from "little-harness";
import { dataDir, demoRoot, supportModel } from "./env";

/**
 * "Support" — the Northwind Goods customer-support agent.
 *
 * A τ²-bench-shaped demo: the failures worth measuring here are not wrong sentences, they
 * are wrong ACTIONS. The agent's tools (`tools/`) really mutate an episode database, and a
 * run is graded on what exists in that database afterwards — plus, separately, on whether
 * the sequence of calls obeyed `policy.md`.
 *
 * Two construction choices are load-bearing for that measurement.
 *
 * **`bash: false`.** The harness gives every session a shell by default. With one, the model
 * could edit `db.json` directly — mutating the world without appearing in the action log, so
 * end-state grading and compliance grading would disagree for reasons that have nothing to
 * do with the policy. Turning it off makes the tool surface the *only* way to act, which is
 * what makes the action log a complete record. (The agent still reads the policy: that is
 * what `read_policy` is for.)
 *
 * **`maxConcurrentToolCalls: 1`.** The ordering predicates — "`lookup_order` with a matching
 * email must come *before* `refund_order`" — read the order of `actions.jsonl`, so anything
 * that made that order a race would score correct runs as verification failures at random.
 *
 * Being precise about what this budget does and does not buy, because the log's integrity
 * should not rest on a misreading: it bounds the harness's ASYNC tool-task queue
 * (`acquireToolSlot` in `local-host/durable-services.ts`), not the synchronous execution of
 * several tool calls the model emits in one step. What actually makes the log safe is that
 * `runToolCall` is synchronous end to end — read, mutate, write, append, with no `await` in
 * between — so on a single-threaded runtime each call is atomic and two calls can never
 * interleave. The budget is belt to that braces. And a model that emitted a lookup and a
 * refund in the SAME step would not have seen the verification result before acting, which
 * is a policy violation on any ordering, so the grader's verdict is right either way.
 */
export default createHarness({
  host: localHost({ dataDir, projectRoot: demoRoot }),
  model: supportModel(),
  runtime: { bash: false },
  workflowBudgets: {
    maxConcurrentToolCalls: 1,
    // An episode is small on purpose: read the policy, look the order up (twice if the first
    // email did not match), act once, explain. Ten model steps is roughly double the longest
    // compliant path, so a run that hits the ceiling has genuinely lost the plot rather than
    // been cut off mid-thought.
    maxModelSteps: 10,
    maxToolCallsPerTurn: 20,
  },
});
