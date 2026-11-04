# Demos

Runnable demos, each proving a different property of the runtime. They run against
the workspace packages; build those first:

```bash
pnpm install
pnpm --filter @little-stack/harness build
pnpm --filter @little-stack/workflow build
```

Live runs read `DEEPSEEK_API_KEY` from the environment (or a repo-root
`.env.local`). Demos under **LittleDB** need a LittleDB server, which is not
public yet, reached with `LITTLEDB_URL` and `LITTLEDB_API_KEY`; each says which
modes still run without it.

## Keyless

| Demo | What it proves | Run |
|---|---|---|
| [`kill-resume`](./kill-resume/README.md) | Kill-and-resume durability: a workflow run survives a `SIGKILL` mid-execution and resumes without re-calling committed steps. CI-runnable. | `pnpm --filter kill-resume demo` |
| [`remote-resume`](./remote-resume/README.md) | The managed-agents ports across process boundaries: agent bash in `subprocessSandbox()`, the durable log behind a restartable session-log HTTP service, and a `SIGKILL`ed harness resumed by a fresh process with zero provider calls for the completed turn. CI-runnable. | `pnpm --filter remote-resume demo` |
| [`workerd-chats`](./workerd-chats/README.md) | Self-hosted workerd chats with per-chat SQLite files, questions, history and traces. Diskless one-shot plans and reusable workflows keep completed definitions and plans across restart. Optional LittleDB export and OpenAI-compatible LAN model. Real-workerd tests cover restart, SIGKILL and trace pruning, with no provider keys. | `pnpm --filter workerd-chats test`; `pnpm build && pnpm serve` in its folder |
| [`orchestrator-fanout`](./orchestrator-fanout/README.md) | Plan once, run many sub-workflows in parallel. Uses the **deprecated** orchestrator surface. | `pnpm --filter orchestrator-fanout demo` |

## Live (DeepSeek), most with a keyless stub mode

| Demo | What it proves | Run |
|---|---|---|
| [`real-planner`](./real-planner/README.md) | The wedge: an agent designs a bounded parallel candidate-review workflow from a goal. Single-cycle and supervisor variants. | `demo:single`, `demo:supervisor`; keyless `demo:stub` |
| [`sp500-investor-report`](./sp500-investor-report/README.md) | ZIP-in, Markdown-out research: unzips an S&P 500 SEC archive you supply, analyzes companies in parallel, recommends stocks. | `demo:live`; keyless `demo:stub` |
| [`support-command-center`](./support-command-center/README.md) | Little Harness connectors: one support agent over CLI chat, a web-rich UI, and Chat SDK (Discord/Slack) with portable sessions and mirror delivery. | `harness:chat`, `dev` |
| [`ticket-factory`](./ticket-factory/README.md) | An autonomous coordinator turns a messy markdown spec into a generated ticket dataset. Uses the **deprecated** orchestrator surface. | `demo`; keyless `demo:stub` |
| `hiring-candidates` | A hiring post plus a pool of generated candidates, fanned out in batches. Uses the **deprecated** orchestrator surface. | `node run.mjs [count]`; keyless `node run.mjs stub` |
| `delegated-candidates` | The maximal-delegation counterpart: only an output schema and a one-line goal. Uses the **deprecated** orchestrator surface. | `node run.mjs [count]`; keyless `node run.mjs stub` |

## LittleDB

| Demo | What it proves | Without LittleDB |
|---|---|---|
| [`kb-chatbot`](./kb-chatbot/README.md) | A knowledge-base chatbot that ingests chat attachments, cites sources, turns 👍/👎 into LittleDB scores, and runs the prompt version LittleDB resolves. | `pnpm --filter kb-chatbot demo` runs fully offline; `demo:loop` needs LittleDB |
| [`support-desk`](./support-desk/README.md) | A τ²-style support agent whose failures are wrong *actions*, verified against database end state; traffic, a dataset, an eval worker and proposals against LittleDB. | `harness:chat` and the test suite; the experiment scripts need LittleDB |
| `dreamer` | An agent that investigates failed runs from templates and submits improvement proposals. Still written against the earlier LittleDB API. | Tests only (`pnpm --filter dreamer test`) |

## Experimental

| Demo | What it proves | Run |
|---|---|---|
