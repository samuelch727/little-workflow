import { validateSpec } from "@json-render/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DashboardRenderer } from "./registry";
import { buildReleaseDashboardSpec, type ReleaseSnapshot } from "./spec";

const release: ReleaseSnapshot = {
  version: "v4.2.0",
  stage: "canary",
  health: "healthy",
  metrics: [
    { label: "Error rate", value: "0.4%", trend: "down" },
    { label: "p95 latency", value: "210ms", trend: "flat" },
  ],
  incidents: [{ id: "INC-12", title: "Elevated 5xx on checkout", severity: "sev2", status: "monitoring" }],
};

describe("release dashboard json-render spec", () => {
  test("builds a flat spec that passes json-render validation", () => {
    const result = validateSpec(buildReleaseDashboardSpec(release));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("renders the release version, metrics, and the incident", () => {
    const html = renderToStaticMarkup(
      <DashboardRenderer spec={buildReleaseDashboardSpec(release)} />,
    );
    expect(html).toContain("Release v4.2.0");
    expect(html).toContain("Error rate");
    expect(html).toContain("p95 latency");
    expect(html).toContain("Elevated 5xx on checkout");
    expect(html).toContain("canary · healthy");
  });
});
