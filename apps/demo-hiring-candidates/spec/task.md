# Fake hiring dataset — marketing post + candidate pipeline

Produce a small, realistic **synthetic hiring dataset** for a fictional (but
believable) tech company, end-to-end through Little Workflow, so the trace flows
into **littleDB**.

## Phase 1 — the role + marketing job post (reasoning model)

Invent ONE specific, plausible open role at a fictional company and write a
polished, enthusiastic **marketing-style job post** for it (the kind a company
would publish to attract applicants). Capture, as structured fields:

- `role_title` — e.g. "Senior Backend Engineer, Payments".
- `company` — a fictional but believable company name.
- `location` — city + remote policy.
- `seniority_focus` — the seniority this role targets.
- `key_skills` — 5–8 skills the role screens for.
- `role_brief` — 2–3 sentences a recruiter could paste into a sourcing tool.
- `hiring_post_markdown` — the full marketing post (headline, about, what
  you'll do, what we look for, perks), in Markdown.

## Phase 2 — the candidate pool (fast model, fanned out)

Using the role from Phase 1, generate **N realistic, diverse fake candidates**
who plausibly applied for it. Fan out across batches so each batch is one
worker sub-run. Each candidate is a JSON object with exactly these fields:

`candidate_id, full_name, email, location, headline, years_experience,
current_company, top_skills, education, summary, desired_salary_usd, source,
seniority, status, match_score`.

- Use only fake names/companies/emails — no real people or contact data.
- Vary seniority, source, status, location, salary, and match quality so the
  pool looks like a real applicant funnel (a few strong matches, many average,
  some weak). Include tricky cases: over-qualified, career-changer, junior with
  great projects.
- `match_score` is 0–100; `years_experience` and `desired_salary_usd` are
  numbers; `top_skills` is a string array; the rest are strings drawn from the
  allowed vocabularies in `candidate-schema.mjs`.

## Why

This is a load/realism test for **littleDB**: one Phase-1 run plus a Phase-2
orchestration tree (orchestrator + ~N/batchSize worker sub-runs) gives the trace
engine + viewer real LLM reasoning, output, fan-out, and searchable content to
exercise tree, flow/timeline, and in-trace search.
