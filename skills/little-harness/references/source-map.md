# Source Map

Use source and tests to verify docs when behavior matters.

| Task | Source files |
| --- | --- |
| Public exports | `packages/little-harness/src/index.ts` |
| Harness creation and config normalization | `packages/little-harness/src/create-harness.ts`, `packages/little-harness/src/types.ts` |
| Non-streaming runs | `packages/little-harness/src/execution/generate-harness.ts` |
| Streaming chat routes | `packages/little-harness/src/execution/stream-harness.ts` |
| AI SDK messages and runtime tools | `packages/little-harness/src/runtime/messages.ts`, `packages/little-harness/src/runtime/tools.ts` |
| Local host sessions and paths | `packages/little-harness/src/local-host/` |
| File and artifact handling | `packages/little-harness/src/files/`, `packages/little-harness/src/execution/evented-file-writer.ts` |
| Persistent dirs | `packages/little-harness/src/persistent-dir/commit.ts`, `packages/little-harness/src/local-host/local-dir.ts` |
| Memory helper | `packages/little-harness/src/memory/memory.ts` |
| Skill staging | `packages/little-harness/src/skills/` |
| Trace inspection and validation | `packages/little-harness/src/trace/` |
| Durable model and tool replay | `packages/little-harness/src/events/durability.ts`, `packages/little-harness/src/events/occurrence.ts` |
| Little Workflow adapter | `packages/little-harness/src/workflow-harness/` |

Tests are often the fastest examples. Use:

```bash
rg "createHarness|streamHarness|generateHarness|inputType|memory|workflowHarness" packages/little-harness/src -g '*.test.ts'
```
