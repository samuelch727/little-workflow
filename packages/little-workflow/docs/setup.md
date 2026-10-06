# Unified Little setup (alpha)

Use the owned `little-workflow` CLI on Node.js 22+. `little setup` creates one repository with Little Harness and an optional, runnable Little Workflow example. It also adds Little to existing TypeScript Next.js 15/16 App Router projects.

```sh
# Guided wizard: template, Workflow, provider/model, package manager, preview, install, verify
npx little-workflow@alpha setup

# New Next.js app; definitions live beside src/app in src/agents
npx little-workflow@alpha setup my-app --template next --workflow --yes --install --allow-native-build --verify
cd my-app
npm run dev
# Open http://localhost:3000/little

# Standalone agent; the same definitions run without a web UI
npx little-workflow@alpha setup my-agents --template node --yes --install --verify
cd my-agents
npm run little:agent

# Existing Next project: inspect the additive plan before applying
npx little-workflow@alpha setup --here --workflow --plan
npx little-workflow@alpha setup --here --workflow --yes --install --allow-native-build --verify
# Existing dev/build scripts keep their original values.
```

`--provider openai --model gpt-5.2` selects the live provider/model; any provider id supported by `little-harness/scaffold` is accepted. The generated `.env.little.example` has names/placeholders only. Setup never reads or stores credentials. Projects use a deterministic AI SDK mock by default. `LITTLE_DEMO=0` is the developer's explicit opt-in to real model calls and charges. `little:smoke` forces keyless mode even if live mode was enabled in the environment.

Harness is always included. `--workflow` adds a fixed-plan, durable `starter.echo` workflow, registers its folder, adapts it into the agent as `starter_echo`, and tests execution both through Harness and directly. It needs Local World's `better-sqlite3` native binding. Installs disable lifecycle scripts; `--allow-native-build` permits only `npm rebuild better-sqlite3 --ignore-scripts=false`. That narrowly targeted rebuild also works with pnpm's node_modules layout. Setup does not disable pnpm's build policy or enable arbitrary scripts.

Supported automatic installs: npm, pnpm 10, Yarn Classic 1 with node_modules. Yarn Berry/PnP and workspace-root installs require manual integration (`--no-install`), because the filesystem loader and package-manager boundaries need deliberate configuration. Lockfiles and `packageManager` must agree. No existing dependency is upgraded: incompatible AI SDK/provider/Little major ranges are explicit conflicts. Resolve them yourself, then rerun. Existing Next, React, TypeScript, config, route, env and custom script values are preserved.

For `src/app`, definitions go in `src/agents`; for `app`, in `agents`. The shared `support/agent.ts` is server-neutral so `little-harness test support` can load it via the same `little-harness.json`. Only `agents/server.ts` imports `server-only`. The generated API declares `runtime = "nodejs"`. The chat page uses an app-local `useChatUI` wrapper over the public AI SDK `useChat` hook. Imports are relative, so custom aliases do not need changes. An additional `tsconfig.little.json` checks the generated integration without replacing the user's tsconfig.

By default the API and page are `/api/little/chat` and `/little`. If a path collides, choose e.g. `--route api/my-agent --page agent-demo` before applying. Existing configs are never rewritten. The server-only wrapper uses native Node module loading from the project root and the public agent-folder loader, keeping Little's filesystem/native runtime internals outside the Next bundle without changing your config. Keep the shared agent source files present on disk. This alpha does not prepare a deployment bundle. `--verify` runs the generated typecheck and keyless streaming/durable smoke; also run your existing application build and tests after reviewing any integration.

## Safety and recovery

`--plan` performs no writes. Every invocation prints the file plan and the before/after package manifest. Noninteractive mutation requires `--yes`. There is no `--force`. Identical reruns are no-ops; edited generated files are conflicts. Additions to unrelated package scripts/dependencies remain intact. The CLI rejects invalid JSON, ambiguous router/lockfile choices, path traversal and symlink targets. Dirty Git trees produce a warning and are never reset or cleaned.

Writes use per-file atomic replacement and `.little/setup-transaction.json`, with preimage/content checks before each change. Failures during generation/install/verification restore only unchanged CLI-written files; concurrent user edits are kept and reported. Recovery after process termination is explicit:

```sh
# Inspect the journal first; run after the installer process has stopped
npx little-workflow@alpha setup --here --rollback
```

Dependency artifacts (`node_modules`, package-manager caches and changed lockfiles) are preserved after failure/recovery. Review and reinstall as needed; rollback never removes arbitrary user files. The journal contains generated/package text, not credentials. Do not edit concurrently with installation. Low-level public planner/transaction APIs are exported from `little-workflow/scaffold`, alongside the legacy Workflow scaffold helpers; private dist imports are unnecessary.

## Local development and scope

`.little-harness/` and `.little-workflow/` are single-process local filesystem persistence. They are not hosted multi-tenant state. The sample API has no login, strips/ignores browser identity, and assigns fresh server-generated sessions. Production live mode is refused until you implement server-verified authentication, authorization, rate limiting and a suitable persistent execution host. Explicit `LITTLE_DEMO=1` permits a keyless production smoke.

Compute is unavailable: its public package/backend has not been qualified. LittleDB is unpublished. `little setup --compute` explains this and makes no changes. No paid provisioning, deployment or third-party channel setup occurs.

A headless CLI alone does not require a monorepo. A later workspace template could put shared definitions in `packages/agents`, web in `apps/web`, and independent channel/service entrypoints in other apps. Repository boundaries, runtimes, services and channels are separate choices. This alpha does not create that template or invent WhatsApp/Telegram/Slack adapters.
