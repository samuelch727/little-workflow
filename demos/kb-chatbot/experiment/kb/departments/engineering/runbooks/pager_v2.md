# Paging and on-call, v2 rotation

Northwind Systems engineering. In force since **March 2025**; replaces the v1 rotation and
the `@oncall-eng` alias. (Fictional sample document.)

## Reaching on-call

- Slack channel: **`#eng-oncall-v2`**. This is the only watched channel; `#ops-alerts` is
  archived and `@oncall-eng` no longer resolves to a person.
- Paging goes through PagerDuty. The schedule to page for a customer-visible outage is
  **`eng-primary`**.

## Rotation

- Primary and secondary, one week each, handover Wednesday 10:00 local.
- The duty manager rota runs monthly and is separate from the engineer rota.
- Nobody is primary two weeks running. Swaps are self-serve in PagerDuty.

## Severities and paging

- **SEV-1** — customer-visible outage. Page the `eng-primary` schedule immediately, at any
  hour. Do not wait for business hours and do not post in Slack instead of paging.
- **SEV-2** — degraded service, no data loss. Page `eng-primary` during business hours;
  outside them, file and let the morning rotation pick it up.
- **SEV-3** — internal only. Ticket, no page.

## Escalation

1. `eng-primary` is paged.
2. No acknowledgement within **15 minutes** — the page escalates automatically to the
   **secondary** on-call engineer.
3. No acknowledgement within a further 15 minutes — it escalates to the **duty manager**.
4. The duty manager decides whether to wake the VP of Engineering.

## First ten minutes of a SEV-1

1. Acknowledge in PagerDuty. Acknowledging is not the same as fixing.
2. Open `#inc-<date>-<short-name>` and post the customer impact in one sentence.
3. Status every ten minutes until downgraded, even when the status is "still looking".
