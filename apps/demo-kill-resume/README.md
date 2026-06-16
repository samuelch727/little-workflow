# `demo-kill-resume`

The alpha kill-and-resume demo. It spawns a child process that runs a workflow
with a bounded `parallel` step over two branches — `fast-a` (finishes quickly)
and `slow-b` (stalls). The parent kills the child with SIGKILL as soon as the
`fast-a` branch reports `ParallelBranchCompleted` in the event log, then spawns
a second child with the same `runId` to resume from the persisted Local World
event log.

The script prints:

- the events persisted before the kill (planning + `fast-a` completion)
- the events persisted after the resume (everything, ending in `RunCompleted`)
- the event-stream diff (events added by the resume — `slow-b` work plus fan-in)
- a check that the completed `fast-a` tool handler did not run again

## Run

```bash
pnpm --filter little-workflow build
pnpm --filter demo-kill-resume demo
```

The demo uses a temporary directory under `$TMPDIR/lwf-kill-resume-*` for the
Local World data; it is removed at the end of a successful run.
