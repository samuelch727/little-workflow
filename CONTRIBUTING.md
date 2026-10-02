# Contributing to Little Workflow

Thanks for your interest in contributing! Little Workflow is in an early alpha
phase, so APIs and internals move quickly. Issues, discussions, and pull requests
are all welcome.

## Getting started

Requires Node.js `>=22` and `pnpm@10`.

```sh
git clone https://github.com/samuelch727/little-workflow.git
cd little-workflow
pnpm install
pnpm verify
```

`pnpm verify` runs build, lint, typecheck, and tests across the monorepo. Please
make sure it passes before opening a pull request.

## Project layout

- `packages/little-workflow` — the workflow SDK and `little` CLI.
- `packages/little-harness` — the agent runtime primitives.
- `apps/` — runnable demos and documentation sites.

## Development workflow

1. Create a branch from `main`.
2. Make your change with tests. The codebase favors test-driven development.
3. Run `pnpm verify` and confirm it passes.
4. Keep the authored skills under `skills/` aligned with package behavior when you
   change agent-facing behavior (see `AGENTS.md`).
5. Open a pull request describing the change and the motivation.

## Commit and PR conventions

- Use clear, present-tense commit messages. Conventional Commit prefixes
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) are used throughout the history and
  appreciated but not strictly required.
- Keep PRs focused. Small, reviewable changes merge faster.

## Reporting bugs and requesting features

Open a GitHub issue with enough detail to reproduce (versions, a minimal repro, and
expected vs. actual behavior). For security issues, do **not** open a public issue —
see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
