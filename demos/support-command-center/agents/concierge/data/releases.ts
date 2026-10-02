import type { ReleaseSnapshot } from "../ui/spec";

/**
 * Synthetic release/deploy snapshots for the concierge demo. Ordered newest →
 * oldest; index 0 is the "latest" release returned when no version is requested.
 */
const RELEASES: ReleaseSnapshot[] = [
  {
    version: "v4.3.0-rc1",
    stage: "release-candidate",
    health: "degraded",
    metrics: [
      { label: "Error rate", value: "1.8%", trend: "up" },
      { label: "p95 latency", value: "480ms", trend: "up" },
      { label: "Rollout", value: "10%", trend: "flat" },
    ],
    incidents: [
      { id: "INC-204", title: "Checkout latency regression", severity: "sev2", status: "investigating" },
    ],
  },
  {
    version: "v4.2.0",
    stage: "canary",
    health: "healthy",
    metrics: [
      { label: "Error rate", value: "0.4%", trend: "down" },
      { label: "p95 latency", value: "210ms", trend: "flat" },
      { label: "Rollout", value: "35%", trend: "up" },
    ],
    incidents: [
      { id: "INC-198", title: "Elevated 5xx on webhooks", severity: "sev3", status: "monitoring" },
    ],
  },
  {
    version: "v4.1.3",
    stage: "stable",
    health: "healthy",
    metrics: [
      { label: "Error rate", value: "0.1%", trend: "flat" },
      { label: "p95 latency", value: "185ms", trend: "down" },
      { label: "Rollout", value: "100%", trend: "flat" },
    ],
    incidents: [],
  },
];

export function listReleaseVersions(): string[] {
  return RELEASES.map((release) => release.version);
}

/**
 * Look up a release by version. Unknown or omitted versions return the latest
 * release so the demo always has something to show.
 */
export function getReleaseStatus(version?: string): ReleaseSnapshot {
  if (version !== undefined) {
    const match = RELEASES.find((release) => release.version === version);
    if (match !== undefined) return match;
  }
  return RELEASES[0]!;
}
