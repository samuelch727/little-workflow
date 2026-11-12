# Agent folders on self-hosted workerd (0.2.0-alpha.3)

A standalone Little Harness app using the recommended `agents/<name>/` layout. No
LittleDB service, Cloudflare account, model key or network connection is required
at runtime. A deterministic AI SDK model drives real tools and bash. Replace the
model with a workerd-compatible provider when needed and explicitly configure
workerd's outbound access for it.

From the monorepo root (Node 22+ and pnpm 10.27):

```sh
pnpm install --frozen-lockfile
pnpm --filter @little-stack/harness build
pnpm --filter workerd-folders build
mkdir -p demos/workerd-folders/data
cd demos/workerd-folders
pnpm serve
```

Build invokes `compile.mjs` to generate `src/agents.generated.ts` from every direct
`agents/` child containing `agent.ts`, then bundles the worker with Wrangler's
**dry-run** only. `workerd serve` runs the resulting static bundle locally. Rebuild
and restart after editing any agent, tool, instruction, workflow or skill asset.

```sh
curl -H 'content-type: application/json' \
  -d '{"text":"count:hello offline world"}' \
  http://127.0.0.1:8080/agents/support/chats/one/messages
curl -H 'content-type: application/json' \
  -d '{"text":"cat /.agents/skills/guide/assets/note.txt"}' \
  http://127.0.0.1:8080/agents/support/chats/one/messages
```

The `other` agent uses the same URL layout. `counter` demonstrates per-chat factory
state; `system` shows instructions and skill metadata; `history` counts user turns;
`fail:<command>` deliberately fails after executing a tool for recovery checks;
`pause:500` exercises the discovered asynchronous tool; any other text runs bash.
GET the messages URL to read that chat's saved history.

The router keys Durable Objects by the tuple `[agent, chat]`. Each object gets its
own filesystem, host, agent factory invocation, history and turn queue. Different
chats can overlap, while one chat's turns execute serially in arrival order.
`agent.ts` may also export an already-created Harness, as the Node loader accepts,
but use a host factory for mutable tool closures and per-chat models. Module-level
state and default-exported tool objects are shared JavaScript code: keep them
stateless, or create stateful tools inside the agent factory.

`data/` stores Durable Object SQLite files. Regular files and history survive a
process restart; empty directories, filesystem symlinks and factory counters do
not. Files and history are saved separately, so a process crash during those saves
is not an atomic transaction across both. A user attempt is saved before execution;
partial file writes are saved even when execution fails, so later successful turns
do not silently commit a failed attempt. This is partial-progress persistence, not
transactional rollback. This minimal demo does not implement
human-input restart durability, authentication, limits or TLS. Keep its default
loopback listener for local use; a production application must supply its ingress
and identity rules. The larger `workerd-chats` demo covers durable human input.

## Compiler contract

`@little-stack/harness/compiler` is a Node-only build entry point. Both
`compileHarnessFolder(folder, { moduleDir })` and
`compileHarnessWorkspace(root, { moduleDir })` return TypeScript source; the caller
writes it to a module in `moduleDir`. Enable `allowImportingTsExtensions` with
`noEmit` when typechecking this generated source. The workspace compiler uses the
same optional `little-harness.json` marker as `loadWorkspace`.

Static imports include `agent.ts`, discovered tools, workflow objects, and skill
modules. Instructions become a prompt fallback; inline tools/system win. Workflow
and reserved-name validation is shared with the Node loader. Bare skill folders
embed metadata and every regular asset, including nested binary files, without
reading disk at runtime. `skill.ts` wins over `SKILL.md`; module/configured skills
must provide inline `{ name, description, files }`. Disk and Git skill inputs fail
explicitly when constructing a compiled harness; materialize them before building.
Skills over `maxSkillBytes` (default 2 MB each), symlinks in discovered inputs, and
special skill files fail instead of silently omitting content.

The compiler does not execute authored modules. The final bundler and runtime
still process trusted agent code and its imports; this is not a code sandbox or
a guarantee of no build-time side effects. An agent importing Node-only APIs can
still fail to bundle or run. No dependency packages, credentials or environment
files are automatically copied as skill assets: all files explicitly placed in a
bare skill folder are included, so keep that folder limited to intended assets.
Node and compiled paths share discovery and asset walking; compilation deliberately
uses stricter symlink/special-file/directory validation than permissive Node discovery.
The compiler follows `loadHarness`, which does not start schedules or connectors;
those remain application-owned. It does not include LittleDB's deployment,
manifest, package-sharing or schedule-supervisor machinery.

## Verification

```sh
pnpm --filter @little-stack/harness build
pnpm --filter @little-stack/harness typecheck
pnpm --filter @little-stack/harness test
pnpm --filter workerd-folders typecheck
pnpm --filter workerd-folders test
```

The last command compiles and bundles the actual folders, launches the native
self-hosted workerd binary against a temporary SQLite directory, and tests Node
loader parity, discovered tools, offline skill reads, factory isolation, measured
overlapping tool intervals, per-chat serialization, chat/agent file and history
isolation, and process restart. Temporary processes and data are cleaned up.
Node and workerd intentionally advertise different shell capabilities; parity
compares authored instructions and the skill catalog without those host details.

In Node, repeated `loadHarness(folder, { dataDir })` calls for factory agents share a
fallback host per resolved data directory in the process. This also shares session
queues and concurrency limits; an explicitly supplied host bypasses this cache.
The demo's retry cache is keyed by agent, and failed construction only resets that
agent's key. If execution and file saving both fail, persistence cleanup preserves
both original causes in an `AggregateError`; a single failure keeps its original
error identity.
