# remote-resume

Dogfoods the little-harness managed-agents ports end to end, across real process
boundaries:

- **Sandbox** — the harness runs agent bash through `subprocessSandbox()` (a child
  process spawned with a stripped environment).
- **Session log** — the durable event log lives behind `startSessionLogServer()` with a
  file-backed store (`createFileSessionLog`), reached via `remoteSessionLog()` with
  bearer auth.
- **Kill and resume** — the phase-1 harness process SIGKILLs itself after recording two
  turns. The session-log **server is then restarted** over the same file, and a fresh
  harness process (new pid, new data dir; only the run ids and the log URL are shared)
  resumes both runs.

The demo asserts, via process exit code:

1. the completed single-step text turn resumes with **zero provider calls**;
2. the multi-step turn's tool side effects are **not re-executed** on resume (the model
   is re-called per step by design — side effects are what replay memoizes);
3. both resumed turns return the originally recorded results.

## Run

```bash
pnpm install
pnpm --filter little-harness build   # the subprocess sandbox worker runs from dist/
pnpm --filter remote-resume demo
```

CI-runnable / Requires API key? **No** — the model is scripted (`ai/test`), so the demo
exercises the ports, not a provider.
