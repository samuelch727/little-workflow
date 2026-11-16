import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TraversalInputs } from "../agents/bundle/provenance.js";

export function git(dir: string, args: string[], trim = true): string | undefined {
  try {
    const output = execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return trim ? output.trim() : output;
  } catch {
    return undefined;
  }
}

function withinDirectory(folder: string, file: string): boolean {
  const path = relative(folder, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Installed dependencies need not be in project HEAD; actual agent/workspace source does. */
function installedDependency(folder: string, root: string, file: string): boolean {
  const agentPath = relative(folder, file).split(sep);
  const ownedSource = withinDirectory(folder, file) && !agentPath.includes("node_modules");
  return !ownedSource && relative(root, file).split(sep).includes("node_modules");
}

function canonical(path: string): string {
  try { return realpathSync(path); }
  // A bundled input may have been removed since compilation. Keep its resolved
  // spelling so the repository snapshot can still identify the deletion.
  catch { return resolve(path); }
}

const gitPath = (root: string, file: string) => relative(root, file).split(sep).join("/") || ".";
const containsPath = (folder: string, file: string) => folder === "." || file === folder || file.startsWith(`${folder}/`);

function changedInput(changed: ReadonlySet<string>, file: string): boolean {
  for (let path = file; path !== "."; path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".") {
    // Git can summarize nested repositories/submodules as one directory record.
    if (changed.has(path) || changed.has(`${path}/`)) return true;
  }
  return false;
}

function nulPaths(output: string | undefined): string[] | undefined {
  if (output === undefined || (output !== "" && !output.endsWith("\0"))) return undefined;
  return output === "" ? [] : output.slice(0, -1).split("\0");
}

function changedPaths(output: string | undefined): Set<string> | undefined {
  const entries = nulPaths(output);
  if (entries === undefined) return undefined;
  const paths = new Set<string>();
  for (const entry of entries) {
    // --no-renames represents renames as separate deletion/addition records, so
    // both sides participate in scope checks without a second filename record.
    if (entry.length < 4 || !/^[ MADTU?!]{2} /.test(entry)) return undefined;
    paths.add(entry.slice(3));
  }
  return paths;
}

type Snapshot = { changed: Set<string> | undefined; tracked: Set<string> | undefined };

/** Cache repository discovery for one deploy command, including all workspace agents. */
export class GitProvenance {
  private readonly roots = new Set<string>();
  private readonly directories = new Map<string, string | undefined>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly canonicalPaths = new Map<string, string>();
  private readonly superprojects = new Map<string, string | undefined>();
  private readonly traversedPaths = new TraversalInputs();
  private failed = false;

  get inspectionFailed(): boolean { return this.failed; }

  constructor(private readonly run: typeof git = git) {}

  private path(path: string): string {
    let normalized = this.canonicalPaths.get(path);
    if (normalized === undefined) { normalized = canonical(path); this.canonicalPaths.set(path, normalized); }
    return normalized;
  }

  private root(dir: string, discover = false): string | undefined {
    if (this.directories.has(dir)) return this.directories.get(dir);
    const known = [...this.roots].filter((root) => withinDirectory(root, dir)).sort((a, b) => b.length - a.length)[0];
    if (!discover && known !== undefined) {
      // Reuse the root only after checking for nested checkout/worktree markers.
      // Remember checked directories so adjacent inputs do not repeat the walk.
      const checked: string[] = [];
      let parent = dir;
      while (parent !== known && !this.directories.has(parent) && !existsSync(join(parent, ".git"))) {
        checked.push(parent); parent = dirname(parent);
      }
      if (parent === known || this.directories.get(parent) === known) {
        for (const directory of checked) this.directories.set(directory, known);
        return known;
      }
    }
    const found = this.run(dir, ["rev-parse", "--show-toplevel"]);
    const root = found === undefined ? undefined : this.path(found);
    this.directories.set(dir, root);
    if (root !== undefined) this.roots.add(root);
    return root;
  }

  hasRepository(folder: string): boolean {
    return this.root(this.path(folder), true) !== undefined;
  }

  private snapshot(root: string): Snapshot {
    let snapshot = this.snapshots.get(root);
    if (snapshot === undefined) {
      const changed = changedPaths(this.run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], false));
      const tracked = nulPaths(this.run(root, ["ls-files", "--cached", "-z"], false));
      snapshot = { changed, tracked: tracked === undefined ? undefined : new Set(tracked) };
      this.snapshots.set(root, snapshot);
    }
    return snapshot;
  }

  private superproject(root: string): string | undefined {
    if (!this.superprojects.has(root)) {
      const parent = this.run(root, ["rev-parse", "--show-superproject-working-tree"]);
      this.superprojects.set(root, parent ? this.path(parent) : parent);
    }
    return this.superprojects.get(root);
  }

  /** Positive evidence only. Native compiler probes/globs are not a complete read set. */
  dirty(folder: string, inputs: readonly string[], traversals: readonly string[] = [], searchPaths: readonly string[] = []): true | undefined {
    this.failed = false;
    const links = new Set([...traversals, ...[folder, ...inputs].flatMap((file) => this.traversedPaths.links(file))]);
    folder = this.path(folder);
    inputs = inputs.map((input) => this.path(input));
    // Each agent can itself be a nested checkout; always discover its own boundary.
    const ownRoot = this.root(folder, true);
    const groups = new Map<string, Set<string>>();
    const inputSet = new Set(inputs);
    let unknown = false;
    const include = (root: string, file: string) => {
      const files = groups.get(root) ?? new Set<string>();
      files.add(file); groups.set(root, files);
    };
    if (ownRoot !== undefined) include(ownRoot, folder);
    for (const input of inputs) {
      // Containment does not establish repository ownership: an input can cross
      // a nested .git directory or worktree file, even under ignored node_modules.
      const root = this.root(dirname(input));
      if (root === undefined) unknown = true;
      else include(root, input);
    }
    for (const link of links) {
      // The parent is canonical, but the final link entry must retain its own name.
      const root = this.root(dirname(link));
      if (root !== undefined) { include(root, link); inputSet.add(link); }
      else if ([...this.roots].some((known) => withinDirectory(known, link))) unknown = true;
      // Ambient aliases outside Git (e.g. macOS /var) have no project provenance.
    }
    for (const candidate of searchPaths) {
      // A removed file/directory has no realpath. Normalize through its nearest
      // existing parent, retaining the searched name for staged/unstaged deletions.
      let directory = dirname(candidate);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      const parent = this.path(directory);
      const file = resolve(parent, relative(directory, candidate));
      const root = this.root(parent);
      if (root !== undefined) include(root, file);
      else if ([...this.roots].some((known) => withinDirectory(known, file))) unknown = true;
      // Search candidates participate in status only: absent untracked files are clean.
    }
    for (const root of groups.keys()) {
      let child = root;
      const seen = new Set([child]);
      for (;;) {
        const parent = this.superproject(child);
        if (parent === undefined) { unknown = true; break; }
        if (parent === "") break;
        if (seen.has(parent) || !withinDirectory(parent, child)) { unknown = true; break; }
        // A child can be clean while its containing repository's gitlink moved.
        include(parent, child);
        seen.add(parent); child = parent;
      }
    }
    for (const [root, files] of groups) {
      const snapshot = this.snapshot(root);
      const ownedFolder = root === ownRoot ? gitPath(root, folder) : undefined;
      if (snapshot.changed === undefined) unknown = true;
      else {
        for (const file of files) if (changedInput(snapshot.changed, gitPath(root, file))) return true;
        if (ownedFolder !== undefined) for (const path of snapshot.changed) if (containsPath(ownedFolder, path)) return true;
      }
      // A clean status hides ignored inputs. With a clean index/worktree, tracked inputs
      // represent HEAD; require that membership for project sources, not installed packages.
      const projectInputs = [...files].filter((file) => inputSet.has(file) && !installedDependency(folder, root, file)).map((file) => gitPath(root, file));
      const tracked = snapshot.tracked;
      if (projectInputs.length && tracked === undefined) unknown = true;
      else if (tracked !== undefined && projectInputs.some((file) => !tracked.has(file))) return true;
    }
    this.failed = unknown;
    // Successful-input tracking cannot prove absence of relevant changes. In
    // particular, deleted probes and glob matches can vanish from the graph.
    return undefined;
  }
}
