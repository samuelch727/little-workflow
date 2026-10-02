# Database failover runbook

- Primary and two replicas per region. Failover is automatic on a health-check failure.
- Manual failover: `aurora-ctl failover --region <region>`, then confirm the new primary in
  the console before announcing.
- Expect 30–60 seconds of write unavailability. Reads continue from replicas.
- After any failover, check replication lag before declaring the incident over.
