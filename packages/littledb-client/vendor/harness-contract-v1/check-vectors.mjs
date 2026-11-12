import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHarnessFiles, accountHarnessStatic, textDigest, digest, runHarnessConformance } from "./harness.js";

const vectors = JSON.parse(await readFile(new URL("./vectors.json", import.meta.url), "utf8"));
for (const vector of vectors.text) assert.equal(textDigest(vector.input), vector.hash, vector.name);
for (const vector of vectors.json) assert.equal(digest(vector.input), vector.hash, vector.name);
for (const vector of vectors.files) {
  if (vector.error) assert.throws(() => parseHarnessFiles(vector.input), e => e.problem?.code === vector.error, vector.name);
  else {
    const result = parseHarnessFiles(vector.input);
    assert.equal(result.totalBytes, vector.totalBytes, vector.name);
    assert.equal(result.bundleHash, vector.bundleHash, vector.name);
    assert.deepEqual(result.manifest, vector.manifest, vector.name);
  }
}
for (const vector of vectors.budget) {
  const result = accountHarnessStatic(vector.parts, vector.limits, vector.refinement);
  for (const [key, expected] of Object.entries(vector.expected)) assert.deepEqual(result[key], expected, `${vector.name}: ${key}`);
}
process.stdout.write(`Passed ${Object.values(vectors).reduce((sum, rows) => sum + rows.length, 0)} foundation vectors\n`);
const contracts = runHarnessConformance(JSON.parse(await readFile(new URL("./contract-vectors.json", import.meta.url), "utf8")));
assert.deepEqual(contracts.failures, []);
process.stdout.write(`Passed ${contracts.passed} contract vectors\n`);
