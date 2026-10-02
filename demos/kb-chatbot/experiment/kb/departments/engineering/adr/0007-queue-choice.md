# ADR 0007 — queue choice

Status: accepted.

We use a managed queue rather than running our own broker. The operational cost of a
self-hosted broker is not justified by the throughput we need, and the managed option gives
us per-message dead-lettering without extra work.

Revisit if sustained throughput passes 20k messages/second.
