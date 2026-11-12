import { cp, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { prepareHarnessContract } from "../scripts/prepare-harness-contract.mjs";
import { runHarnessConformance } from "./harness-contract-v1/harness.js";

test("the exact approved standalone artifact passes all shared vectors", async () => {
  const result = await prepareHarnessContract();
  expect(result).toEqual({
    sourceCommit: "3688a27d865e765e80bbd2807fb650d3974d6c0c",
    manifestSha256: "99158a3a8fafb0c48de7c8ebb9d9154d4214082bbe7b1f4171e81b382198dc55",
    payloadFiles: 34,
  });
  const vectors = JSON.parse(
    await readFile(new URL("./harness-contract-v1/contract-vectors.json", import.meta.url), "utf8"),
  );
  expect(runHarnessConformance(vectors)).toEqual({ passed: 21, failures: [] });
  const checker = new URL("./harness-contract-v1/check-vectors.mjs", import.meta.url);
  expect(execFileSync(process.execPath, [checker.pathname], { encoding: "utf8" })).toContain(
    "Passed 15 foundation vectors\nPassed 21 contract vectors",
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "little-contract-text-"));
  await cp(new URL("../vendor/", import.meta.url), join(root, "vendor"), { recursive: true });
  return root;
}

for (const [name, damage, expected] of [
  [
    "manifest bytes",
    async (root) => {
      const path = join(root, "vendor/harness-contract-v1/manifest.json");
      await writeFile(path, `${await readFile(path, "utf8")}\n`);
    },
    "manifest pin mismatch",
  ],
  [
    "payload bytes",
    (root) => writeFile(join(root, "vendor/harness-contract-v1/harness.js"), "corrupt"),
    "payload hash mismatch",
  ],
  [
    "unlisted file",
    (root) => writeFile(join(root, "vendor/harness-contract-v1/extra.js"), "unreviewed"),
    "Unexpected harness contract payload",
  ],
  [
    "symbolic link",
    async (root) => {
      const path = join(root, "vendor/harness-contract-v1/harness.js");
      await rm(path);
      await symlink("harnessJson.js", path);
    },
    "Unexpected harness contract payload",
  ],
  [
    "source pin",
    async (root) => {
      const path = join(root, "vendor/harness-contract-v1.pin.json");
      const pin = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...pin, sourceCommit: "bad-source" }));
    },
    "source pin mismatch",
  ],
]) {
  test(`${name} drift fails before generating code`, async () => {
    const root = await fixture();
    try {
      await damage(root);
      await expect(prepareHarnessContract(root)).rejects.toThrow(expected);
      await expect(
        readFile(join(root, "src/harness-contract-v1/harness.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("concurrent preparations remain atomic and generated drift is never overwritten", async () => {
  const root = await fixture();
  try {
    await Promise.all([prepareHarnessContract(root), prepareHarnessContract(root)]);
    await writeFile(join(root, "src/harness-contract-v1/harness.js"), "corrupt");
    await expect(prepareHarnessContract(root)).rejects.toThrow("generated harness contract drift");
    expect(await readFile(join(root, "src/harness-contract-v1/harness.js"), "utf8")).toBe(
      "corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Harness and dist consume exactly the same verified text as the client", async () => {
  const root = await fixture();
  const harness = await mkdtemp(join(tmpdir(), "little-contract-harness-"));
  try {
    await prepareHarnessContract(harness, true, root);
    const source = await readFile(join(root, "vendor/harness-contract-v1/harness.js"));
    expect(await readFile(join(harness, "src/harness-contract-v1/harness.js"))).toEqual(source);
    expect(await readFile(join(harness, "dist/harness-contract-v1/harness.js"))).toEqual(source);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
  }
});
