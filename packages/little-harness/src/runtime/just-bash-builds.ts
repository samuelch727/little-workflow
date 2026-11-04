import * as justBash from "just-bash";

type JustBashModule = typeof justBash;

/**
 * just-bash ships two builds. Node loads the full one; workerd and browsers resolve its
 * `browser` export, which leaves out everything that needs Node: the disk filesystems, the
 * Python, JavaScript, sqlite3, tar, yq and xan commands, and the parser and command lists Tier-0
 * classification reads. A named import of any of those fails the bundle on workerd, so they
 * are read here by a name the bundler cannot see. On the browser build the export is simply
 * `undefined`, and each caller says what that runtime cannot do.
 */
export function justBashNodeExport<TName extends keyof JustBashModule>(
  name: TName,
): JustBashModule[TName] | undefined {
  return (justBash as Partial<Record<keyof JustBashModule, unknown>>)[name] as
    | JustBashModule[TName]
    | undefined;
}

/** Whether just-bash's Node build is loaded: false on workerd and in browsers. */
export function hasJustBashNodeBuild(): boolean {
  return justBashNodeExport("ReadWriteFs") !== undefined;
}

/**
 * Commands just-bash's browser build lists but cannot run: they answer "not available in
 * browser environments". The browser build keeps no export of this list, so it is pinned.
 */
export const JUST_BASH_NODE_ONLY_COMMANDS: readonly string[] = [
  "python3",
  "python",
  "js-exec",
  "node",
  "sqlite3",
  "tar",
  "yq",
  "xan",
];
