import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

for (const subpath of ["sandbox", "host", "internals", "agents", "events", "remote-session", "server"]) {
  it(`resolves ${subpath} for both import and require consumers`, () => {
    // Exercise Node's conditional export resolution, rather than inspecting JSON keys.
    expect(require.resolve(`@little-stack/harness/${subpath}`))
      .toBe(fileURLToPath(import.meta.resolve(`@little-stack/harness/${subpath}`)));
  });
}
