# Little Workflow

**Local-first TypeScript runtime for workflows that an AI agent designs for itself.**

> ⚠️ **Alpha.** The `0.x` alpha releases are an early phase: the LWIR wire format,
> public APIs, and persistence formats may change between releases. Not yet
> recommended for production. See the [changelog](./CHANGELOG.md) for release notes.

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
| [`little-harness`](./packages/little-harness) | Local-first agent runtime primitives — sessions, tools, files, traces, persistence, connectors, sandboxed execution — and the workflow harness adapter underneath Little Workflow. |

`@little-workflow/littledb` (in `packages/littledb-client`) is not published yet: it
needs a littleDB service that is not public.

Both packages target **AI SDK 7** (`ai` is a peer dependency) and **Node.js 22+**:

```sh
pnpm add little-workflow@alpha ai@^7 zod @ai-sdk/anthropic   # or any AI SDK 7 provider
pnpm add little-harness@alpha ai@^7 zod @ai-sdk/anthropic    # the agent runtime alone
```

Or scaffold a project: `npx little-workflow@alpha init my-app` writes a starter
workflow with pinned dependencies (`npx little-harness@alpha init` does the same for
an agent).

Little Workflow's Local World event store uses `better-sqlite3`. pnpm 10 skips
dependency build scripts unless they are allowed, so approve that native build at
your app root (`little init` adds this for you):

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

## Demos

Runnable examples live in [`demos/`](./demos/README.md), each proving a different
property of the runtime. A few highlights:

| Demo | Proves | Needs an API key? |
|---|---|---|
| [`kill-resume`](./demos/kill-resume) | Kill-and-resume durability across a mid-run `SIGKILL`. | No |
| [`remote-resume`](./demos/remote-resume) | Sandboxed bash in a child process and a remote session log; a killed harness resumes in a fresh process. | No |
| [`real-planner`](./demos/real-planner) | The wedge — an agent designs a bounded parallel workflow from a goal. | Live: yes; stub: no |
| [`support-command-center`](./demos/support-command-center) | One agent over CLI chat, a web UI, and Chat SDK connectors. | Yes (`DEEPSEEK_API_KEY`) |
| [`kb-chatbot`](./demos/kb-chatbot) | A knowledge-base chatbot with attachments, citations, and outcome capture. | Yes (`DEEPSEEK_API_KEY`) |

See [`demos/README.md`](./demos/README.md) for all twelve, including which need the
non-public littleDB service.

```sh
pnpm install
pnpm --filter little-harness build && pnpm --filter little-workflow build
pnpm --filter kill-resume demo   # keyless durability proof
```

## Repository layout

```
packages/little-workflow   # the workflow SDK + `little` CLI
packages/little-harness     # the agent runtime primitives
demos/                      # runnable demos
apps/                       # documentation sites
skills/                     # authored agent skills for the packages
```

## Development

Requires Node.js `>=22` and `pnpm@10`.

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
