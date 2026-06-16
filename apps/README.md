# Demos

The alpha ships with four runnable demos. Each proves a different property of the runtime.

| Demo | What it proves | Requires API key? |
|---|---|---|
| [`demo-kill-resume`](./demo-kill-resume/README.md) | Kill-and-resume durability — a workflow run survives a `SIGKILL` mid-execution and resumes without re-calling committed steps. Hand-authored LWIR, stub planner. CI-runnable. | No |
| [`demo-orchestrator-fanout`](./demo-orchestrator-fanout/README.md) | Orchestrator pipeline composition — plan once, run many sub-workflows in parallel via `plan_workflow` / `run_workflow` tool delegation. | No |
| [`demo-real-planner`](./demo-real-planner/README.md) | The wedge — an AI agent designs a bounded parallel candidate-review workflow from a goal. Single-cycle and supervisor variants. Uses a real AI SDK provider. | Yes (`DEEPSEEK_API_KEY`) |
| [`demo-sp500-investor-report`](./demo-sp500-investor-report/README.md) | ZIP-in, Markdown-out investor research workflow — unzips the supplied S&P 500 top-50 SEC archive, analyzes companies in parallel, and recommends stocks. | Yes for live (`DEEPSEEK_API_KEY`); no for stub |

## Quick start

```bash
pnpm install
pnpm --filter little-workflow build

# Durability:
pnpm --filter demo-kill-resume demo

# Orchestrator fan-out (plan-once, run-many):
pnpm --filter demo-orchestrator-fanout demo

# Agent-generated workflow (single cycle):
export DEEPSEEK_API_KEY=...
pnpm --filter demo-real-planner demo:single

# Agent-generated workflow with supervisor (up to 3 cycles):
pnpm --filter demo-real-planner demo:supervisor

# S&P 500 investor report from ZIP (keyless smoke):
pnpm --filter demo-sp500-investor-report demo:stub -- \
  --archive path/to/sp500_top50_reports.zip \
  --limit 5
```

The `demo-kill-resume` demo is the durability proof. The `demo-orchestrator-fanout` demo is the orchestration proof. The `demo-real-planner` demo is the wedge proof for model-driven planning. The `demo-sp500-investor-report` demo is the ZIP-to-report proof for external data ingestion. Each demo has its own README with details.
