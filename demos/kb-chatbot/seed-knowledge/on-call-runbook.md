# On-call runbook

Northwind Systems platform team (fictional sample document).

## Rotation

- The primary on-call rotation is **one week**, handing over on Tuesday at 10:00 local time.
- There is always a secondary on-call whose only job is to answer if the primary does not
  acknowledge within 10 minutes.

## Severities

| Severity | Meaning | Response target |
|---|---|---|
| SEV1 | Customer-visible outage of a paid surface | Acknowledge in 5 minutes |
| SEV2 | Degraded performance, no data loss | Acknowledge in 15 minutes |
| SEV3 | Internal-only or cosmetic | Next business day |

## First ten minutes of an incident

1. Acknowledge the page so the secondary is not woken up.
2. Open an incident channel named `#inc-<date>-<short-slug>`.
3. Post the current blast radius, even if the answer is "unknown".
4. Decide whether to roll back before you decide why it broke.
5. If it is a SEV1, page the incident commander on the `platform-ic` schedule.

## Escalation

If you have not made progress in 30 minutes on a SEV1, escalate. Escalating is never
penalised; staying silent is.
