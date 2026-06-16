# Little Harness

Little Harness is the agent runtime package underneath Little Workflow. It provides local sessions, file/artifact handling, model/tool loop helpers, durability events, and a workflow-specific harness adapter.

## Install

```sh
pnpm add little-harness ai
```

Use any AI SDK `LanguageModel` from your provider package. `createHarness()` requires a model.

## License

Licensed under the [Apache License 2.0](./LICENSE).

## Which Entry Point To Use

Use `little-harness` when you want the generic agent runtime primitives:

```ts
import {
  createHarness,
  generateHarness,
  localHost,
  streamHarness,
} from "little-harness";
```

Use `little-harness/workflow-harness` when you want the Little Workflow-compatible harness contract directly:

```ts
import {
  createWorkflowHarness,
  runWorkflowHarnessWithSession,
  workflowHarness,
} from "little-harness/workflow-harness";
```

Use `little-workflow` when you want workflow authoring, planning, event-log durability, replay, and the CLI. Little Workflow uses `workflowHarness` by default, so most workflow apps do not need to import Little Harness directly.

## Custom Workflow Harness

```ts
import { createWorkflowHarness } from "little-harness/workflow-harness";

export const cloudHarness = createWorkflowHarness({
  aiLoop: {
    async generate({ model, system, messages, tools, signal }) {
      // Call your agent loop or provider here.
      return {
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
});
```

Custom harnesses can handle any subset of workflow task kinds and return `{ kind: "delegate_to_default" }` to let Little Workflow run the built-in `workflowHarness` for that task.

## Event Names

Durable workflow harness events use dotted names:

- `harness.session.started`
- `harness.model.responded`
- `harness.tool_call.started`
- `harness.execute_step.succeeded`

For orchestrator sub-runs, `run_workflow` and `start_workflow` reserve `payload.args.subRunId` in `harness.tool_call.started` before the child run starts, and return the same ID as `payload.result.runId` on success.
