# demo-orchestrator-fanout

Deterministic orchestrator fan-out demo for alpha.

What it proves:

- Orchestrator role runs as a harness session.
- `plan_workflow` is called once.
- `run_workflow` fan-outs parallel sub-runs (bounded by `maxConcurrentSubRuns`).
- Sub-runs complete with independent `runId`s and tool outputs.
- Harness tool-call events are recorded for orchestrator-level workflow delegation.

No API key required.

## Run

```bash
pnpm --filter demo-orchestrator-fanout demo
```

Expected output includes:

- `Sub-runs completed: 30/30`
- `run_workflow tool calls: 30`
