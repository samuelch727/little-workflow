# On-call runbook

Northwind Systems engineering (fictional sample document).

Describes the on-call rotation as it was set up when the team moved off the old paging
provider. The escalation tree below reflects that rotation.

## Reaching the on-call engineer

- Post in `#ops-alerts` and mention `@oncall-eng`.
- The alias is watched during business hours. Outside business hours, use the phone tree in
  the team wiki.

## Severities

- **SEV-1** — customer-visible outage. Page immediately.
- **SEV-2** — degraded service, no data loss. Page during business hours.
- **SEV-3** — internal only. File a ticket.

## Escalation tree

1. On-call engineer (`@oncall-eng`).
2. If no response, the team lead.
3. If still no response, the VP of Engineering.

## First ten minutes

1. Acknowledge the alert so the rest of the team knows it is being looked at.
2. Open an incident channel named `#inc-<date>-<short-name>`.
3. Post a one-line status every ten minutes until the incident is downgraded.
