import { InMemoryFs, type IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import { virtualWorld } from "./world.js";

describe("virtual World publication", () => {
  it("exposes its filesystem and normalizes its POSIX data root", () => {
    const fs = new InMemoryFs();
    expect(virtualWorld({ fs })).toMatchObject({ kind: "virtual-world", dataDir: "/", files: fs });
    expect(virtualWorld({ fs, dataDir: "/one/../two///", maxConcurrentSteps: 3 }))
      .toMatchObject({ dataDir: "/two", files: fs, maxConcurrentSteps: 3 });
    expect(() => virtualWorld({} as never)).toThrow("requires a filesystem");
  });

  it.each(["before", "after"] as const)("handles a lost result %s filesystem publication", async phase => {
    const backing = new InMemoryFs();
    let interrupt = false;
    const fs: IFileSystem = new Proxy(backing, {
      get(target, property) {
        if (property === "mv") {
          return async (source: string, destination: string) => {
            if (interrupt && destination.endsWith("/0000000002.json")) {
              interrupt = false;
              if (phase === "after") await target.mv(source, destination);
              throw new Error("publication result lost");
            }
            await target.mv(source, destination);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const world = virtualWorld({ fs, dataDir: "/runs" });
    await world.appendEvent("run_publication", { type: "RunStarted", payload: {} });
    const event = {
      type: "RunCompleted" as const,
      appendIdempotencyKey: "virtual-publication-receipt",
      canonicalRequestDigest: `sha256:${"a".repeat(64)}`,
      payload: { ok: true },
    };
    interrupt = true;
    await expect(world.appendEvent("run_publication", event)).rejects.toThrow("publication result lost");
    const published = await world.listEvents("run_publication");
    expect(published.map(entry => entry.sequence)).toEqual(phase === "before" ? [1] : [1, 2]);
    if (phase === "before") {
      expect(backing.getAllPaths().some(path => path.endsWith(".tmp"))).toBe(true);
    }

    // Reopening the same filesystem adds no persistence guarantee beyond it.
    const reopened = virtualWorld({ fs, dataDir: "/runs/./" });
    const retry = await reopened.appendEvent("run_publication", event);
    expect(retry.sequence).toBe(2);
    if (phase === "after") expect(retry).toEqual(published[1]);
    const next = await reopened.appendEvent("run_publication", { type: "RunCompleted", payload: { next: true } });
    expect(next.sequence).toBe(3);
    expect((await reopened.listEvents("run_publication")).map(entry => entry.sequence)).toEqual([1, 2, 3]);
  });
});
