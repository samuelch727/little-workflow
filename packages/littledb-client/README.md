# @little-workflow/littledb

littledb client for little-workflow and little-harness.

> **Not published yet.** This package talks to the littleDB service (a control plane
> and a trace engine), which is not public. It is held back from npm and used by the
> demos in this repository until the service is available.

## Entry points

- `.` — Tracing World (`littleDB()`): wraps a local WAL world with a tee to the littledb trace engine HTTP API.
- `./harness` — managed-config harness adapter: wires littledb into a little-harness session automatically.
- `./contract` — wire schemas: Zod schemas for the littledb control-plane HTTP API request/response shapes.

See the [docs](https://github.com/samuelch727/little-workflow) for usage.
