# real-planner

The wedge demo. Uses a real AI SDK provider (DeepSeek by default) to generate
the LWIR for a candidate-review workflow, runs it end-to-end, and prints the
generated workflow plus the final ranking. It also includes a deterministic
`stub` variant for keyless local smoke runs.

## Run

```bash
export DEEPSEEK_API_KEY=...
# optional override, defaults to https://api.deepseek.com/v1
export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
# optional override, defaults to deepseek-v4-pro
export DEEPSEEK_MODEL_ID=deepseek-v4-pro
pnpm --filter little-workflow build
pnpm --filter real-planner demo:single
# or
pnpm --filter real-planner demo:supervisor
# keyless local smoke run
pnpm --filter real-planner demo:stub
# keyless supervisor-loop smoke run
pnpm --filter real-planner demo:stub-supervisor
```

A temporary `.little-workflow-demo-real-planner/` directory is used for Local
World; remove it manually if you want a clean re-run.

## Variants

- `pnpm demo:single` — one-shot planner → run → final output (default).
- `pnpm demo:supervisor` — up to 3 cycles. After each cycle a supervisor call
  reviews the output and decides to either stop (`done`) or request another
  cycle with a refined prompt (`continue`).
- `pnpm demo:stub` — deterministic keyless planner-harness smoke run. Uses a
  local planner harness + tool registry to generate and execute LWIR without
  network calls.
- `pnpm demo:stub-supervisor` — deterministic keyless multi-cycle supervisor
  smoke run. Uses the same local planner harness + tool registry and a local
  supervisor decision function to verify supervisor-loop behavior without
  network calls.

Only the `single` and `supervisor` variants require `DEEPSEEK_API_KEY`.

All demo scripts can also be invoked with `node run.mjs <single|supervisor|stub|stub-supervisor>`
directly.

Logic tests:

```bash
pnpm --filter real-planner test:provider-client
pnpm --filter real-planner test:planner-prompt
pnpm --filter real-planner test:run-cli
pnpm --filter real-planner test:supervisor-logic
pnpm --filter real-planner test:variant-config
```

## What it proves

That an AI agent can design a bounded parallel workflow from a goal. The
generated LWIR is printed before execution so you can inspect what the planner
produced. The supervisor variant additionally demonstrates multi-cycle planning:
the model reviews each cycle output and decides whether to continue.
