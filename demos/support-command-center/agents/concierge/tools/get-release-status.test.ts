import { describe, expect, test } from "vitest";
import { getReleaseStatus, listReleaseVersions } from "../data/releases";

describe("getReleaseStatus", () => {
  test("returns the requested release", () => {
    const release = getReleaseStatus("v4.2.0");
    expect(release.version).toBe("v4.2.0");
    expect(release.stage).toBe("canary");
    expect(release.metrics.length).toBeGreaterThan(0);
  });

  test("defaults to the latest release when no version is given", () => {
    const release = getReleaseStatus();
    expect(release.version).toMatch(/^v/u);
  });

  test("falls back to the latest release for an unknown version", () => {
    const release = getReleaseStatus("v9.9.9");
    expect(listReleaseVersions()).toContain(release.version);
  });
});
