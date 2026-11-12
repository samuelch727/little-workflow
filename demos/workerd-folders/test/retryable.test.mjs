import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/retryable.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { retryable } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
test("a failed agent load can retry, while concurrent/successful loads reuse one promise", async () => {
  let calls = 0;
  const get = retryable(async () => { if (++calls === 1) throw new Error("transient"); return { value: "loaded" }; });
  await assert.rejects(get("support"), /transient/);
  const [a, b] = await Promise.all([get("support"), get("support")]);
  assert.equal(a, b); assert.equal(await get("support"), a); assert.equal(calls, 2);
});

test("successful caches are keyed by agent and a failure does not evict another agent", async () => {
  const counts = new Map();
  const get = retryable(async key => {
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    if (key === "support" && count === 1) throw new Error("temporary support failure");
    return { agent: key };
  });
  const other = await get("other");
  await assert.rejects(get("support"), /temporary/);
  assert.equal(await get("other"), other);
  const support = await get("support");
  assert.notEqual(support, other); assert.deepEqual(support, { agent: "support" });
  assert.equal(await get("support"), support); assert.equal(counts.get("other"), 1);
});
