import type { ToolSet } from "ai";
import { HarnessInputError } from "./errors.js";
import { resolveHarnessMemory } from "./memory/memory.js";
import { resolveTraceOptions } from "./trace/options.js";
import type { CreateHarnessOptions, Harness, PersistentDir, ResolvedHarnessConfig } from "./types.js";

const HARNESS_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_USER_TOOL_NAMES = new Set(["bash", "__proto__", "constructor", "prototype"]);

export function createHarness<TTools extends ToolSet = ToolSet, TExtraBody = unknown>(
  options: CreateHarnessOptions<TTools, TExtraBody>,
): Harness<TTools, TExtraBody> {
  const userTools = (options.tools ?? {}) as TTools;
  assertSafeUserTools(userTools);
  const resolvedMemory = resolveHarnessMemory(options.memory, userTools);
  const persistentDirs = [...(options.persistentDirs ?? []), ...resolvedMemory.persistentDirs];
  assertUniquePersistentDirs(persistentDirs);
  const config: ResolvedHarnessConfig<TTools, TExtraBody> = {
    ...options,
    tools: { ...userTools, ...resolvedMemory.tools } as TTools,
    skills: options.skills ?? [],
    persistentDirs,
    memory: resolvedMemory.configs,
    trace: resolveTraceOptions(options.trace, undefined),
  };

  return {
    sessions: options.host.sessions,
    config,
  };
}

function assertSafeUserTools(userTools: ToolSet): void {
  for (const name of Object.keys(userTools)) {
    if (!HARNESS_TOOL_NAME.test(name) || RESERVED_USER_TOOL_NAMES.has(name)) {
      throw new HarnessInputError("User tool name is reserved or invalid.", { toolName: name });
    }
  }
}

function assertUniquePersistentDirs(persistentDirs: readonly Pick<PersistentDir, "harnessDir">[]): void {
  const seen = new Map<string, string>();
  for (const persistentDir of persistentDirs) {
    const normalized = canonicalizeHarnessDir(persistentDir.harnessDir);
    const existing = seen.get(normalized);
    if (existing !== undefined) {
      throw new HarnessInputError("Persistent Dir harnessDir values must be unique.", {
        harnessDir: persistentDir.harnessDir,
        duplicateOf: existing,
      });
    }
    seen.set(normalized, persistentDir.harnessDir);
  }
}

function canonicalizeHarnessDir(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    return value;
  }

  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return `/${parts.join("/")}`;
}
