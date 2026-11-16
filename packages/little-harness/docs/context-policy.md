# Experimental context policy

SDK default is off. Set `contextPolicy: false` to disable an inherited policy, or supply
`{ triggerTokens, keepLastTurns: 4, summaryModel: false, maxCompactionCostUsdPerSession: 0 }`.
These are the only four public policy fields. The SDK does not infer a model window.
Hosts supply documented window provenance and output reservation; unknown-window hosts
must supply an explicit threshold. The soft trigger uses the session's last measured
provider input against bytes estimated for **that same request**, after hooks/projection:
`ceil(currentRequestBytes * lastInputTokens / lastRequestBytes)`. It is not cumulative
session usage or a previous canonical/unprojected payload. Cached input still occupies context.

Missing, invalid or different-session/model measurements use conservative UTF-8 bytes as the
cold-start estimate. The hard-window guard always uses the larger of serialized bytes and the
calibrated estimate; calibration cannot weaken it. Summary input/cost reservations also retain
the byte bound. Without a known window, the explicit trigger also remains the conservative
hard ceiling; calibration cannot admit a larger payload. These are estimates, not provider usage. Changed text mix or remote media can
have different tokenization; the policy never fetches or resizes media.

Short image/file input below the trigger and conservative hard bound passes unchanged.
Above the trigger, eligible old text may be trimmed while every media part remains exact.
Media is never sent to the summarizer or serialized into a checkpoint (URL/binary cloning can
change it). A retained view that cannot fit the hard bound fails before the model call.
Provider-specific media tokenization remains the provider's context-limit responsibility.

`maxOutputTokens` is a normal Harness model option on `createHarness`, `turnOptions` or the
call (call wins). The same effective value reaches the provider and context host. Managed
hosts fall back to the documented model maximum only when no value is configured.
Execution snapshots reject this unversioned override until their content contract supports it.

Generate/stream compose application hints and inbox preparation first, context projection
second, invocation limits last. Ordinary Harness conversations retain recent complete turns,
current input, pending calls, approvals and system pins. Older text tool outputs and long
free-text leaves of JSON tool outputs can be projected. JSON keys, scalar metadata,
identifiers, errors, decisions and artifact references remain; arrays of small records may
remain irreducible. Canonical history is never rewritten.

Workflow budgets its actual rendered AI SDK messages before request hashing, replay lookup
and invocation. Its one user-led task is never summarized. It can project output leaves from
earlier completed tool rounds within that task, keeping the task input, call arguments,
latest completed round, pending calls and approvals exact. The projected provider-facing
request is hashed, so replay is stable even when Workflow's display text differs from its
wire representation. Direct `ai.generate` input/repair notes stay exact and may fail closed.
Irreducible over-budget input stops before a provider call.

Host runtime types are exported from the root; implementations including `compactContext`
and `contextSessionLogStore` are under `/internals`. A host's
`contextCompaction.forSession` supplies model metadata, a checkpoint store and optional
same-model summary adapter. Positive summary budgets require durable storage, a known
window/prices, a run ID and an adapter; unavailable admission fails closed.
Optional store `lastInputUsage` / `recordInputUsage` capabilities persist the sample's session,
model/provider, observation ID, request hash/bytes and measured input tokens. Only a completed
matching model step updates it; missing/estimated/aborted usage does not. Session-log hosts
append `harness.context.input_usage` records, and managed hosts use chat-scoped SQLite.
Older stores without these capabilities use cold-start estimates. Default SDK host sessions
keep bounded in-memory samples (128 active sessions per host); restart/eviction is cold start.
No SDK adapter makes real summary calls by default.

The trusted summary adapter receives `reservedUsd` after the durable store admits the attempt.
It returns text and measured input/output tokens, optionally trusted `costUsd` (for example,
a credits gateway's settled charge). Admission refused **before dispatch** may return
`{ skipped: "trim-only" }`: the SDK keeps the safe trimmed view and records zero summary cost.
Timeouts, transport failures and missing usage must not use that result; they retain the
uncertain reservation. A skipped summary cannot make irreducible input fit a hard window.
Callbacks carry purpose `context-compaction`, attempt ID, terminal usage or an unknown-cost
reservation. Costs are priced by the host snapshot, not a guarantee about a live invoice.

Immutable checkpoints support exact-source restart replay without summary resampling.
Optional store `list()` enables progressive reuse: canonical prefix, system/tools, policy,
projection version and model fingerprints must match, then the exact canonical suffix is
appended. Calibration is excluded from the checkpoint identity: exact committed model views
are restored before the new trigger estimate is considered, so a new sample cannot change
replay inputs. New checkpoints label `last-input-ratio-v1` versus cold `utf8-bytes-v1`, retain
before/after bytes and freeze their calibration basis. A subsequent summary consumes the reused prefix plus newly covered source.
Rewound/divergent history cannot import a missing or altered prefix. Fork sessions remain
isolated; no cross-session checkpoint or budget migration is implicit.
Paid summaries require `supportsTurnAdmission` and a nonempty run ID; store claim atomically
admits at most one summary attempt per run, including failed/unknown outcomes after restart.
The session-log adapter requires host session exclusivity: its mutex is process-local,
not distributed CAS. Managed hosts must atomically reject stale chat generations. Summary
text enters as untrusted user content and never grants permission.

## Validation and integration limits

The companion managed draft connects its durable developer-key session cap and existing
credits gateway reserve/settle. Its default summary cap remains $0. New project/account/monthly
admission, native provider adapters, background summaries and cross-session migration are not
part of this slice. A built-in local-host summary adapter using the session's own model and
a durable local store is also **later work**, not v1. The plain SDK default provides trim only;
paid summaries require an explicitly installed host adapter. Local scripted tests do not
authorize paid or production rollout.
Synthetic English/Cantonese fixtures test structure, not clinical or summary-language quality;
they contain no real student or faculty-answer data. Read the paired managed PR for its base
integration and packaged verification status before describing the combined build as ready.
