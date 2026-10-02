import {
  Bash,
  BashTransformPipeline,
  CommandCollectorPlugin,
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "just-bash";
import { describe, expect, it } from "vitest";
import {
  tier0CapabilityMatrix,
  TIER0_ALWAYS_COMMANDS_SNAPSHOT,
  TIER0_BUILTINS,
  TIER0_JAVASCRIPT_COMMANDS_SNAPSHOT,
  TIER0_MATRIX_SCHEMA_VERSION,
  TIER0_NETWORK_COMMANDS_SNAPSHOT,
  TIER0_PYTHON_COMMANDS_SNAPSHOT,
  TIER0_UNIMPLEMENTED_BUILTINS,
} from "./tier0-capability-matrix.js";

/**
 * Runs a bare command name in a fresh interpreter and reports whether just-bash resolved
 * it at all. The 127 + exact-message shape is the interpreter's command-resolution miss;
 * anything else (usage error, success, a different failure) means the name is implemented.
 */
async function isImplemented(name: string): Promise<boolean> {
  const result = await Promise.race([
    new Bash().exec(name),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]);
  return !(result.exitCode === 127 && result.stderr === `bash: ${name}: command not found\n`);
}

describe("tier0CapabilityMatrix", () => {
  it("derives the command table from just-bash instead of a hand-kept list", () => {
    const matrix = tier0CapabilityMatrix();
    for (const name of getCommandNames()) {
      expect(matrix.commands.get(name)).toBe("always");
    }
    for (const name of getPythonCommandNames()) {
      expect(matrix.commands.get(name)).toBe("python");
    }
    for (const name of getJavaScriptCommandNames()) {
      expect(matrix.commands.get(name)).toBe("javascript");
    }
    for (const name of getNetworkCommandNames()) {
      expect(matrix.commands.get(name)).toBe("network");
    }
    expect(matrix.schemaVersion).toBe(TIER0_MATRIX_SCHEMA_VERSION);
  });

  it("has no command that is both emulated and on the needs-real-exec list", () => {
    // The registry is derived and the needs-real-exec list is pinned, so an upgrade that
    // starts emulating something we wrote off (just-bash's README already promises `wget`)
    // must fail here rather than quietly escalate a command Tier-0 could have run.
    const matrix = tier0CapabilityMatrix();
    const overlap = [...matrix.needsRealExec.keys()].filter(
      (name) => matrix.commands.has(name) || matrix.builtins.has(name),
    );
    expect(overlap).toEqual([]);
  });

  it("keeps git off the emulated list — there is no git emulation at any setting", () => {
    const matrix = tier0CapabilityMatrix();
    expect(matrix.commands.has("git")).toBe(false);
    expect(matrix.needsRealExec.get("git")).toBe("version-control");
  });
});

describe("capability-matrix drift", () => {
  it("matches the pinned registry snapshots", () => {
    expect([...getCommandNames()].sort()).toEqual([...TIER0_ALWAYS_COMMANDS_SNAPSHOT]);
    expect([...getPythonCommandNames()].sort()).toEqual([...TIER0_PYTHON_COMMANDS_SNAPSHOT]);
    expect([...getJavaScriptCommandNames()].sort()).toEqual([
      ...TIER0_JAVASCRIPT_COMMANDS_SNAPSHOT,
    ]);
    expect([...getNetworkCommandNames()].sort()).toEqual([...TIER0_NETWORK_COMMANDS_SNAPSHOT]);
  });

  it("re-derives the pinned builtin table from the live interpreter", async () => {
    const missing: string[] = [];
    for (const name of TIER0_BUILTINS) {
      if (!(await isImplemented(name))) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the builtins `help` advertises but does not implement on the escalate side", async () => {
    // `help` prints the full bash builtin list, so it is documentation, not a capability
    // table. These 14 names are in it and still return 127.
    const implemented: string[] = [];
    for (const name of TIER0_UNIMPLEMENTED_BUILTINS) {
      if (await isImplemented(name)) {
        implemented.push(name);
      }
    }
    expect(implemented).toEqual([]);
  });

  it("pins the just-bash AST surface classification depends on", () => {
    // Neither of these ships a .d.ts in 3.0.1 (`files` omits dist/transform/), so both are
    // `any` at compile time. This is the only thing standing between us and a silent
    // "every script is supported" regression after an upgrade.
    expect(typeof CommandCollectorPlugin).toBe("function");
    expect(typeof BashTransformPipeline).toBe("function");
    const pipeline = new BashTransformPipeline().use(new CommandCollectorPlugin());
    const result = pipeline.transform("echo hi | grep hi");
    expect(result.metadata.commands).toEqual(["echo", "grep"]);
  });
});
