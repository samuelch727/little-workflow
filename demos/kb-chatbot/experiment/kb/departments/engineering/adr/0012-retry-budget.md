# ADR 0012 — retry budget

Status: accepted.

Every outbound call carries a retry budget rather than a fixed retry count. A caller that
exhausts its budget fails fast instead of amplifying an incident.

Defaults: 10% of request volume, 30-second window, jittered backoff.
