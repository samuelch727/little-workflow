import type { Spec } from "@json-render/react";

/**
 * A json-render flat spec: `{ root, elements }`. The deterministic builder below
 * turns a release snapshot into one of these so the web connector can stream it
 * to the browser as a typed tool-output part.
 */
export type DashboardSpec = Spec;

export type ReleaseTrend = "up" | "down" | "flat";

export type ReleaseMetric = {
  label: string;
  value: string;
  trend: ReleaseTrend;
};

export type ReleaseIncident = {
  id: string;
  title: string;
  severity: string;
  status: string;
};

export type ReleaseSnapshot = {
  version: string;
  stage: string;
  health: "healthy" | "degraded" | "down";
  metrics: ReleaseMetric[];
  incidents: ReleaseIncident[];
};

type BadgeTone = "neutral" | "positive" | "warning" | "critical";

/** The dashboard sections the model may choose to include. */
export const DASHBOARD_SECTIONS = ["health", "metrics", "incidents"] as const;
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

function healthTone(health: ReleaseSnapshot["health"]): BadgeTone {
  if (health === "healthy") return "positive";
  if (health === "degraded") return "warning";
  return "critical";
}

/**
 * Build a catalog-constrained dashboard spec from a release snapshot, including
 * only the requested `sections` (the model chooses which to show — that choice is
 * the generative part). Every element `type`/`props` matches a component declared
 * in `catalog.ts`. Defaults to all sections.
 */
export function buildReleaseDashboardSpec(
  release: ReleaseSnapshot,
  sections: readonly DashboardSection[] = DASHBOARD_SECTIONS,
): DashboardSpec {
  const elements: DashboardSpec["elements"] = {};
  const rootChildren: string[] = [];
  const include = new Set(sections.length > 0 ? sections : DASHBOARD_SECTIONS);

  if (include.has("health")) {
    elements["health"] = {
      type: "Badge",
      props: { label: `${release.stage} · ${release.health}`, tone: healthTone(release.health) },
    };
    rootChildren.push("health");
  }

  if (include.has("metrics")) {
    const metricChildren: string[] = [];
    release.metrics.forEach((metric, index) => {
      const key = `stat-${index}`;
      elements[key] = {
        type: "Stat",
        props: { label: metric.label, value: metric.value, trend: metric.trend },
      };
      metricChildren.push(key);
    });
    elements["metrics-heading"] = {
      type: "Section",
      props: { heading: "Key metrics" },
      children: metricChildren,
    };
    rootChildren.push("metrics-heading");
  }

  if (include.has("incidents")) {
    elements["incidents-table"] = {
      type: "Table",
      props: {
        columns: ["Incident", "Title", "Severity", "Status"],
        rows: release.incidents.map((incident) => [
          incident.id,
          incident.title,
          incident.severity,
          incident.status,
        ]),
      },
    };
    elements["incidents-heading"] = {
      type: "Section",
      props: { heading: "Open incidents" },
      children: ["incidents-table"],
    };
    rootChildren.push("incidents-heading");
  }

  elements["root"] = {
    type: "Dashboard",
    props: { title: `Release ${release.version}`, subtitle: null },
    children: rootChildren,
  };

  return { root: "root", elements };
}
