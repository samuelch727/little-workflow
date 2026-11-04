import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import ts from "typescript";

// The example bundles TS directly into its worker. Load this adapter unchanged,
// apart from resolving its normal package import before using an in-memory URL.
const source = (await readFile(new URL("../src/chat-store.ts", import.meta.url), "utf8"))
  .replace('"@little-stack/harness/host"', JSON.stringify(import.meta.resolve("@little-stack/harness/host")));
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ChatStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("listDir uses literal prefixes and returns direct Unicode children without siblings", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    // Thin DO SqlStorage cursor shim over real SQLite; all adapter SQL runs as written.
    const store = new ChatStore({
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const rows = statement.columns().length > 0
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
        return { toArray: () => rows };
      },
    });
    const dir = "/ledgers/%_scope";
    const children = ["a.json", "folder", "%", "_", "\uFFFF", "😀", "𐐀.json"];
    const paths = [
      `${dir}/a.json`, `${dir}/folder/one.json`, `${dir}/folder/two.json`,
      `${dir}/%/entry.json`, `${dir}/_/entry.json`, `${dir}/\uFFFF/entry.json`,
      `${dir}/😀/entry.json`, `${dir}/𐐀.json`,
      dir, `${dir}-sibling/no.json`, `${dir}0/no.json`, "/ledgers/XXscope/unrelated.json",
    ];
    for (const path of paths) await store.writeJson(path, { path });
    assert.deepEqual((await store.listDir(dir)).toSorted(), children.toSorted());
    assert.deepEqual((await store.listDir(`${dir}/`)).toSorted(), children.toSorted());
    assert.deepEqual(await store.listDir(`${dir}/folder`), ["one.json", "two.json"]);
    assert.deepEqual(await store.listDir(`${dir}/missing`), []);
    await store.remove(`${dir}/a.json`);
    assert.deepEqual((await store.listDir(dir)).toSorted(), children.filter(child => child !== "a.json").toSorted());
  } finally {
    database.close();
  }
});
