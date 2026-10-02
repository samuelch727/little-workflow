---
name: designing-workflows
description: 'Judgment for designing and orchestrating little-workflow workflows — how to decompose a task into steps, when to fan out into parallel sub-runs, how to coordinate distinct work across those sub-runs so they do not overlap, right-sizing model calls, and conforming to the output contract. Read when planning a workflow''s steps (planner) or deciding how to run sub-workflows (orchestrator).'
---

# Designing and orchestrating workflows

These are heuristics, not a fixed recipe. Different tasks are best expressed in
different shapes — choose the simplest design that satisfies the output contract.
The goal is a workflow that reliably produces output matching its schema, at the
requested scale, without wasted structure.

## Start from the output contract

The workflow exists to produce output that matches its declared schema. Work
backward from that shape. If the output is a single object, one model step is
usually enough. If it is a large array of distinct records, think about how those
records get produced and combined.

## Right-size each model call

A single `ai.generate` call has practical limits. Asking one call to emit a very
large or very long result — say a hundred detailed records in one shot — tends to
truncate, drift, or repeat. If the requested volume is large, produce it in
several smaller pieces rather than one call.

## Fan out for volume or independence

When the work is large, or naturally parallel (N independent items), running the
workflow several times — a fan-out of sub-runs — is usually better than one giant
call. Pick a batch size that keeps each call comfortably within a model's reliable
range, and let the sub-runs run concurrently.

## Coordinate distinct work across sub-runs

This is the step most easily missed. **Independent sub-runs given the same
instruction will produce overlapping results** — the same names, the same ids,
the same first ten items — because nothing tells them how they differ. If you fan
out to produce N *distinct* things, give each sub-run its own slice of the work so
the pieces don't collide. Some ways to partition (use whichever fits the task):

- an explicit range or offset — e.g. "items 1–20", "21–40", … via a start index
  and count;
- a distinct id range or id prefix per sub-run, so generated ids never collide;
- a distinct seed, theme, segment, or category per sub-run;
- any partition of the input space that makes the sub-runs cover different ground.

There is no single correct scheme — choose the partition natural to the data. The
point is only that **each sub-run must know what makes it different from the
others**, or the distinct count will fall far short of the total.

## Aggregate so the whole set is consistent

After a fan-out, the sub-run outputs combine into the final result. Make sure keys
or ids are unique across the *entire* set, ordering is sensible, and the count
matches what was asked. If two sub-runs could collide on a key, the partition
above should have prevented it.

## Honor enums and constraints

When a field is an enum or has bounds, the produced values must be exactly the
allowed ones. A value outside the allowed set fails validation for that whole
record. Keep generated values inside the schema's constraints.

## Keep it as simple as the task allows

Most tasks need far less structure than they first appear to. Reach for extra
steps, tools, decisions, or fan-out only when the task genuinely needs them. A
single well-formed step that meets the contract beats an elaborate plan that
doesn't.
