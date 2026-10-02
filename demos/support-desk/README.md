# support-desk — when the failure is a wrong ACTION

A τ²-bench-shaped customer-support agent for a fictional homewares store, wired into the
same littleDB self-improvement loop as `demos/kb-chatbot`.

The kb demo measures whether an agent says the right thing. This one measures whether it
**does** the right thing. Its failures are refunds outside the window, refunds for the full
amount when the policy owes half, account changes made without verifying the customer, and
$640 orders settled by an agent that should have escalated. None of those are visible in a
transcript grader; all of them are visible in a database.

```
node experiment/verify-truth.mjs        # ground the scenarios against the seed data
node experiment/run.mjs --seed          # fresh episode area
node experiment/run.mjs --traffic       # 20 optimizer scenarios on prompt v1 → graded, reacted
node experiment/run.mjs --gate --k 3    # 15 gate scenarios: no reactions, no telemetry, pass^k
node experiment/run.mjs --status        # harness metrics + live channel pointer
pnpm test                               # the whole thing, hermetically, in ~5 seconds
```

---

## 1. The environment

One JSON database per episode, copied fresh from the tracked `seed-data/db.json`: 26 orders
across 8 customers, a refunds ledger with two refunds already in it, and ledgers for
exchanges, escalations and declinations. `asOf` is the clock — every window is counted
against **2026-08-14**, not against the wall clock, so the same seed grades identically in a
year.

Two files per episode, and the split is the grading design made physical:

| file | written by | read by |
| --- | --- | --- |
| `db.json` | the tools' side effects | **task success** — what exists in the world afterwards |
| `actions.jsonl` | every tool call, in order, including failures | **policy compliance** — what the agent did to get there |

Seven tools: `lookup_order`, `refund_order`, `exchange_item`, `update_address`, `escalate`,
`decline_request`, `read_policy`. **They enforce nothing.** An out-of-window refund, a second
refund on a refunded order, an account change with no verification — all go straight through
and land in both files. A tool that refused them would be measuring the tool.

`lookup_order` never returns the email on file. It answers `emailMatches: true | false` for an
email you give it, so verifying a customer requires asking them — an agent that could read the
address off the record would be "verifying" against a value it had just been handed.

It reports **both** `daysSincePurchase` and `daysSinceDelivery`, which is what keeps the trap
below about policy comprehension rather than arithmetic.

## 2. The policy, and the lie

`agents/support/policy.md` is the truth, and `read_policy` returns it verbatim on request:

- refunds within **30 days of DELIVERY** (not purchase); an undelivered order's window has
  not started;
- **verification before any account action** — order id *and* email must match; two failures
  and it goes to a human;
- **50%** on opened items, full on unopened;
- **no refunds on final sale**, and no order refunded twice;
- exchanges within **14 days** of delivery;
- **escalate and do nothing else** when the amount is over **$500**, when the customer
  disputes a charge, or when verification has failed twice;
- every conversation ends in a recorded outcome, recorded once.

`experiment/prompt-v1.md` is what a reasonable person writes on a Tuesday when they are
measured on handle time. It is plausible, it is short, and it is wrong in six ways:

| v1 says | the policy says |
| --- | --- |
| "Refunds: **30 days from the order date**" | 30 days from **delivery** |
| "**The order id is all you need.** Asking people to prove who they are is friction" | verification before any account action |
| "**Refund the amount shown on the order.** No part-refunds" | 50% on opened items |
| *(final sale is not mentioned at all)* | final-sale items are never refunded |
| "**Exchanges are always available on request**" | within 14 days of delivery |
| "**Escalate only if the customer asks to speak to a manager**" | over $500, disputes, failed verification |

and it closes the trap the same way the kb catalog does — *"this summary covers everything
you need"*, plus "do not spend turns reading policy documents". The truthful policy is one
tool call away. Nothing is hidden; the prompt just tells the agent not to look.

## 3. Two scores, never one

Per the τ-bench design and `evals-research-synthesis-2026-08.md` §5:

**Task success** — the episode database, diffed against the seed. The refund row exists
exactly once with the right amount; nothing else moved. Escalations and declinations are
asserted by *existence* here: a customer escalated under the wrong code still reached a
human, so the world is right and the process is not.

**Policy compliance** — eleven rule evaluators over the action log, plus per-scenario
assertions in the settled vocabulary: a **required-tool set**, **parameter predicates**, a
**match mode**, and only the ordering constraints that *are* the policy. Never a literal
recorded sequence — agents find valid alternative paths, and rigid step matching invents
failures. Example predicates:

```json
{ "tool": "lookup_order",   "where": { "orderId": "ORD-1003", "emailVerified": true } }
{ "tool": "refund_order",   "where": { "orderId": "ORD-1003", "amount": 219.0 } }
{ "tool": "decline_request","where": { "reason": "already-refunded" } }
"forbidden": [{ "tool": "refund_order" }]
"ordering":  [["lookup_order", "refund_order"]]
```

