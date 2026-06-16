# Changelog

All notable changes to this project are documented here.

Little Workflow is in its **alpha phase**: breaking changes to the LWIR wire
format, public APIs, and persistence formats are expected between alpha releases.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project will adopt [Semantic Versioning](https://semver.org/) guarantees once it
reaches beta. Versions apply to both published packages, `little-workflow` and
`little-harness`, which are released together.

## [0.1.0-alpha.2] - 2026-06-16

First release published as open source.

### Changed
- **Relicensed to the [Apache License 2.0](./LICENSE)** (OSI-approved). The
  earlier `0.1.0-alpha.0`/`0.1.0-alpha.1` packages on npm carried a
  source-available license; from this release the project is open source.

### Added
- Open-source project files: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  and `CODE_OF_CONDUCT.md`.
- A CI workflow running build, lint, typecheck, and tests on pull requests.

## [0.1.0-alpha.1] - 2026-06-15

### Added
- Initial public alpha of `little-workflow` (workflow authoring, planner
  compilation, LWIR validation, durable Local World execution/replay, and the
  `little` CLI) and `little-harness` (local-first agent runtime primitives and
  the workflow harness adapter).
