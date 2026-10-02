# Workflow Harness Adapter

`little-harness/workflow-harness` exposes the adapter contract used by `little-workflow`. Most Little Workflow apps should import from `little-workflow`; use this entry point when customizing the workflow harness itself.

```ts
import {
  createWorkflowHarness,
  runWorkflowHarnessWithSession,
  workflowHarness,
  WORKFLOW_HARNESS_ID,
} from "little-harness/workflow-harness";
```

## Default Harness

`workflowHarness` is `workflowHarness@1.0.0`. It handles:

- `plan`
- `orchestrate`
- `fix_step`
- `execute_step` for `ai.generate` and `tool.call`
- `execute_step` for `code.run` **only as far as validating its sandbox declaration** — it then
  throws rather than executing the code body (see [Step Behavior](#step-behavior))

It delegates unsupported workflow step kinds, such as runtime-owned `decision` or `parallel`, back to the caller with `{ kind: "delegate_to_default" }`.

## Custom Harness

```ts
import { createWorkflowHarness } from "little-harness/workflow-harness";

export const cloudHarness = createWorkflowHarness({
  aiLoop: {
    async generate({ model, system, messages, tools, signal, step, input }) {
      return {
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
});
```

Return `{ kind: "delegate_to_default" }` from your custom handling when a task should fall back to the default harness in Little Workflow.

## Step Behavior

- `tool.call` executes one named tool and emits session, execute-step, and tool-call events.
- `ai.generate` calls the configured AI loop with model, system, messages, tools, step, input, and abort signal.
- `code.run` **is not executed.** `executeCodeRunStep` validates the step's sandbox declaration and then throws: `"Workflow code.run step '<id>' cannot safely execute code.run in the default workflow harness. The declared sandbox.env/fs/network deny policy requires an isolated runtime."` There is no built-in code executor; the default harness fails closed rather than running the step body in-process.

`code.run` requires a restrictive sandbox declaration — network, env, and filesystem must all be `deny`, and any other sandbox key is rejected. That declaration is **validated, not enforced**: because nothing executes, there is nothing to confine.

To actually run `code.run` steps you need a harness that implements the `execute_step` task for them, wired as `worker.harness` on the workflow definition. Note that `createWorkflowHarness()` is **not** that route — its options cover only the AI loop, model-call timeouts/retries, and conversation compaction, with no `code.run` hook. You must supply an object satisfying the `Harness` contract (`{ harnessId, run(task, ctx) }`) directly. Execution *and* isolation are then your responsibility.

## Tool Permissions

The workflow harness enforces inherited tool permissions before direct tool execution. A rule's `tool` is a **glob** over the tool name — `*` stands for any run of characters, so `"delete_*"` gates `delete_record`, `"bash*"` gates `bash`, and `"*"` matches every tool. A matching `deny` short-circuits (most restrictive wins — an `allow` rule never overrides a matching `deny`), and a denied tool is never executed. An `ask` rule requires an approval callback and fails closed if approval is missing or declined.

## Durable Events

Workflow harness runs emit dotted event names such as:

- `harness.session.started`
- `harness.execute_step.started`
- `harness.model.called`
- `harness.tool_call.started`
- `harness.execute_step.succeeded`
- `harness.session.completed`

For orchestrator sub-runs, `run_workflow` and `start_workflow` reserve `payload.args.subRunId` in `harness.tool_call.started` before the child run starts, and return the same ID as `payload.result.runId` on success. (Those tools belong to Little Workflow's **deprecated** orchestrator surface. To compose workflows into an agent, use `asHarnessWorkflow` + `createHarness({ workflows })` instead — each workflow becomes its own tool.)
