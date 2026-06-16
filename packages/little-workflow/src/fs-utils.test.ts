import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeDirRetrySafe } from "./fs-utils.js";

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(async () => undefined),
}));

describe("removeDirRetrySafe", () => {
  beforeEach(() => {
    vi.mocked(rm).mockClear();
  });

  it("removes directories with retry-safe options", async () => {
    await removeDirRetrySafe("/tmp/lwf-lock-dir");

    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rm)).toHaveBeenCalledWith("/tmp/lwf-lock-dir", {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });
});
