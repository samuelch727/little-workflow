import {
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "just-bash";

/**
 * Bump when the *shape* of {@link Tier0CapabilityMatrix} changes, so a consumer that
 * persists a classification can tell an old record from a new one.
 */
export const TIER0_MATRIX_SCHEMA_VERSION = 1;

/**
 * Bump when the *content* below changes (a new needs-real-exec entry, a re-pinned
 * snapshot after a just-bash upgrade). Date-ordinal so it sorts.
 */
export const TIER0_MATRIX_VERSION = "2026-08-14.1";

/**
 * The emulator the pinned halves of this matrix were observed against. Informational
 * only — just-bash does not export its `package.json`, so this cannot be read back at
 * runtime. The drift tests, not this string, are what actually catches an upgrade.
 */
export const TIER0_EMULATOR = "just-bash@3.0.1";

/**
 * Which runtime toggle has to be on for just-bash to register a command.
 * `"always"` — registered unconditionally.
 */
export type Tier0Capability = "always" | "python" | "javascript" | "network";

/** Why a command can only run in a real execution environment. */
export type Tier0RealExecReason =
  | "version-control"
  | "containers"
  | "build-toolchain"
  | "package-manager"
  | "network-client"
  | "process-control"
  | "interactive"
  | "unimplemented-builtin";

export type Tier0CapabilityMatrix = {
  readonly schemaVersion: number;
  readonly matrixVersion: string;
  readonly emulator: string;
  /**
   * Every command just-bash can register, mapped to the toggle that registers it.
   * Derived from the library at load time — never hand-maintained.
   */
  readonly commands: ReadonlyMap<string, Tier0Capability>;
  /**
   * Shell builtins just-bash implements. Not part of the command registry, so this half
   * is pinned and guarded by a drift test that probes the live interpreter.
   */
  readonly builtins: ReadonlySet<string>;
  /** Commands only a real execution environment can run, and why. */
  readonly needsRealExec: ReadonlyMap<string, Tier0RealExecReason>;
};

/**
 * Snapshot of `getCommandNames()` — the commands just-bash registers unconditionally.
 * The live matrix is built from the getters, not from this; the snapshot exists so a
 * just-bash upgrade that adds or drops a command fails a test instead of silently
 * changing what Tier-0 claims to support.
 */
export const TIER0_ALWAYS_COMMANDS_SNAPSHOT: readonly string[] = [
  "alias", "awk", "base64", "basename", "bash", "cat", "chmod", "clear", "column", "comm",
  "cp", "cut", "date", "diff", "dirname", "du", "echo", "egrep", "env", "expand", "expr",
  "false", "fgrep", "file", "find", "fold", "grep", "gunzip", "gzip", "head", "help",
  "history", "hostname", "html-to-markdown", "join", "jq", "ln", "ls", "md5sum", "mkdir",
  "mv", "nl", "od", "paste", "printenv", "printf", "pwd", "readlink", "rev", "rg", "rm",
  "rmdir", "sed", "seq", "sh", "sha1sum", "sha256sum", "sleep", "sort", "split", "sqlite3",
  "stat", "strings", "tac", "tail", "tar", "tee", "time", "timeout", "touch", "tr", "tree",
  "true", "unalias", "unexpand", "uniq", "wc", "which", "whoami", "xan", "xargs", "yq",
  "zcat",
];

/** Snapshot of `getPythonCommandNames()` — CPython on WASM, gated on `runtime.python`. */
export const TIER0_PYTHON_COMMANDS_SNAPSHOT: readonly string[] = ["python", "python3"];

/** Snapshot of `getJavaScriptCommandNames()` — QuickJS, gated on `runtime.javascript`. */
export const TIER0_JAVASCRIPT_COMMANDS_SNAPSHOT: readonly string[] = ["js-exec", "node"];

/**
 * Snapshot of `getNetworkCommandNames()` — gated on `runtime.network`. just-bash's README
 * says "curl, wget"; 3.0.1 registers only `curl`, which is why this is derived rather than
 * copied from the docs. `wget` therefore lives in {@link TIER0_NEEDS_REAL_EXEC} until the
 * library actually ships it (the overlap invariant test flags the day it does).
 */
export const TIER0_NETWORK_COMMANDS_SNAPSHOT: readonly string[] = ["curl"];

/**
 * Shell builtins just-bash implements. Not derivable: the `help` builtin advertises the
 * full bash builtin list, including 14 names that return 127 when invoked
 * ({@link TIER0_UNIMPLEMENTED_BUILTINS}), so `help` is documentation, not a capability
 * table. Pinned from probing the interpreter; the drift test re-probes.
 */
export const TIER0_BUILTINS: readonly string[] = [
  ".", ":", "[", "alias", "break", "builtin", "cd", "command", "compgen", "complete",
  "continue", "declare", "dirs", "echo", "eval", "exec", "exit", "export", "false",
  "getopts", "hash", "help", "history", "let", "local", "mapfile", "popd", "printf",
  "pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt",
  "source", "test", "true", "type", "typeset", "unalias", "unset", "wait",
];

/**
 * Builtins `help` lists but the interpreter does not implement — invoking any of them
 * yields `bash: <name>: command not found` and exit 127. A real shell does implement
 * them, so they escalate rather than deny.
 */
export const TIER0_UNIMPLEMENTED_BUILTINS: readonly string[] = [
  "bg", "caller", "disown", "enable", "fc", "fg", "jobs", "kill", "logout", "suspend",
  "times", "trap", "ulimit", "umask",
];

/**
 * Commands an agent commonly reaches for that Tier-0 cannot emulate at any setting —
 * they need a real process, a real network stack, or a real toolchain. This list is
 * about *escalation quality*, not correctness: a command missing from it still escalates
 * (as `unknown-command`); being listed just means the reason is specific enough for a
 * consumer to act on.
 *
 * Notably absent from just-bash: `git`. There is no git emulation at all — every git
 * subcommand, read or write, is a Tier-0 miss.
 */
export const TIER0_NEEDS_REAL_EXEC: readonly (readonly [string, Tier0RealExecReason])[] = [
  ["git", "version-control"],
  ["hg", "version-control"],
  ["svn", "version-control"],
  ["gh", "version-control"],
  ["docker", "containers"],
  ["docker-compose", "containers"],
  ["podman", "containers"],
  ["kubectl", "containers"],
  ["helm", "containers"],
  ["make", "build-toolchain"],
  ["cmake", "build-toolchain"],
  ["cargo", "build-toolchain"],
  ["rustc", "build-toolchain"],
  ["gcc", "build-toolchain"],
  ["g++", "build-toolchain"],
  ["cc", "build-toolchain"],
  ["clang", "build-toolchain"],
  ["go", "build-toolchain"],
  ["java", "build-toolchain"],
  ["javac", "build-toolchain"],
  ["mvn", "build-toolchain"],
  ["gradle", "build-toolchain"],
  ["tsc", "build-toolchain"],
  ["playwright", "build-toolchain"],
  ["pytest", "build-toolchain"],
  ["jest", "build-toolchain"],
  ["vitest", "build-toolchain"],
  ["npm", "package-manager"],
  ["npx", "package-manager"],
  ["pnpm", "package-manager"],
  ["yarn", "package-manager"],
  ["bun", "package-manager"],
  ["deno", "package-manager"],
  ["pip", "package-manager"],
  ["pip3", "package-manager"],
  ["poetry", "package-manager"],
  ["uv", "package-manager"],
  ["gem", "package-manager"],
  ["bundle", "package-manager"],
  ["apt", "package-manager"],
  ["apt-get", "package-manager"],
  ["apk", "package-manager"],
  ["brew", "package-manager"],
  ["dnf", "package-manager"],
  ["yum", "package-manager"],
  ["wget", "network-client"],
  ["ssh", "network-client"],
  ["scp", "network-client"],
  ["sftp", "network-client"],
  ["rsync", "network-client"],
  ["nc", "network-client"],
  ["netcat", "network-client"],
  ["telnet", "network-client"],
  ["ping", "network-client"],
  ["dig", "network-client"],
  ["nslookup", "network-client"],
  ["host", "network-client"],
  ["ps", "process-control"],
  ["top", "process-control"],
  ["htop", "process-control"],
  ["pkill", "process-control"],
  ["killall", "process-control"],
  ["systemctl", "process-control"],
  ["service", "process-control"],
  ["mount", "process-control"],
  ["umount", "process-control"],
  ["df", "process-control"],
  ["free", "process-control"],
  ["uname", "process-control"],
  ["chown", "process-control"],
  ["sudo", "process-control"],
  ["su", "process-control"],
  ["vim", "interactive"],
  ["vi", "interactive"],
  ["nano", "interactive"],
  ["emacs", "interactive"],
  ["less", "interactive"],
  ["more", "interactive"],
  ["man", "interactive"],
];

let cached: Tier0CapabilityMatrix | undefined;

/**
 * The Tier-0 capability matrix: what just-bash can run, under which runtime toggle, and
 * what it provably cannot.
 *
 * Half derived, half pinned, on purpose. The command registry is read from just-bash's
 * own getters so an upgrade cannot leave us claiming support for a command that was
 * dropped (or missing one that was added). The builtin table and the needs-real-exec list
 * have no equivalent getter, so they are pinned data with drift tests that re-derive them
 * from the live library and fail loudly on divergence.
 *
 * Memoized: the getters are pure and the result is deeply readonly.
 */
export function tier0CapabilityMatrix(): Tier0CapabilityMatrix {
  if (cached === undefined) {
    const commands = new Map<string, Tier0Capability>();
    for (const name of getCommandNames()) {
      commands.set(name, "always");
    }
    for (const name of getPythonCommandNames()) {
      commands.set(name, "python");
    }
    for (const name of getJavaScriptCommandNames()) {
      commands.set(name, "javascript");
    }
    for (const name of getNetworkCommandNames()) {
      commands.set(name, "network");
    }
    const needsRealExec = new Map<string, Tier0RealExecReason>(TIER0_NEEDS_REAL_EXEC);
    for (const name of TIER0_UNIMPLEMENTED_BUILTINS) {
      needsRealExec.set(name, "unimplemented-builtin");
    }
    cached = {
      schemaVersion: TIER0_MATRIX_SCHEMA_VERSION,
      matrixVersion: TIER0_MATRIX_VERSION,
      emulator: TIER0_EMULATOR,
      commands,
      builtins: new Set(TIER0_BUILTINS),
      needsRealExec,
    };
  }
  return cached;
}
