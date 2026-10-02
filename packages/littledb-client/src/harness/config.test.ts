import { describe, expect, it, vi } from "vitest";
import { createConfigResolver } from "./config.js";

const BUNDLE = {
  prompt: "managed",
  skills: [] as string[],
  toolManifest: {},
  modelSlot: "deepseek-chat",
  sampling: {},
  hyperparams: {},
  memoryPolicy: {},
};

function memCache() {
  const store = new Map<string, string>();
  return {
    store,
    read: async (key: string) => store.get(key) ?? null,
    write: async (key: string, v: string) => void store.set(key, v),
  };
}

describe("createConfigResolver", () => {
  it("resolves from the control plane (with the api key) and caches to disk", async () => {
    const cache = memCache();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
      return Response.json({ configVersionId: "cfgv_1", channel: "production", staleConfig: false, config: BUNDLE });
    });
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never, cache });
    const res = await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    expect(res.config.prompt).toBe("managed");
    expect(res.staleConfig).toBe(false);
    // Cache key includes a scope hash; assert behaviorally rather than hardcoding the key
    const cachedValues = [...cache.store.values()];
    expect(cachedValues).toHaveLength(1);
    expect(cachedValues[0]).toContain("cfgv_1");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://cp/api/config/resolve");
  });

  it("falls back to the disk cache and flags staleConfig when the control plane is unreachable", async () => {
    // Prime the cache via a happy resolve, then test fallback with network error
    const cache = memCache();
    const fetchHappy = vi.fn(async () => Response.json({ configVersionId: "cfgv_cached", channel: "production", staleConfig: false, config: BUNDLE }));
    const rPrime = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchHappy as never, cache });
    await rPrime.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    const fetchFail = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchFail as never, cache });
    const res = await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    expect(res.configVersionId).toBe("cfgv_cached");
    expect(res.staleConfig).toBe(true);
  });

  it("rethrows when the control plane is unreachable and there is no cache", async () => {
    const cache = memCache();
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never, cache });
    await expect(r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE })).rejects.toThrow();
  });

  it("falls back to the cached bundle (staleConfig:true) on a 5xx response", async () => {
    // Prime the cache via a happy resolve, then test fallback with 5xx
    const cache = memCache();
    const fetchHappy = vi.fn(async () => Response.json({ configVersionId: "cfgv_cached", channel: "production", staleConfig: false, config: BUNDLE }));
    const rPrime = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchHappy as never, cache });
    await rPrime.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) as never, cache });
    const res = await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    expect(res.configVersionId).toBe("cfgv_cached");
    expect(res.staleConfig).toBe(true);
  });

  it("throws on a 4xx response even when there is a cached entry (no stale fallback for auth errors)", async () => {
    const cache = memCache();
    // Seed cache by priming with a happy resolve
    const fetchHappy = vi.fn(async () => Response.json({ configVersionId: "cfgv_cached", channel: "production", staleConfig: false, config: BUNDLE }));
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchHappy as never, cache });
    await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    // Now use the primed cache with a 401 resolver — should throw, not fall back
    const r2 = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: vi.fn(async () => new Response(null, { status: 401 })) as never, cache });
    await expect(r2.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE })).rejects.toThrow(/401/);
  });

  it("throws when ok response body fails schema validation (drift must surface, not serve stale)", async () => {
    const cache = memCache();
    // Seed cache by priming with a happy resolve
    const fetchHappy = vi.fn(async () => Response.json({ configVersionId: "cfgv_cached", channel: "production", staleConfig: false, config: BUNDLE }));
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchHappy as never, cache });
    await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    // Now serve a malformed response body from the control plane
    const r2 = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: vi.fn(async () => Response.json({ malformed: true })) as never, cache });
    await expect(r2.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE })).rejects.toThrow();
  });

  it("returns the fresh response (staleConfig:false) when cache.write throws", async () => {
    const throwingCache = {
      read: async (_key: string) => null,
      write: async (_key: string, _v: string) => { throw new Error("disk full"); },
    };
    const fetchImpl = vi.fn(async () => Response.json({ configVersionId: "cfgv_fresh", channel: "production", staleConfig: false, config: BUNDLE }));
    const r = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never, cache: throwingCache });
    const res = await r.resolve({ harnessId: "a", channel: "production", bootstrapConfig: BUNDLE });
    expect(res.configVersionId).toBe("cfgv_fresh");
    expect(res.staleConfig).toBe(false);
  });

  it("uses different cache keys for resolvers with different controlPlaneUrl (prevents cross-project cache collisions)", async () => {
    // Both resolvers share the same harnessId+channel but target different control planes.
    // A resolver on "http://cp-a" must not be able to read a cache entry written by "http://cp-b".
    const sharedCache = memCache();
    const fetchA = vi.fn(async () => Response.json({ configVersionId: "cfgv_from_A", channel: "production", staleConfig: false, config: BUNDLE }));
    const fetchB = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    // Resolver A writes a cache entry for harnessId "x", channel "production"
    const rA = createConfigResolver({ controlPlaneUrl: "http://cp-a", projectKey: "k", fetchImpl: fetchA as never, cache: sharedCache });
    await rA.resolve({ harnessId: "x", channel: "production", bootstrapConfig: BUNDLE });

    // Resolver B (different control plane, same harnessId+channel) must NOT find resolver A's entry
    const rB = createConfigResolver({ controlPlaneUrl: "http://cp-b", projectKey: "k", fetchImpl: fetchB as never, cache: sharedCache });
    await expect(rB.resolve({ harnessId: "x", channel: "production", bootstrapConfig: BUNDLE })).rejects.toThrow("ECONNREFUSED");
  });

  it("uses different cache keys for resolvers with different projectKey (prevents cross-project cache collisions)", async () => {
    // Same control plane URL but different project keys — scope hash must differ.
    const sharedCache = memCache();
    const fetchA = vi.fn(async () => Response.json({ configVersionId: "cfgv_project_A", channel: "production", staleConfig: false, config: BUNDLE }));
    const fetchB = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    const rA = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "key-A", fetchImpl: fetchA as never, cache: sharedCache });
    await rA.resolve({ harnessId: "x", channel: "production", bootstrapConfig: BUNDLE });

    const rB = createConfigResolver({ controlPlaneUrl: "http://cp", projectKey: "key-B", fetchImpl: fetchB as never, cache: sharedCache });
    await expect(rB.resolve({ harnessId: "x", channel: "production", bootstrapConfig: BUNDLE })).rejects.toThrow("ECONNREFUSED");
  });
});
