// Reviewed text only. Candidate content never chooses artifact bytes, paths or code.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepareHarnessContract(
  root = packageRoot,
  copyDist = false,
  artifactRoot = root,
) {
  const pin = JSON.parse(
    await readFile(join(artifactRoot, "vendor/harness-contract-v1.pin.json"), "utf8"),
  );
  const source = join(artifactRoot, "vendor/harness-contract-v1");
  const readTree = async (target) => {
    if (!(await lstat(target)).isDirectory())
      throw new Error("Unexpected harness contract payload");
    const actual = await readdir(target, { withFileTypes: true });
    if (actual.some((entry) => !entry.isFile()))
      throw new Error("Unexpected harness contract payload");
    const manifestBytes = await readFile(join(target, "manifest.json"));
    if (sha(manifestBytes) !== pin.manifestSha256)
      throw new Error("Harness contract manifest pin mismatch");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (
      manifest.format !== 1 ||
      manifest.status !== "whole-harness-contract-v1" ||
      manifest.sourceCommit !== pin.sourceCommit
    )
      throw new Error("Harness contract source pin mismatch");
    const payload = Object.keys(manifest.files).sort();
    if (
      actual.length !== payload.length + 1 ||
      actual.some((entry) => entry.name !== "manifest.json" && !payload.includes(entry.name))
    )
      throw new Error("Unexpected harness contract payload");
    const verified = new Map([["manifest.json", manifestBytes]]);
    for (const name of payload) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Unexpected harness contract payload");
      const bytes = await readFile(join(target, name));
      if (`sha256:${sha(bytes)}` !== manifest.files[name])
        throw new Error("Harness contract payload hash mismatch");
      verified.set(name, bytes);
    }
    return { payload, verified };
  };
  // Check every reviewable byte before publishing any generated code. Copy only
  // these verified buffers, so a later source edit cannot change the publication.
  const { payload, verified } = await readTree(source);
  const matches = async (target) => {
    try {
      await readTree(target);
      return true;
    } catch {
      return false;
    }
  };
  const publish = async (target) => {
    if (await matches(target)) return;
    const exists = await lstat(target).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      if (await matches(target)) return;
      throw new Error("Existing generated harness contract drift");
    }
    await mkdir(dirname(target), { recursive: true });
    const pending = await mkdtemp(join(root, ".harness-contract-stage-"));
    try {
      for (const [name, bytes] of verified) await writeFile(join(pending, name), bytes);
      try {
        await rename(pending, target);
      } catch (error) {
        if (!(await matches(target))) throw error;
      }
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
  };
  await publish(join(root, "src/harness-contract-v1"));
  if (copyDist) await publish(join(root, "dist/harness-contract-v1"));
  return {
    sourceCommit: pin.sourceCommit,
    manifestSha256: pin.manifestSha256,
    payloadFiles: payload.length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv.includes("--harness")
    ? resolve(packageRoot, "../little-harness")
    : packageRoot;
  await prepareHarnessContract(target, process.argv.includes("--copy-dist"), packageRoot);
}
