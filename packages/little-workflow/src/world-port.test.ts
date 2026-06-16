import { describe, it, expect } from "vitest";
import type { World } from "./world-port.js";
import { localWorld } from "./authoring.js";

describe("World port", () => {
  it("localWorld() satisfies the World port with all required methods", () => {
    const world = localWorld({ dataDir: ".tmp-test" }) as unknown as World;
    expect(typeof world.appendEvent).toBe("function");
    expect(typeof world.listEvents).toBe("function");
    expect(typeof world.writeArtifact).toBe("function");
    expect(typeof world.readArtifact).toBe("function");
    expect(typeof world.readArtifactManifest).toBe("function");
  });
});
