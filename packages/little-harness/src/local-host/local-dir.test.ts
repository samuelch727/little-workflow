import { describe, expect, it } from "vitest";
import { HarnessPathError } from "../errors.js";
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

  it("rejects a sourceDir function result that leaves dataDir", () => {
    const hostPaths = resolveLocalHostPaths({ dataDir: ".little-harness" }, "/repo/app");
    const perUser = ({ extraBody }: { extraBody?: { userId: string } | undefined }) =>
      `memory/users/${extraBody?.userId}`;

    expect(resolveLocalDirSource(perUser, hostPaths, { userId: "u1" })).toBe(
      "/repo/app/.little-harness/memory/users/u1",
    );
    for (const userId of ["../company", "..", "u1/../../company", "../../../etc"]) {
      expect(() => resolveLocalDirSource(perUser, hostPaths, { userId })).toThrow(HarnessPathError);
    }
    expect(() => resolveLocalDirSource(() => "/etc", hostPaths, undefined)).toThrow(HarnessPathError);
    expect(() => resolveLocalDirSource(() => ".", hostPaths, undefined)).toThrow(/inside dataDir/);
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
