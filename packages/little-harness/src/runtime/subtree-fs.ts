import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import * as path from "node:path";

type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];
type ReadFileOption = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOption = Parameters<IFileSystem["writeFile"]>[2];

/**
 * One folder of a just-bash filesystem, seen as a filesystem of its own: `/` here is `root`
 * there. A workspace kept in one filesystem (`virtualHost`) mounts /session, /artifacts,
 * /persistent and /.agents this way, the same as a disk workspace mounts four directories.
 */
export class SubtreeFs implements IFileSystem {
  private readonly root: string;

  constructor(
    private readonly delegate: IFileSystem,
    root: string,
  ) {
    const normalized = path.posix.normalize(root.startsWith("/") ? root : `/${root}`);
    this.root = normalized === "/" ? "" : normalized.replace(/\/+$/u, "");
  }

  readFile(pathname: string, options?: ReadFileOption | BufferEncoding): Promise<string> {
    return this.delegate.readFile(this.inner(pathname), options);
  }

  readFileBuffer(pathname: string): Promise<Uint8Array> {
    return this.delegate.readFileBuffer(this.inner(pathname));
  }

  writeFile(pathname: string, content: FileContent, options?: WriteFileOption | BufferEncoding): Promise<void> {
    return this.delegate.writeFile(this.inner(pathname), content, options);
  }

  appendFile(pathname: string, content: FileContent, options?: WriteFileOption | BufferEncoding): Promise<void> {
    return this.delegate.appendFile(this.inner(pathname), content, options);
  }

  exists(pathname: string): Promise<boolean> {
    return this.delegate.exists(this.inner(pathname));
  }

  stat(pathname: string): Promise<FsStat> {
    return this.delegate.stat(this.inner(pathname));
  }

  lstat(pathname: string): Promise<FsStat> {
    return this.delegate.lstat(this.inner(pathname));
  }

  mkdir(pathname: string, options?: MkdirOptions): Promise<void> {
    return this.delegate.mkdir(this.inner(pathname), options);
  }

  readdir(pathname: string): Promise<string[]> {
    return this.delegate.readdir(this.inner(pathname));
  }

  async readdirWithFileTypes(pathname: string): Promise<DirentEntry[]> {
    const target = this.inner(pathname);
    if (this.delegate.readdirWithFileTypes) {
      return this.delegate.readdirWithFileTypes(target);
    }
    const entries: DirentEntry[] = [];
    for (const name of await this.delegate.readdir(target)) {
      const stat = await this.delegate.lstat(path.posix.join(target, name));
      entries.push({ name, isFile: stat.isFile, isDirectory: stat.isDirectory, isSymbolicLink: stat.isSymbolicLink });
    }
    return entries;
  }

  rm(pathname: string, options?: RmOptions): Promise<void> {
    return this.delegate.rm(this.inner(pathname), options);
  }

  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.delegate.cp(this.inner(src), this.inner(dest), options);
  }

  mv(src: string, dest: string): Promise<void> {
    return this.delegate.mv(this.inner(src), this.inner(dest));
  }

  resolvePath(base: string, pathname: string): string {
    return path.posix.resolve(base, pathname);
  }

  getAllPaths(): string[] {
    if (this.root === "") {
      return this.delegate.getAllPaths();
    }
    const prefix = `${this.root}/`;
    const paths: string[] = [];
    for (const candidate of this.delegate.getAllPaths()) {
      if (candidate === this.root) {
        paths.push("/");
      } else if (candidate.startsWith(prefix)) {
        paths.push(candidate.slice(this.root.length));
      }
    }
    return paths;
  }

  chmod(pathname: string, mode: number): Promise<void> {
    return this.delegate.chmod(this.inner(pathname), mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    // An absolute target names a path in this view, so it moves with the view; a relative
    // one resolves against the link's own folder either way.
    return this.delegate.symlink(target.startsWith("/") ? this.inner(target) : target, this.inner(linkPath));
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.delegate.link(this.inner(existingPath), this.inner(newPath));
  }

  async readlink(pathname: string): Promise<string> {
    const target = await this.delegate.readlink(this.inner(pathname));
    return target.startsWith("/") ? this.outer(target) : target;
  }

  async realpath(pathname: string): Promise<string> {
    return this.outer(await this.delegate.realpath(this.inner(pathname)));
  }

  utimes(pathname: string, atime: Date, mtime: Date): Promise<void> {
    return this.delegate.utimes(this.inner(pathname), atime, mtime);
  }

  /** This view's path as the delegate's path. Never climbs above the root. */
  private inner(pathname: string): string {
    const normalized = path.posix.normalize(`/${pathname}`);
    return normalized === "/" ? this.root || "/" : `${this.root}${normalized}`;
  }

  /** The delegate's path as this view's path; a path outside the root maps to the root. */
  private outer(pathname: string): string {
    if (this.root === "") {
      return pathname;
    }
    if (pathname === this.root) {
      return "/";
    }
    return pathname.startsWith(`${this.root}/`) ? pathname.slice(this.root.length) : "/";
  }
}
