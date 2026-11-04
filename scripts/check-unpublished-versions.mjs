#!/usr/bin/env node
// Pre-publish guard: refuses to publish when a package's version already exists on npm.
//
// pnpm rewrites `workspace:^` to the dependency's current version when publishing, so a
// Workflow published from this tree depends on the Harness version in this tree. If that
// Harness version is already on npm with different contents, installers get the old
// tarball and Workflow breaks at import time. Bumping every package that changed, and
// publishing them together, avoids that; this check enforces the bump.
//
// Usage: node scripts/check-unpublished-versions.mjs <package-dir>...
//        (defaults to the packages `pnpm publish:alpha` publishes)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dirs = process.argv.slice(2);
const packageDirs = dirs.length > 0 ? dirs : ["packages/little-harness", "packages/little-workflow"];

let failed = false;
for (const dir of packageDirs) {
  const manifest = JSON.parse(readFileSync(join(resolve(root, dir), "package.json"), "utf8"));
  const spec = `${manifest.name}@${manifest.version}`;
  let published;
  try {
    published = execFileSync("npm", ["view", spec, "version", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404")) {
      console.log(`ok    ${spec} is not on npm yet`);
      continue;
    }
    console.error(`error ${spec}: could not ask the npm registry (${stderr.trim() || error.message})`);
    failed = true;
    continue;
  }
  if (published === "" || published === "undefined") {
    console.log(`ok    ${spec} is not on npm yet`);
    continue;
  }
  console.error(`error ${spec} is already on npm. Bump the version before publishing.`);
  failed = true;
}
process.exit(failed ? 1 : 0);
