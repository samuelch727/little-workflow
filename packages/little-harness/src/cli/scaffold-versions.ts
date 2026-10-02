import { readFileSync } from "node:fs";
import type { ProviderDefinition } from "./provider-catalog.js";

/**
 * Dependency ranges a scaffolded project pins, kept in one table so the `little-harness` and
 * `little-workflow` scaffolds agree. Never `latest`: npm's `latest` for `ai` and the provider
 * packages moves to the next AI SDK major, whose models this package cannot run, and
 * `latest` for this package can trail the CLI that wrote the project.
 */
export type ScaffoldDependencyVersions = {
  readonly littleHarness: string;
  readonly ai: string;
  readonly zod: string;
  readonly devDependencies: Readonly<Record<string, string>>;
};

type PackageManifest = {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
};

// The toolchain this package is built and tested with.
const DEV_DEPENDENCIES = {
  "@types/node": "^24.0.0",
  typescript: "^6.0.3",
  tsx: "^4.23.15",
} as const;

let manifest: PackageManifest | undefined;

function ownManifest(): PackageManifest {
  // src/cli/ and dist/cli/ both sit two levels below the package root.
  manifest ??= JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  return manifest;
}

export function scaffoldDependencyVersions(): ScaffoldDependencyVersions {
  const pkg = ownManifest();
  const ai = pkg.peerDependencies?.ai;
  const zod = pkg.dependencies?.zod;
  if (ai === undefined || zod === undefined) {
    throw new Error("little-harness package.json must declare the ai peer range and the zod range.");
  }
  return { littleHarness: `^${pkg.version}`, ai, zod, devDependencies: DEV_DEPENDENCIES };
}

/** The `[packageName, range]` a scaffold adds for a provider, or undefined for the gateway. */
export function providerDependency(provider: ProviderDefinition): readonly [string, string] | undefined {
  if (provider.packageName === undefined) {
    return undefined;
  }
  if (provider.packageVersion === undefined) {
    throw new Error(`Provider '${provider.id}' has a package but no pinned packageVersion.`);
  }
  return [provider.packageName, provider.packageVersion];
}
