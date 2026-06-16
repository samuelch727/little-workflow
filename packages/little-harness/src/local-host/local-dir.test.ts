import { describe, expect, it } from "vitest";
import { customDir, localDir, projectDir, resolveLocalDirSource } from "./local-dir.js";
import { resolveLocalHostPaths } from "./paths.js";

describe("localDir", () => {
  it("keeps harnessDir and sourceDir separate", () => {
    const dir = localDir({ harnessDir: "/persistent/user", sourceDir: "users/u1" });
    expect(dir.harnessDir).toBe("/persistent/user");
  });

  it("resolves plain relative sourceDir under dataDir", () => {
    const hostPaths = resolveLocalHostPaths({ dataDir: ".little-harness" }, "/repo/app");
    expect(resolveLocalDirSource("persistent/users/u1", hostPaths, undefined)).toBe(
      "/repo/app/.little-harness/persistent/users/u1",
    );
  });

  it("resolves projectDir inside projectRoot", () => {
    const hostPaths = resolveLocalHostPaths({ projectRoot: "/repo/app" }, "/repo/app");
    expect(resolveLocalDirSource(projectDir("./docs"), hostPaths, undefined)).toBe(
      "/repo/app/docs",
    );
  });

  it("rejects projectDir outside projectRoot", () => {
    const hostPaths = resolveLocalHostPaths({ projectRoot: "/repo/app" }, "/repo/app");
    expect(() => resolveLocalDirSource(projectDir("../docs"), hostPaths, undefined)).toThrow(
      /outside projectRoot/,
    );
  });

  it("supports object-store shaped custom dirs", () => {
    const dir = customDir({
      harnessDir: "/persistent/user",
      list: async () => [{ path: "memory.md", kind: "file" }],
      read: async () => "hi",
      write: async () => undefined,
      delete: async () => undefined,
    });
    expect(dir.harnessDir).toBe("/persistent/user");
  });
});
