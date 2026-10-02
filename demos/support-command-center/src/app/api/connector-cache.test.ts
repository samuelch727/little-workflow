import { describe, expect, test, vi } from "vitest";
import { loadCachedConnector, type ConnectorCache } from "./connector-cache";

describe("loadCachedConnector", () => {
  test("reuses a successful load promise", async () => {
    const cache: ConnectorCache<string> = {};
    const load = vi.fn(async () => "ready");

    await expect(loadCachedConnector(cache, load)).resolves.toBe("ready");
    await expect(loadCachedConnector(cache, load)).resolves.toBe("ready");

    expect(load).toHaveBeenCalledOnce();
  });

  test("clears a rejected load promise so the next request can retry", async () => {
    const cache: ConnectorCache<string> = {};
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("cold start failed"))
      .mockResolvedValueOnce("ready");

    await expect(loadCachedConnector(cache, load)).rejects.toThrow(/cold start failed/u);
    await expect(loadCachedConnector(cache, load)).resolves.toBe("ready");

    expect(load).toHaveBeenCalledTimes(2);
  });
});
