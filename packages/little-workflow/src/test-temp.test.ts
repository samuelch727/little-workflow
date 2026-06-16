import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(async () => undefined),
}));

describe("cleanupTempDirs", () => {
  beforeEach(() => {
    vi.mocked(rm).mockClear();
  });

  it("removes all tracked temp dirs with retry-safe options", async () => {
    const dirs = ["/tmp/lwf-a", "/tmp/lwf-b"];
    await cleanupTempDirs(dirs);

    expect(dirs).toEqual([]);
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rm)).toHaveBeenNthCalledWith(1, "/tmp/lwf-a", {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
    expect(vi.mocked(rm)).toHaveBeenNthCalledWith(2, "/tmp/lwf-b", {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });
});

describe("workerScopedTempPrefix", () => {
  it("includes process id and pool id to avoid cross-worker collisions", () => {
    expect(workerScopedTempPrefix("lwf-acceptance-", "pool-3")).toBe(
      `lwf-acceptance-${process.pid}-pool-3-`,
    );
  });

  it("uses a default worker label when pool id is not provided", () => {
    expect(workerScopedTempPrefix("lwf-acceptance-")).toBe(
      `lwf-acceptance-${process.pid}-worker-`,
    );
  });
});
