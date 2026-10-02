# ticket-factory

Hands a raw markdown task spec to a **fully autonomous coordinator** and lets it
design + execute the work that produces the requested deliverables. The point is
to evaluate the Little Workflow SDK on a realistic, messy generation task.

`spec/task.md` asks for a fake CloudDesk support-ticket dataset. The coordinator
(an orchestrator harness driven by DeepSeek) reads it, plans the
`support.ticket.batch` workflow once, and fans out `run_workflow` across batches.
The generated tickets are harvested from the durable event log, renumbered,
validated, and written to `out/`.

All three roles — orchestrator, planner, worker — run on the SDK's native
`createWorkflowHarness({ aiSdkModule: ai })`. This is the maximally SDK-native path,
so whatever breaks is a real SDK finding.

## Run

```bash
pnpm --filter little-workflow build

# keyless deterministic smoke run
pnpm --filter ticket-factory demo:stub        # default 20 tickets
node run.mjs stub 8

# live run (reads DEEPSEEK_API_KEY from env or repo-root .env.local)
pnpm --filter ticket-factory demo             # default 20 tickets
node run.mjs 40
```

Environment knobs:

- `TICKET_COUNT` — total tickets (CLI arg overrides).
- `TICKET_BATCH_SIZE` — tickets per sub-run (default 10).
- `MAX_CONCURRENT_SUBRUNS` — fan-out concurrency cap (default 4).
- `DEEPSEEK_MODEL_ID` (default `deepseek-v4-pro`), `DEEPSEEK_BASE_URL`.

## Output

- `out/support_tickets_fake.json` — the dataset.
- `out/support_tickets_answer_key.csv` — ground-truth labels.

The run also prints an SDK-performance report: tickets produced vs requested,
schema validity, actual-vs-target label distributions, ID uniqueness, wall-clock
time, token usage + tokens-per-ticket, and fixer/tool-failure counts.

## Tests

```bash
pnpm --filter ticket-factory test
```

Covers the pure helpers (ticket schema/validation, batch planning, event
harvest, distribution, CSV) without any network call.
