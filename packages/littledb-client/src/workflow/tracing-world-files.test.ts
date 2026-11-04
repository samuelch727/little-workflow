import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { virtualWorld, type World } from "@little-stack/workflow";
import { createLittleDB } from "../client.js";
import { fakeLittleDB } from "../test/fake-littledb.js";

// The filesystem is the workflow package's own dependency; the client keeps no
// runtime dependency on just-bash solely for this contract test.
const { InMemoryFs } = createRequire(import.meta.resolve("@little-stack/workflow"))("just-bash") as {
  InMemoryFs: new () => NonNullable<World["files"]>;
};

it("tracingWorld preserves the filesystem object and shares its inner event store", async () => {
  const fs = new InMemoryFs();
  const inner = virtualWorld({ fs, dataDir: "/runs" });
  const fake = fakeLittleDB();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
  const traced = db.tracingWorld(inner, { workflow: "virtual.acceptance" });
  expect(traced.files).toBe(fs);
  expect(traced.dataDir).toBe(inner.dataDir);
  const event = await traced.appendEvent("run_proxy_files", {
    type: "RunStarted", payload: { workflowVersionId: "wv_virtual" },
  });
  expect(await inner.listEvents("run_proxy_files")).toEqual([event]);
  expect(await virtualWorld({ fs, dataDir: "/runs/./" }).listEvents("run_proxy_files")).toEqual([event]);
  await db.flush();
});
