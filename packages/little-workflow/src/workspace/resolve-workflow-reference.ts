import { stat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoadWorkflowOptions } from "./load-workflow.js";

type LittleWorkflowConfig = {
  readonly workflows?: Readonly<Record<string, string>>;
};

export type ResolvedWorkflowReference = {
  readonly folder: string | URL;
  readonly loadOptions?: LoadWorkflowOptions;
};

export async function resolveWorkflowReference(
  reference: string,
  options: { readonly cwd?: string } = {},
): Promise<ResolvedWorkflowReference> {
  if (isFileUrl(reference)) {
    const folder = new URL(reference);
    await assertDirectory(fileURLToPath(folder), `Workflow folder does not exist: ${reference}`);
    return { folder };
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const direct = resolve(cwd, reference);
  if (await isDirectory(direct)) {
    return { folder: direct };
  }

  const manifestPath = await nearestManifest(cwd);
  if (manifestPath === undefined) {
    throw new Error(`No little-workflow.json found while resolving workflow '${reference}'.`);
  }
  const manifestRoot = dirname(manifestPath);
  const config = JSON.parse(await readFile(manifestPath, "utf8")) as LittleWorkflowConfig;
  const target = config.workflows?.[reference];
  if (target === undefined) {
    throw new Error(`Unknown workflow '${reference}' in ${manifestPath}.`);
  }
  if (isAbsolute(target)) {
    throw new Error(`Workflow '${reference}' must use a relative manifest path.`);
  }

  const folder = resolve(manifestRoot, target);
  if (!isWithin(folder, manifestRoot)) {
    throw new Error(`Workflow '${reference}' escapes the manifest root.`);
  }
  await assertDirectory(folder, `Workflow '${reference}' does not resolve to a directory: ${target}`);
  return { folder };
}

async function nearestManifest(start: string): Promise<string | undefined> {
  let dir = start;
  while (true) {
    const candidate = resolve(dir, "little-workflow.json");
    if (await isFile(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function assertDirectory(path: string, message: string): Promise<void> {
  if (!(await isDirectory(path))) {
    throw new Error(message);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
}

function isWithin(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}
