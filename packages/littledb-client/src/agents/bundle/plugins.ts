/**
 * esbuild settings for code that runs in workerd (Cloudflare Workers, or the open-source runtime
 * in a LittleDB cell) with `nodejs_compat`. Shared by the runtime build and the deploy command.
 * Self-contained on purpose: Node runs this file directly (type stripping) from the build script.
 */
import { builtinModules } from "node:module";
import type { BuildOptions, Plugin } from "esbuild";

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

/** The packages the runtime provides to every deployment, and the module each resolves to. */
export const SHARED_MODULES: Readonly<Record<string, string>> = {
  "@little-stack/harness": "./lib-harness.js",
  "@little-stack/littledb": "./lib-littledb.js",
  ai: "./lib-ai.js",
  zod: "./lib-zod.js",
  "zod/v4": "./lib-zod.js",
};

/**
 * Node built-ins stay imports of `node:*` (workerd provides them). A CommonJS `require` of one
 * stays a `require`, which {@link WORKERD_REQUIRE_BANNER} defines for the module.
 */
export function workerdBuiltins(): Plugin {
  return {
    name: "workerd-builtins",
    setup(build) {
      build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const bare = args.path.replace(/^node:/, "");
        if (!NODE_BUILTINS.has(bare) && !NODE_BUILTINS.has(bare.split("/")[0]!)) return undefined;
        return { path: `node:${bare}`, external: true };
      });
      build.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, external: true }));
    },
  };
}

/** Modules that only matter on a developer's machine, replaced with stubs that say so. */
export function workerdStubs(): Plugin {
  return {
    name: "workerd-stubs",
    setup(build) {
      // Harness's agent-folder loader imports jiti to load .ts at runtime; deployments are built ahead.
      build.onResolve({ filter: /^jiti$/ }, () => ({ path: "jiti", namespace: "workerd-stub" }));
      build.onLoad({ filter: /.*/, namespace: "workerd-stub" }, () => ({
        contents: `export function createJiti() { throw new Error("Loading TypeScript at runtime is not available in a deployment; littledb-agents deploy builds the folder ahead."); } export default createJiti;`,
        loader: "js",
      }));
    },
  };
}

/** Sends the shared packages to the runtime's copies instead of bundling them again. */
export function sharedModules(): Plugin {
  return {
    name: "little-shared-modules",
    setup(build) {
      build.onResolve({ filter: /^(@little-stack\/harness|@little-stack\/littledb|ai|zod|zod\/v4)$/ }, (args) => ({
        path: SHARED_MODULES[args.path]!,
        external: true,
      }));
    },
  };
}

/**
 * ES module Workers have no `require`; bundled CommonJS packages still call it for built-ins.
 * esbuild's `__require` uses a `require` in scope when there is one.
 */
export const WORKERD_REQUIRE_BANNER = `import { createRequire as __littleCreateRequire } from "node:module"; const require = __littleCreateRequire("file:///little-agent.js");`;

/** The esbuild options every workerd build starts from. */
export function workerdBuildOptions(): BuildOptions {
  return {
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    conditions: ["workerd", "worker", "import", "default"],
    mainFields: ["module", "main"],
    legalComments: "none",
    logLevel: "silent",
    // A Dynamic Worker's modules have no `import.meta.url`, and packages pass it to
    // `createRequire` (only ever to require built-ins), so any absolute URL will do.
    define: { "process.env.NODE_ENV": '"production"', "import.meta.url": '"file:///little-agent.js"' },
    banner: { js: WORKERD_REQUIRE_BANNER },
  };
}
