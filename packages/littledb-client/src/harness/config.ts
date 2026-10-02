import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ResolveConfigResponseSchema, type ConfigBundle, type ResolveConfigResponse } from "../contract.js";

/** Persistence for the last-resolved config bundle, so a run survives a control-plane outage. */
export interface ConfigCache {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export interface ConfigResolverOptions {
  controlPlaneUrl: string;
  /** Per-project API key. Omit when targeting a local control plane (local mode). */
  projectKey?: string;
  fetchImpl?: typeof fetch;
  cache?: ConfigCache;
}

/** Only attach x-api-key when a project key is configured (cloud); local mode sends none. */
function authHeaders(projectKey: string | undefined): Record<string, string> {
  return projectKey ? { "x-api-key": projectKey } : {};
}

export interface ResolveInput {
  harnessId: string;
  channel?: string;
  bootstrapConfig?: ConfigBundle;
}

/** Hash the control-plane scope so different projects/envs don't collide, without embedding secrets in the key. */
function scopeHash(controlPlaneUrl: string, projectKey: string | undefined): string {
  return createHash("sha256").update(`${controlPlaneUrl} ${projectKey ?? ""}`).digest("hex").slice(0, 16);
}

const cacheKey = (scope: string, harnessId: string, channel: string) => `${scope}:${harnessId}:${channel}`;

/** Default cache: one JSON file per key under ~/.littledb/config-cache. */
function diskCache(): ConfigCache {
  const dir = join(homedir(), ".littledb", "config-cache");
  const fileFor = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async read(key) {
      try {
        return await readFile(fileFor(key), "utf8");
      } catch {
        return null;
      }
    },
    async write(key, value) {
      const file = fileFor(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, value, "utf8");
    },
  };
}

export interface ConfigResolver {
  resolve(input: ResolveInput): Promise<ResolveConfigResponse>;
}

/**
 * Resolves managed config from the littleDB control plane, pinning it for the run.
 * On a control-plane outage it returns the last-cached bundle flagged `staleConfig`,
 * so a run never blocks on the platform being reachable.
 */
export function createConfigResolver(options: ConfigResolverOptions): ConfigResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? diskCache();
  const scope = scopeHash(options.controlPlaneUrl, options.projectKey);

  async function fallback(key: string, originalError: unknown): Promise<ResolveConfigResponse> {
    const cached = await cache.read(key);
    if (cached === null) throw originalError;
    // Let corrupt-cache parse errors propagate — do not double-degrade.
    const parsed = ResolveConfigResponseSchema.parse(JSON.parse(cached));
    return { ...parsed, staleConfig: true };
  }

  return {
    async resolve(input) {
      const channel = input.channel ?? "production";
      const key = cacheKey(scope, input.harnessId, channel);

      // Step 1: attempt the network request; only catch genuine connection errors here.
      let res: Response;
      try {
        res = await fetchImpl(`${options.controlPlaneUrl}/api/config/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders(options.projectKey) },
          body: JSON.stringify({ harnessId: input.harnessId, channel, bootstrapConfig: input.bootstrapConfig }),
        });
      } catch (networkErr) {
        // Network/connection error → fall back to cache.
        return fallback(key, networkErr);
      }

      // Step 2: handle non-2xx. 5xx = outage → fall back. 4xx = auth/config error → throw.
      if (!res.ok) {
        if (res.status >= 500) {
          return fallback(key, new Error(`resolveConfig → HTTP ${res.status}`));
        }
        throw new Error(`resolveConfig → HTTP ${res.status}`);
      }

      // Step 3: parse response. Schema drift must surface; no fallback.
      const parsed = ResolveConfigResponseSchema.parse(await res.json());

      // Step 4: write to cache best-effort; a write failure must not discard the fresh response.
      try {
        await cache.write(key, JSON.stringify(parsed));
      } catch {
        // Intentionally swallowed — cache write is best-effort.
      }

      return parsed;
    },
  };
}
