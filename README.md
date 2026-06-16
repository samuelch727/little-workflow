# Little Workflow

**Local-first TypeScript runtime for workflows that an AI agent designs for itself.**

> ⚠️ **Alpha.** `0.1.0-alpha.x` is an early release phase. The LWIR wire format and
> public APIs may change between alpha releases. Not yet recommended for production.
> See the [changelog](./CHANGELOG.md) for release notes.

The developer describes a goal, the available capabilities, the models, and the
constraints; an AI planner generates a bounded workflow graph; Little Workflow
**validates it, executes it durably, persists every artifact, and lets you replay,
retry, fork, inspect, or audit every step.**

Existing durable-execution SDKs require humans to author the workflow. Little
Workflow's contribution is letting the *agent* be the author — with the developer
providing the goal, capabilities, budgets, and steering, not the graph.

## Why it's interesting

- **Agent-generated workflows.** Delegate the *design* of a complex workflow to a
  planner model, not just its execution.
- **Bounded parallel fan-out / fan-in.** A strong model plans once; cheap models do
  the work concurrently. A deliberate cost play: planner-grade model × 1 + cheap
  execution models × N, rather than expensive everywhere.
- **Durability.** Kill-and-resume across crashes via per-step memoization on a
  durable event log — table stakes for a serious runtime.
- **Replay & audit.** Every run is an append-only event log you can inspect and
  replay deterministically.
- **AI SDK-native.** Built on the [Vercel AI SDK](https://sdk.vercel.ai); bring any
  `LanguageModel` from any provider.

## Packages

| Package | Description |
|---|---|
| [`little-workflow`](./packages/little-workflow) | Workflow authoring, planner compilation, LWIR validation, durable Local World execution/replay, and the `little` CLI. |
| [`little-harness`](./packages/little-harness) | Local-first agent runtime primitives — sessions, tools, files, traces, persistence — and the workflow harness adapter underneath Little Workflow. |

```sh
pnpm add little-workflow
```

Little Workflow's Local World event store uses `better-sqlite3`. In pnpm v10
projects, approve that native build at your app root:

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

## Demos

Runnable examples live in [`apps/`](./apps/README.md), each proving a different
property of the runtime:

| Demo | Proves | Needs an API key? |
|---|---|---|
| [`demo-kill-resume`](./apps/demo-kill-resume) | Kill-and-resume durability across a mid-run `SIGKILL`. | No |
| [`demo-orchestrator-fanout`](./apps/demo-orchestrator-fanout) | Plan-once, run-many sub-workflows in parallel. | No |
| [`demo-real-planner`](./apps/demo-real-planner) | The wedge — an agent designs a bounded parallel workflow from a goal. | Yes (`DEEPSEEK_API_KEY`) |
| [`demo-sp500-investor-report`](./apps/demo-sp500-investor-report) | ZIP-in, Markdown-out research workflow over external data. | Live: yes; stub: no |

```sh
pnpm install
pnpm --filter little-workflow build
pnpm --filter demo-kill-resume demo   # keyless durability proof
```

## Repository layout

```
packages/little-workflow   # the workflow SDK + `little` CLI
packages/little-harness     # the agent runtime primitives
apps/                       # runnable demos + documentation sites
skills/                     # authored agent skills for the packages
```

## Development

Requires Node.js `>=20.19` and `pnpm@10`.

```sh
pnpm install
pnpm verify     # build + lint + typecheck + test across the monorepo
```

Individual steps: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). By
participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a
security issue, see [`SECURITY.md`](./SECURITY.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).
