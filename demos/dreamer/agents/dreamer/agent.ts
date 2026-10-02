import { createHarness, localHost } from "little-harness";
import { dynamicWorkflows } from "little-workflow";
import { dataDir, dreamerModel } from "./env";

/**
 * "Dreamer" — the agent that investigates why a harness's success rate is what it is.
 *
 * The tools (`tools/`) are its window onto littleDB; the template workflows (`workflows/`)
 * are its investigation instruments; `instructions.md` is the doctrine that says when to
 * reach for which. All three are auto-discovered by `loadHarness`.
 *
 * The unusual choice here is that dynamic workflows stay ENABLED. The templates cover the
 * investigation the demo is about, and the instructions say to prefer them — but an
 * investigator that can only ask its three pre-built questions is not an investigator. A
 * hypothesis the templates cannot express is exactly the case `run_ad_hoc_plan` exists for,
 * and taking it away would make the agent quietly stop investigating rather than visibly
 * reach for a new instrument.
 */
export default createHarness({
  host: localHost({ dataDir }),
  model: dreamerModel(),
  dynamicWorkflows: dynamicWorkflows(),
  workflowBudgets: {
    // The sweep is a fan-out: the model emits one `dream_incident_card` call per failure run
    // in a single step, and the AI SDK executes them in parallel. This is the bound that
    // makes that safe — all workflow tools of the session share one pool, so N parallel
    // calls become at most 4 concurrent runs (4 concurrent provider requests), and the rest
    // queue rather than fail. Deliberately below the default of 10: every card is a model
    // call against one provider account.
    maxConcurrentWorkflowRuns: 4,
    // An investigation is a long single turn: evidence pack, a sweep, a cluster, one or two
    // drill-downs, then a submit — plus up to two citation repairs. The default of 20 model
    // steps runs out mid-repair, and a truncated investigation looks like a bad one.
    maxModelSteps: 40,
    maxToolCallsPerTurn: 200,
  },
});
