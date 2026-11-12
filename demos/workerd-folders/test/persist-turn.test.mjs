import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/persist-turn.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { persistTurn } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
for (const turnFails of [false, true]) for (const saveFails of [false, true]) {
  test(`turn/save outcomes retain original causes (turn=${turnFails},save=${saveFails})`, async () => {
    const turnError = new Error("synthetic turn failure"), saveError = new Error("synthetic save failure");
    const order = [];
    const pending = persistTurn(async () => { order.push("turn"); if (turnFails) throw turnError; return "ok"; },
      async () => { order.push("save"); if (saveFails) throw saveError; });
    if (turnFails && saveFails) await assert.rejects(pending, error => error instanceof AggregateError && error.errors[0] === turnError && error.errors[1] === saveError);
    else if (turnFails || saveFails) await assert.rejects(pending, error => error === (turnFails ? turnError : saveError));
    else assert.equal(await pending, "ok");
    assert.deepEqual(order, ["turn", "save"]);
  });
}
