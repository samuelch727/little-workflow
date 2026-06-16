import { describe, expect, it } from "vitest";
import { resolveLocalHostPaths, resolveProjectDirSource } from "./paths.js";

describe("local host paths", () => {
  it("defaults dataDir to .little-harness under cwd", () => {
    const paths = resolveLocalHostPaths({}, "/repo/app");
    expect(paths.dataDir).toBe("/repo/app/.little-harness");
    expect(paths.sessionsDir).toBe("/repo/app/.little-harness/sessions");
  });

  it("resolves relative dataDir under cwd", () => {
    const paths = resolveLocalHostPaths({ dataDir: ".agent-data" }, "/repo/app");
    expect(paths.dataDir).toBe("/repo/app/.agent-data");
  });

  it("accepts projectDir references inside projectRoot", () => {
    expect(resolveProjectDirSource("./docs", "/repo/app")).toBe("/repo/app/docs");
  });

  it("rejects projectDir references outside projectRoot", () => {
    expect(() => resolveProjectDirSource("../docs", "/repo/app")).toThrow(/outside projectRoot/);
  });
});
