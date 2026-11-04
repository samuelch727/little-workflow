# Durable caller dispatch and staged delivery

The agent server's optional caller contract uses `dispatchId` (one logical turn, through its
parks and resumes), `expectedDispatchId` on Stop, and a session-global `messageId` on staging.
These are trusted application identities, outside model input and `extraBody`. A caller never
reuses either id for different work. The capability paths are `/sessions/:sessionId/dispatches/:dispatchId/messages`, `/resume`,
`/stop`, `/turn`, and `/staged/:messageId` (POST acceptance, GET status). Path identities are
authoritative; conflicting body identities return409 and unknown scoped routes return404.
Clients must hold on unsupported404; never fall back to a session-wide Stop or unkeyed staging.
Body-field aliases below remain available on this server version.

Identified APIs require `resume: "caller"` and concrete model handles for the fail-closed
invocation hook. They return400 in timer mode. Opt-in pins the session to identified mode,
including a first conditional Stop tombstone; legacy effect requests then return409. Legacy-only
API sessions retain their behavior and cannot convert to identified mode: use a new session.
Use an exclusive caller-owned session namespace and host: never share these session IDs with
direct generate/stream calls, connectors or scheduled jobs. This is a trusted host configuration
boundary; the API mode pin cannot fence those other ingress paths. Detectable existing host
sessions and parked continuations refuse conversion. Compatible reads and question-ID answers remain
available. The default GET turn reports the latest admitted identified dispatch.

A different identified dispatch is rejected409 while any earlier dispatch is running, parked or
interrupted. Explicitly cancel that exact prior target before admitting its successor. Terminal
or cancelled receipts permit a successor; old duplicate receipts never retake the current pointer.
A completed multi-step dispatch returns its persisted terminal receipt without invoking providers
or tools again. Custom session logs must supply readable `priorEvents`; unsupported, unreadable
or corrupt replay proof returns503 rather than being treated as an empty log.

- `POST messages`: optional `dispatchId`, bound to the request's prompt/messages and trigger.
  The server derives one initial `runId`, records admission before execution, attaches its
  controller under that admission lock, and uses a durable run log. A live duplicate does not
  run again. A restarted initial run replays the same log; pending provider/tool outcomes remain
  subject to their underlying replay and budget contracts, not an exactly-once provider claim.
- `POST resume`: the same `dispatchId`, plus the existing idempotent `resumeId`. Cancellation
  is checked before admission, after asynchronous claim/hooks and at effect boundaries. Each
  Harness turn id is durably associated with its dispatch before execution, so a continuation's
  `originTurnId` remains attributable after a restart or a lost parked callback. Caller resume IDs
  are immutably bound to their dispatch, queued run and continuation beyond the legacy receipt
  cache; damaged bindings fail closed. End/reconciliation updates compare the latest run identity,
  so stale proof cannot end a successor resume or mark its accepted input unread.
- `POST stop`: `{ expectedDispatchId }` first records an irrevocable tombstone, even when its
  matching start has not arrived. It cancels only matching controllers and continuations.
  Later start/resume requests and late parked callbacks cannot erase it. A stale Stop may
  record its old target's cancellation but cannot stop a newer dispatch. Legacy `{}` remains
  session-wide only in legacy sessions.
- `POST staged`: `{ dispatchId, messageId, text }`. Acceptance and immutable payload binding
  precede 202. Same-id/same-payload retries return the stored status; another payload or dispatch
  conflicts, including after terminal/unread. Distinct ids with identical text remain distinct.
- `GET staged/:messageId` returns the original dispatch and durable `accepted`, `claimed`,
  `read` or `unread` status. Step/run/placement is claimed before prompt assembly; a durable
  model-request occurrence binds the claim but does not prove provider I/O. A durable model
  response proves the request produced a response and advances it to read. This does not claim
  model understanding or exactly-once provider execution. Restart reconciliation repairs a
  response committed before the read marker. Claimed/unknown input is never guessed unread.
- The generic inbox accepts identified entries and a step context, preserving each message's
  original placement on replay. A parked conversation carries read arrivals; new arrivals
  remain available when the dispatch continues. Terminal input never attached to a request
  becomes unread. Events carry message identities; text is never used as a deduplication key.

The file ledger is a single-process reference store under the private host data directory.
Writes use a synced temporary file, rename and parent-directory sync. Only ENOENT is missing;
corruption, I/O errors and unknown write outcomes fail closed. Retried writes read the durable
record, and cancellation cannot transition back. Tombstones, identity bindings and identified
run logs are retained, not truncated by the latest-resume cache. Disk/data-dir loss loses this
contract; a shared data directory is not a multi-writer or hostile-local-user boundary.

The integration must test acknowledgement loss before/after acceptance, request/response marker
crashes, parked/restarted inboxes, identical text under distinct ids, old staging against a
successor, Stop during asynchronous parsing and preparation, a delayed start/resume after Stop,
and a stale Stop after a successor is queued/running. No accepted message may disappear into an
inferred read/unread state, and no cancelled dispatch may regain execution authority.
