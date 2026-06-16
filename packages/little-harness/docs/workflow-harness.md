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
- `execute_step` for `ai.generate`, `tool.call`, and `code.run`

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
- `code.run` materializes the step files into a temporary source directory, imports the entrypoint, and calls the exported `default` or `main` function with `{ input, tools }`.

`code.run` requires a restrictive sandbox declaration. It only supports denied network, env, and filesystem sandbox policy in the current local implementation.

## Tool Permissions

The workflow harness enforces inherited tool permissions before direct tool execution. A denied tool is never executed. An `ask` rule requires an approval callback and fails if approval is missing or declined.

## Durable Events

Workflow harness runs emit dotted event names such as:

- `harness.session.started`
- `harness.execute_step.started`
- `harness.model.called`
- `harness.tool_call.started`
- `harness.execute_step.succeeded`
- `harness.session.completed`

For orchestrator sub-runs, `run_workflow` and `start_workflow` reserve `payload.args.subRunId` in `harness.tool_call.started` before the child run starts, and return the same ID as `payload.result.runId` on success.
