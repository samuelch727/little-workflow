import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { workerdBuildOptions } from "./plugins.js";

/** Keep each link entry, including chained links, before following its target. */
export class TraversalInputs {
  // A link target, false for a plain entry, or null when the entry cannot be read.
  private readonly entries = new Map<string, string | false | null>();

  links(file: string): string[] {
    const links = new Set<string>();
    let path = resolve(file);
    let followed = 0;
    for (;;) {
      const root = parse(path).root;
      const parts = path.slice(root.length).split(sep).filter(Boolean);
      let parent = root;
      let redirected = false;
      for (let i = 0; i < parts.length; i++) {
        const entry = join(parent, parts[i]!);
        let target = this.entries.get(entry);
        if (target === undefined) {
          try {
            const stat = lstatSync(entry, { throwIfNoEntry: false });
            target = stat === undefined ? null : stat.isSymbolicLink() ? readlinkSync(entry) : false;
          } catch { target = null; }
          this.entries.set(entry, target);
        }
        // Nothing beneath a missing or unreadable entry can be read, so it holds no link.
        if (target === null) return [...links];
        if (target !== false) {
          if (++followed > 40) throw new Error(`Too many symbolic links in ${file}`);
          links.add(entry);
          path = resolve(parent, target, ...parts.slice(i + 1));
          redirected = true;
          break;
        }
        parent = entry;
      }
      if (!redirected) return [...links];
    }
  }
}

/** Resolve actual metafile edges from their real importer, retaining lexical routes only. */
export async function resolutionInputs(dir: string, metafile: esbuild.Metafile) {
  // Metafile paths are relative to esbuild's real working directory, even if the
  // CLI reached that directory through an alias. Originals retain their spelling.
  const graphDir = realpathSync(dir);
  let resolver: esbuild.PluginBuild;
  const context = await esbuild.context({
    ...workerdBuildOptions(), absWorkingDir: dir, write: false, preserveSymlinks: true,
    plugins: [{ name: "provenance-resolver", setup(build) { resolver = build; } }],
  });
  const routes = new Set<string>();
  let complete = true;
  const edges = Object.entries(metafile.inputs).flatMap(([file, input]) => input.imports
    .filter((edge) => !edge.external && existsSync(resolve(graphDir, edge.path)))
    .map((edge) => ({ importer: resolve(graphDir, file), edge })));
  let next = 0;
  try {
    // Bound native resolver requests; no second compilation and no primary-build hooks.
    await Promise.all(Array.from({ length: Math.min(16, edges.length) }, async () => {
      for (;;) {
        const item = edges[next++];
        if (item === undefined) return;
        const { importer, edge } = item;
        try {
          const result = await resolver.resolve(edge.original ?? resolve(graphDir, edge.path), {
            importer, namespace: "file", resolveDir: dirname(importer), kind: edge.kind,
            ...(edge.with === undefined ? {} : { with: edge.with }),
          });
          if (result.errors.length || result.external || result.namespace !== "file" ||
            realpathSync(result.path) !== realpathSync(resolve(graphDir, edge.path))) complete = false;
          else routes.add(result.path);
        } catch { complete = false; }
      }
    }));
  } finally { await context.dispose(); }
  return { routes, complete };
}

/** Capture compiler configuration reads without enumerating or type-checking the project. */
export function compilerInputs(files: readonly string[]) {
  const inputs = new Set<string>();
  const searchPaths = new Set<string>();
  const configs = new Set<string>();
  const nearest = new Map<string, string | undefined>();
  let complete = true;
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    readDirectory: () => [],
    readFile(file) {
      searchPaths.add(file);
      try { const content = readFileSync(file, "utf8"); inputs.add(file); return content; }
      catch { return undefined; }
    },
    onUnRecoverableConfigFileDiagnostic() { complete = false; },
  };
  for (const file of files) {
    let dir = dirname(file);
    const checked: string[] = [];
    while (!nearest.has(dir)) {
      checked.push(dir);
      const config = join(dir, "tsconfig.json");
      searchPaths.add(config);
      if (existsSync(config)) { nearest.set(dir, config); break; }
      const parent = dirname(dir);
      if (parent === dir) { nearest.set(dir, undefined); break; }
      dir = parent;
    }
    const config = nearest.get(dir);
    for (const directory of checked) nearest.set(directory, config);
    if (config === undefined || configs.has(config)) continue;
    configs.add(config);
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
      if (parsed === undefined || parsed.errors.some((error) => [5083, 6053, 18000].includes(error.code))) complete = false;
    } catch { complete = false; }
  }
  return { inputs: [...inputs], searchPaths: [...searchPaths], complete };
}

/** Directory metadata participates in imports/exports, entry points and module format. */
export function packageInputs(files: readonly string[]) {
  const inputs = new Set<string>();
  const searchPaths = new Set<string>();
  const directories = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    while (!directories.has(dir)) {
      directories.add(dir);
      const manifest = join(dir, "package.json");
      searchPaths.add(manifest);
      if (existsSync(manifest)) inputs.add(manifest);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { inputs: [...inputs], searchPaths: [...searchPaths] };
}