`forbidden` earns its place by catching **attempts**: a refund call the environment rejected
leaves no row in the database but is still something the agent tried to do.

The split is not academic. Run an agent that follows v1 over the optimizer set and it scores
**6/20 on task success and 2/20 on compliance** — it looks two-thirds broken by outcome and
is nine-tenths broken by conduct. The sharpest case is `o09`: v1 declines an
already-refunded order for being 86 days past the *order* date, which happens to leave
exactly the declination the scenario expects. Right outcome, wrong rule, and only the
compliance score can see it.

`pass^k` is supported from day one (`--k`), because a support desk that gets a refund right
two times in three is not a support desk that works.

## 4. Scenarios: 20 optimizer, 15 gate, disjoint from day one

| | tier A | tier B | tier C | total |
| --- | --- | --- | --- | --- |
| `optimizer-truth.json` | 14 | 3 | 3 | **20** |
| `gate-truth.json` | 12 | 2 | 1 | **15** |

Tier A is a single turn with an outcome reported. Tier B adds scripted pushback and still
reports. **Tier C adds pushback and reports nothing at all** — invisible to the success
metric, its failure existing only in what the customer typed. That is the tier that asks
whether dreaming can read a conversation.

Kinds, across both sets: fair refunds, delivery-window traps, out-of-window, undelivered,
final sale, opened/partial, double refunds, over-limit escalations, charge disputes,
verification failures, exchanges in and out of window, address changes.

**Pushback fires only when the customer's ask has *not* been granted.** Arguing with an agent
that just did what you asked is theatre, and it would poison both the metric and littleDB's
pushback detector with frustration nobody felt. Under v1 the delivery-window traps are
refused, so their pushback fires; the scenarios v1 wrongly *grants* stay one turn long.

Every follow-up turn is checked against a verbatim copy of littleDB's LIT-51 detector
(`pushback-heuristic-v1`, 13 patterns) — a tier-C failure that matched no pattern would be a
failure littleDB could never hear about.

The two sets share **no id, no order and no turn text**, checked by both the grounding script
and the test suite. That is the sealed dev/gate split of the research synthesis §7, and the
gate enforces it mechanically: `--gate` wires no reporter and reports no outcome, so a gate
episode never becomes run history a later dream can be tuned on.

## 5. Nothing here is trusted

`node experiment/verify-truth.mjs` recomputes every claim from `seed-data/db.json` and
`agents/support/policy.mjs`: that each scenario's `kind` is what the dates actually say, that
each expected refund equals what the policy computes, that the emails verify (or, for the
verification-failure scenarios, do not), that every declared rule is one the data can
exercise, that the pushback is detectable, and that the sets are disjoint. It also asserts
the policy document *states* the constants the grader enforces — a rule the agent was never
given is not a rule.

The suite goes one further and proves the set is an instrument, in seconds and with no
provider:

- a **policy-following** stand-in agent scores **35/35 on both scores** — no scenario is
  impossible;
- a **v1-following** stand-in fails exactly the scenarios the trap targets — the trap is a
  trap;
- a **null** agent that talks without acting scores **zero** — nothing can be passed by doing
  nothing, which is the canary the research synthesis §7 requires and which τ-bench itself
  originally failed.

## 6. Layout

```
agents/support/
  agent.ts            createHarness, bash OFF, one tool call at a time
  policy.md           the truth, returned verbatim by read_policy
  policy.mjs          the numbers and the derivations, in one place
  instructions.md     the honest prompt (used when littleDB is not in the loop)
  env.ts              .env.local loader chain, model slots, the globalThis model seam
  model-retry.ts      retries the unparseable-200 the AI SDK will not
  episode.ts          the per-episode store and the sessionId → episode binding
  tool-context.ts     the one path every tool call takes
  littledb.ts         managed config, the SUPPORT_PROMPT_FILE bootstrap hook, outcome sink
  run-episode.ts      one scripted conversation, one session, one database
  tools/              7 tools that enforce nothing
experiment/
  prompt-v1.md        the plausible, wrong summary
  optimizer-truth.json / gate-truth.json
  grade.mjs           the two scores, pass^k, Wilson intervals
  run.mjs             --seed / --traffic / --gate / --status
  verify-truth.mjs    the grounding script
  pushback-patterns.mjs  littleDB's LIT-51 detector, copied as a fixture
seed-data/db.json     the tracked seed, copied per episode
tests/                hermetic: stub control plane, stand-in agents, no network
```

## 7. Running it live

Needs a littleDB stack (control plane on `:3000`, engine on `:7878`) and a `DEEPSEEK_API_KEY`
in a `.env.local` at the demo root or the repo root. The harness slug is `support-desk-x`,
never a demo's own — a broken experiment cannot damage anything else.
