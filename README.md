# The Little stack

**Agents that get better from the conversations they have.**

> ⚠️ **Alpha.** The `0.x` alpha releases are an early phase: the LWIR wire format,
> public APIs, and persistence formats may change between releases. Not yet
> recommended for production. See the [changelog](./CHANGELOG.md) for release notes.

The Little stack is three things that fit together:

- **LittleDB** is the product. It records what your agents and workflows do as
  traces, scores them (code checks, AI judges, people, and what your users said),
  and improves them: a reviewer reads the traces and proposes a change, LittleDB
  tests the change on your own past conversations, checks it against your
  guardrails, and puts it live or asks a person. It rolls back what makes things
  worse. LittleDB is private for now; the client in this repository
  ([`packages/littledb-client`](./packages/littledb-client)) is how an app talks to it.
- **Little Harness and Little Workflow** are the SDK. You build agents with
  Harness (sessions, tools, skills, files, artifacts, traces, chat connectors) and
  bounded, durable jobs with Workflow (an agent designs the workflow, Workflow
  validates and runs it). LittleDB traces both and improves both; they run fully
  without it.
- **Workspaces** are where an agent's work lives: each user's own folder, kept
  between visits and ready when they return. Most turns run on the folder tier
  (an emulated shell over the user's files, in process, in milliseconds). A
  command that needs a real machine (git, a package manager, a build, tests)
  wakes a container that sleeps again after ten idle minutes. Managed
  workspaces come with LittleDB's hosted service (LittleDB is private for now);
  self-hosted workspaces run with
  Little Compute on rootless Podman (not included in this public source snapshot).

The same agent folder (`agent.ts`, `tools/`, `skills/`, workflows) runs
unchanged on a laptop or a Podman box today, and on the managed tier as it
lands; only the sandbox builder differs. That portability, the merge-back of
parallel children's work into one workspace, and the loop from real user
outcomes back into the agent's configuration are what the stack is for. The
runtime underneath is deliberately thin and replaceable.

```txt
your app or the CLI
  -> Little Harness (agent runtime)          <- Little Workflow (bounded, durable jobs)
       -> workspace: folder tier, container on demand
            managed: LittleDB's hosted service   self-hosted: Little Compute
       -> traces, scores, user feedback  -> LittleDB
       <- which version to run           <- LittleDB (resolve)
```

## Packages

| Package | Description |
|---|---|
| [`@little-stack/harness`](./packages/little-harness) | The agent runtime: sessions, tools, skills, files, traces, persistence, connectors, sandboxed execution, and the workflow harness adapter underneath Little Workflow. |
| [`@little-stack/workflow`](./packages/little-workflow) | Workflow authoring, planner compilation, LWIR validation, durable Local World execution and replay, and the `little` CLI. |
| [`@little-stack/littledb`](./packages/littledb-client) | The LittleDB client: one URL and one API key for traces, versions, scores, user feedback and experiments. Not published: it needs a LittleDB server, which is not public. |

Both published packages target **AI SDK 7** (`ai` is a peer dependency) and **Node.js 22+**:

```sh
pnpm add @little-stack/harness@alpha ai@^7 zod @ai-sdk/anthropic    # the agent runtime
pnpm add @little-stack/workflow@alpha ai@^7 zod @ai-sdk/anthropic   # adds bounded, durable workflows
```

Or scaffold a project: `npx @little-stack/harness@alpha init` writes an agent folder, and
`npx @little-stack/workflow@alpha init my-app` writes a starter workflow, both with pinned
dependencies.

Little Workflow's Local World event store uses `better-sqlite3`. pnpm 10 skips
dependency build scripts unless they are allowed, so approve that native build at
your app root (`little init` adds this for you):

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

## Why Workflow

Existing durable-execution SDKs require humans to author the workflow. Little
Workflow lets the *agent* be the author, with the developer providing the goal,
capabilities, budgets, and steering, not the graph.

- **Agent-generated workflows.** Delegate the design of a complex workflow to a
  planner model, not just its execution.
- **Bounded parallel fan-out and fan-in.** A strong model plans once; cheap models do
  the work concurrently.
- **Durability.** Kill-and-resume across crashes via per-step memoization on a
  durable event log.
- **Replay and audit.** Every run is an append-only event log you can inspect and
  replay deterministically.
- **AI SDK-native.** Built on the [Vercel AI SDK](https://sdk.vercel.ai); bring any
  `LanguageModel` from any provider.

## Demos

Runnable examples live in [`demos/`](./demos/README.md), each proving a different
property of the runtime. A few highlights:

| Demo | Proves | Needs an API key? |
|---|---|---|
| [`kill-resume`](./demos/kill-resume) | Kill-and-resume durability across a mid-run `SIGKILL`. | No |
| [`remote-resume`](./demos/remote-resume) | Sandboxed bash in a child process and a remote session log; a killed harness resumes in a fresh process. | No |
| [`real-planner`](./demos/real-planner) | An agent designs a bounded parallel workflow from a goal. | Live: yes; stub: no |
| [`support-command-center`](./demos/support-command-center) | One agent over CLI chat, a web UI, and Chat SDK connectors. | Yes (`DEEPSEEK_API_KEY`) |
| [`kb-chatbot`](./demos/kb-chatbot) | A knowledge-base chatbot with attachments, citations, and outcome capture. | Yes (`DEEPSEEK_API_KEY`) |

See [`demos/README.md`](./demos/README.md) for the exported examples, including which need the
non-public LittleDB server. Compute-dependent examples are not included.

```sh
pnpm install
pnpm --filter @little-stack/harness build && pnpm --filter @little-stack/workflow build
pnpm --filter kill-resume demo   # keyless durability proof
```

## Repository layout

```
packages/little-harness     # the agent runtime primitives
packages/little-workflow    # the workflow SDK + `little` CLI
packages/littledb-client    # the LittleDB client (private until LittleDB is public)
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

Contributions are welcome; see [`CONTRIBUTING.md`](./CONTRIBUTING.md). By
participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a
security issue, see [`SECURITY.md`](./SECURITY.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).
