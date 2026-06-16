import { HarnessInputError } from "../errors.js";

export type RemoteSkillProvider = "github" | "gitlab" | "git";

export type ParsedRemoteSkillSource = {
  readonly original: string;
  readonly cloneUrl: string;
  readonly provider: RemoteSkillProvider;
  readonly host?: string;
  readonly ownerRepo?: string;
  readonly ref?: string;
  readonly subpath?: string;
};

export function parseRemoteSkillSource(input: string): ParsedRemoteSkillSource {
  const { source, ref: fragmentRef } = splitFragmentRef(input);

  if (isShorthandSource(source)) {
    throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: input });
  }
  if (containsTraversalSegment(source)) {
    throw new HarnessInputError("Remote skill URL contains path traversal.", { source: input });
  }

  const scp = /^([^@\s]+)@([^:\s]+):(.+)$/u.exec(source);
  if (scp !== null) {
    const host = scp[2]!;
    const path = scp[3] ?? "";
    if (path.includes("?") || fragmentRef !== undefined) {
      throw new HarnessInputError("SCP-style remote skill URLs must not include query parameters or fragments.", {
        host,
      });
    }
    if (!path.includes("/")) {
      throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: input });
    }
    return withOptionalRef({
      original: input,
      cloneUrl: source,
      provider: "git",
      host,
    }, fragmentRef);
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: input });
  }

  if (url.password.length > 0 || (url.protocol !== "ssh:" && url.username.length > 0)) {
    throw new HarnessInputError("Remote skill URLs must not include credentials.", {
      host: url.hostname,
    });
  }
  if (url.search.length > 0) {
    throw new HarnessInputError("Remote skill URLs must not include query parameters.", {
      host: url.hostname,
    });
  }

  if (url.protocol === "https:") {
    return parseHttpRemoteSkillSource(input, url, fragmentRef);
  }

  if (url.protocol === "ssh:" || url.protocol === "file:") {
    return withOptionalRef({
      original: input,
      cloneUrl: source,
      provider: "git",
      ...(url.hostname.length > 0 ? { host: url.hostname } : {}),
    }, fragmentRef);
  }

  throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: input });
}

function parseHttpRemoteSkillSource(
  original: string,
  url: URL,
  fragmentRef: string | undefined,
): ParsedRemoteSkillSource {
  const rawSegments = rawPathSegments(url);
  const segments = pathSegments(url);

  if (url.hostname === "github.com") {
    assertNoEncodedProviderDelimiters(url, rawSegments);
    const [owner, repoWithSuffix, maybeTree, treeRef, ...rest] = segments;
    if (owner !== undefined && repoWithSuffix !== undefined) {
      const repo = stripGitSuffix(repoWithSuffix);
      const base = {
        original,
        cloneUrl: `${url.protocol}//${url.host}/${owner}/${repo}.git`,
        provider: "github" as const,
        host: url.host,
        ownerRepo: `${owner}/${repo}`,
      };
      if (maybeTree === "tree" && treeRef !== undefined) {
        return withOptionalSubpath(withRef(base, treeRef, fragmentRef), rest.join("/"));
      }
      if (maybeTree === undefined) {
        return withOptionalRef(base, fragmentRef);
      }
    }
    throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: original });
  }

  const gitlabTreeIndex = segments.indexOf("-");
  if (gitlabTreeIndex > 0 && segments[gitlabTreeIndex + 1] === "tree") {
    assertNoEncodedProviderDelimiters(url, rawSegments);
    const repoPath = segments.slice(0, gitlabTreeIndex).join("/");
    const treeRef = segments[gitlabTreeIndex + 2];
    const subpath = segments.slice(gitlabTreeIndex + 3).join("/");
    if (treeRef !== undefined && repoPath.includes("/")) {
      return withOptionalSubpath(
        withRef({
          original,
          cloneUrl: `${url.protocol}//${url.host}/${stripGitSuffix(repoPath)}.git`,
          provider: "gitlab",
          host: url.host,
          ownerRepo: stripGitSuffix(repoPath),
        }, treeRef, fragmentRef),
        subpath,
      );
    }
  }

  if (url.hostname === "gitlab.com" && segments.length >= 2) {
    assertNoEncodedProviderDelimiters(url, rawSegments);
    const repoPath = stripGitSuffix(segments.join("/"));
    return withOptionalRef({
      original,
      cloneUrl: `${url.protocol}//${url.host}/${repoPath}.git`,
      provider: "gitlab",
      host: url.host,
      ownerRepo: repoPath,
    }, fragmentRef);
  }

  if (!looksLikeGenericGitUrl(url, segments)) {
    throw new HarnessInputError("Remote skills require an explicit Git URL.", { source: original });
  }

  return withOptionalRef({
    original,
    cloneUrl: url.toString(),
    provider: "git",
    host: url.host,
  }, fragmentRef);
}

function rawPathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
}

function splitFragmentRef(input: string): { readonly source: string; readonly ref?: string } {
  const index = input.indexOf("#");
  if (index === -1) {
    return { source: input };
  }
  const source = input.slice(0, index);
  const raw = input.slice(index + 1);
  if (raw.length === 0) {
    return { source };
  }
  try {
    return { source, ref: decodeURIComponent(raw) };
  } catch {
    return { source, ref: raw };
  }
}

function isShorthandSource(source: string): boolean {
  return (
    source.startsWith("github:") ||
    source.startsWith("gitlab:") ||
    (!source.includes("://") && !/^([^@\s]+)@([^:\s]+):(.+)$/u.test(source))
  );
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .map((segment) => decodePathSegment(segment))
    .filter((segment) => segment.length > 0);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assertNoEncodedProviderDelimiters(url: URL, rawSegments: readonly string[]): void {
  if (rawSegments.some((segment) => /%(?:2f|3f|23|5c)/iu.test(segment))) {
    throw new HarnessInputError("Remote skill provider path segments must not contain encoded delimiters.", {
      host: url.host,
    });
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, "");
}

function withRef<T extends Omit<ParsedRemoteSkillSource, "ref" | "subpath">>(
  source: T,
  treeRef: string,
  fragmentRef: string | undefined,
): ParsedRemoteSkillSource {
  return {
    ...source,
    ref: fragmentRef ?? treeRef,
  };
}

function withOptionalRef<T extends Omit<ParsedRemoteSkillSource, "ref" | "subpath">>(
  source: T,
  ref: string | undefined,
): ParsedRemoteSkillSource {
  return ref === undefined ? source : { ...source, ref };
}

function withOptionalSubpath(
  source: ParsedRemoteSkillSource,
  subpath: string,
): ParsedRemoteSkillSource {
  if (subpath.length === 0) {
    return source;
  }
  return {
    ...source,
    subpath: sanitizeSubpath(subpath),
  };
}

function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/gu, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new HarnessInputError("Remote skill URL contains path traversal.", { subpath });
    }
  }
  return normalized;
}

function containsTraversalSegment(source: string): boolean {
  const decoded = decodePathSegment(source).replace(/\\/gu, "/");
  return decoded.split(/[/?#]/u).includes("..");
}

function looksLikeGenericGitUrl(url: URL, segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  if (segments.length >= 2) {
    return true;
  }
  return segments[0]?.endsWith(".git") === true;
}
