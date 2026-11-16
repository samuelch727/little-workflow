import { commandHint } from "./messages.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
export type Flags = Record<string, string>;
type Named = { slug: string; name: string };
export type Login = {
  url: string;
  agentsUrl: string | null;
  key: string;
  organization?: Named;
  project?: Named;
  scopes?: string[];
};
export type ServiceConfig = {
  url: string;
  key: string;
  project?: string | undefined;
  organizationName?: string | undefined;
  projectName?: string | undefined;
};
export class CliError extends Error {
  constructor(message: string) {
    super(message.replace(/\blittledb login\b/g, commandHint("login")));
  }
}
const file = () => join(homedir(), ".config", "littledb", "config.json");
const pendingFile = () => join(dirname(file()), "login-pending.json");
const legacyFile = () => join(dirname(file()), "agents.json");
async function read<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export const savedLogin = () => read<Login>(file());
export async function savedConfig() {
  const s = await savedLogin();
  const old = await read<{ url?: string; key?: string; project?: string }>(
    legacyFile(),
  );
  return s ? { url: s.url, key: s.key, project: s.project?.slug } : (old ?? {});
}
function origin(value: string) {
  try {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw 0;
    return u.origin;
  } catch {
    throw new CliError(
      "Use a LittleDB http or https origin, without credentials or a path.",
    );
  }
}
export function safeMessage(value: unknown) {
  return String(value)
    .replace(
      /(?<![A-Za-z0-9_-])(?:ldbm_|ldbak_|ldb_)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
      "[redacted]",
    )
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
function explicitKey(flags: Flags) {
  return (
    flags.key ||
    process.env.LITTLEDB_MANAGEMENT_KEY ||
    process.env.LITTLEDB_AGENTS_KEY
  );
}
export function assertSavedDestination(savedUrl: string, targetUrl: string) {
  if (origin(savedUrl) !== origin(targetUrl))
    throw new CliError(
      `You are signed in to ${origin(savedUrl)}, not ${origin(targetUrl)}. Run littledb login --url ${origin(targetUrl)}.`,
    );
}
function assertSavedAgentsDestination(savedUrl: string, targetUrl: string) {
  if (origin(savedUrl) !== origin(targetUrl))
    throw new CliError(
      `LITTLEDB_AGENTS_URL (or --url in littledb-agents) names another agents service than the one signed in to: ${origin(targetUrl)} instead of ${origin(savedUrl)}. Use an explicit key with --key or LITTLEDB_MANAGEMENT_KEY to use it.`,
    );
}
type LegacyLogin = { url: string; key: string; project?: string };
async function legacyControlUrl(
  old: LegacyLogin,
  project = old.project,
): Promise<string | undefined> {
  // The saved service alone may designate the control plane for its saved key.
  // Never query an override with this credential or follow a redirect.
  const response = await fetch(origin(old.url) + "/v1/me", {
    redirect: "error",
    headers: {
      authorization: `Bearer ${old.key}`,
      ...(project ? { "x-littledb-project": project } : {}),
    },
  });
  if (!response.ok)
    throw new CliError(
      "Could not discover LittleDB from the saved agents service.",
    );
  const me = (await response.json()) as { littledbUrl?: string };
  return me.littledbUrl ? origin(me.littledbUrl) : undefined;
}
/** An agents key is never a control-plane credential. Saved keys stay origin-bound. */
export async function boundControlKey(
  flags: Flags,
  url: string,
): Promise<string | undefined> {
  const management = [
    flags.key,
    process.env.LITTLEDB_MANAGEMENT_KEY,
    process.env.LITTLEDB_AGENTS_KEY,
  ].find((key) => key?.startsWith("ldbm_"));
  if (management) return management;
  const projectKey = process.env.LITTLEDB_API_KEY;
  if (projectKey && !projectKey.startsWith("ldbak_")) return projectKey;
  if (flags.key || process.env.LITTLEDB_AGENTS_KEY) return undefined;
  const saved = await savedLogin();
  if (saved) {
    assertSavedDestination(saved.url, url);
    return saved.key.startsWith("ldbm_") ? saved.key : undefined;
  }
  const old = await read<LegacyLogin>(legacyFile());
  if (old?.key?.startsWith("ldbm_")) {
    const trustedUrl = await legacyControlUrl(
      old,
      flags.project || process.env.LITTLEDB_PROJECT || old.project,
    );
    if (!trustedUrl)
      throw new CliError(
        "The saved agents service did not name a LittleDB address.",
      );
    assertSavedDestination(trustedUrl, url);
    return old.key;
  }
  return undefined;
}
export async function config(
  flags: Flags,
  legacy = false,
): Promise<ServiceConfig> {
  const s = await savedLogin(),
    old = await read<{ url?: string; key?: string; project?: string }>(
      legacyFile(),
    );
  const url = flags.url || process.env.LITTLEDB_URL || s?.url;
  const chosen = explicitKey(flags);
  const key = chosen || s?.key || old?.key;
  const project =
    flags.project ||
    process.env.LITTLEDB_PROJECT ||
    s?.project?.slug ||
    old?.project;
  if (!key && legacy)
    throw new CliError(
      "Not logged in. Run littledb-agents login --url <service> --key <key>, or set LITTLEDB_AGENTS_URL and LITTLEDB_AGENTS_KEY.",
    );
  if (!key)
    throw new CliError(
      `Not signed in. Run littledb login${url ? ` --url ${origin(url)}` : " --url <LittleDB>"}. Ask an organization owner or admin to approve.`,
    );
  let agentsUrl = process.env.LITTLEDB_AGENTS_URL || undefined;
  if (legacy)
    agentsUrl = flags.url || agentsUrl || old?.url || s?.agentsUrl || undefined;
  if (!chosen) {
    if (s) {
      if (legacy && agentsUrl)
        assertSavedAgentsDestination(s.agentsUrl ?? s.url, agentsUrl);
      else if (url) assertSavedDestination(s.url, url);
      if (process.env.LITTLEDB_AGENTS_URL && s.agentsUrl)
        assertSavedAgentsDestination(
          s.agentsUrl,
          process.env.LITTLEDB_AGENTS_URL,
        );
      if (process.env.LITTLEDB_AGENTS_URL && !s.agentsUrl)
        throw new CliError(
          "Sign in to this agents service with an explicit key before overriding its address.",
        );
    } else if (old?.url) {
      if (agentsUrl) assertSavedAgentsDestination(old.url, agentsUrl);
      agentsUrl ??= old.url;
      if (url && !legacy && old.key) {
        const trustedUrl = await legacyControlUrl({
          url: old.url,
          key: old.key,
          ...(project ? { project } : {}),
        });
        if (!trustedUrl)
          throw new CliError(
            "The saved agents service did not name a LittleDB address.",
          );
        assertSavedDestination(trustedUrl, url);
      }
    }
  }
  if (!agentsUrl && url) {
    const base = origin(url);
    agentsUrl = s?.url === base ? (s.agentsUrl ?? undefined) : undefined;
    if (!agentsUrl) {
      const r = await fetch(base + "/api/cli/config");
      if (!r.ok)
        throw new CliError(
          "Could not read LittleDB configuration. Check the address and try login again.",
        );
      agentsUrl =
        ((await r.json()) as { agentsUrl: string | null }).agentsUrl ??
        undefined;
    }
  }
  if (!agentsUrl && !url) agentsUrl = old?.url;
  if (!agentsUrl && !url)
    throw new CliError(
      "No LittleDB address is known. Set LITTLEDB_URL, pass --url <LittleDB>, or run littledb login --url <LittleDB>.",
    );
  if (!agentsUrl)
    throw new CliError(
      "This LittleDB has no agents service; you can still send runs with the client library.",
    );
  if (key.startsWith("ldbm_") && !project)
    throw new CliError(
      legacy
        ? "A LittleDB management key needs the project: --project <slug>, or LITTLEDB_PROJECT."
        : "Choose a project with --project <slug> or LITTLEDB_PROJECT, then run login again.",
    );
  return {
    url: origin(agentsUrl),
    key,
    project,
    organizationName: s?.organization?.name,
    projectName: s?.project?.name,
  };
}
export async function login(
  flags: Flags,
  out: (s: string) => void,
  options: {
    sleep?: (ms: number) => Promise<void>;
    openBrowser?: (url: string) => void;
    device?: string;
  } = {},
) {
  const s = await savedLogin();
  const address = flags.url || process.env.LITTLEDB_URL || s?.url;
  if (!address)
    throw new CliError(
      "Usage: littledb login --url <LittleDB> [--project <slug>].",
    );
  const url = origin(address);
  const response = await fetch(url + "/api/cli/config");
  if (!response.ok)
    throw new CliError(
      "Could not read LittleDB configuration. Check --url and try login again.",
    );
  const server = (await response.json()) as { agentsUrl: string | null };
  if (flags.key) {
    if (!flags.key.startsWith("ldbm_"))
      throw new CliError(
        "Use a management key, or run login without --key for browser approval.",
      );
    const project = flags.project ?? process.env.LITTLEDB_PROJECT;
    if (!project) throw new CliError("Give --project <slug> when using --key.");
    const r = await fetch(
      url + "/api/org/key?project=" + encodeURIComponent(project),
      {
        headers: {
          authorization: `Bearer ${flags.key}`,
          "x-littledb-project": project,
        },
      },
    );
    if (!r.ok)
      throw new CliError(
        "The management key was refused. Ask an owner or admin for read and deploy access.",
      );
    const me = (await r.json()) as {
      organization: Named;
      project: Named;
      key: { scopes: string[] };
    };
    await save(file(), {
      url,
      agentsUrl: server.agentsUrl,
      key: flags.key,
      organization: me.organization,
      project: me.project,
      scopes: me.key.scopes,
    });
    out(`Signed in to ${me.organization.name} / ${me.project.name}.`);
    return;
  }
  type Pending = {
    url: string;
    project?: string;
    code: string;
    pollSecret: string;
    verifyUrl: string;
    interval: number;
  };
  let pending = await read<Pending>(pendingFile());
  if (!pending || pending.url !== url || pending.project !== flags.project) {
    const pollSecret = randomBytes(32).toString("base64url");
    const r = await fetch(url + "/api/cli/logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device:
          (options.device ?? hostname())
            .replace(
              /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
              "",
            )
            .trim()
            .slice(0, 80) || "Terminal",
        ...(flags.project ? { project: flags.project } : {}),
        pollSecretHash: createHash("sha256").update(pollSecret).digest("hex"),
      }),
    });
    if (!r.ok)
      throw new CliError(
        "Could not start terminal sign-in. Check the address and try again.",
      );
    const start = (await r.json()) as {
      code: string;
      verifyUrl: string;
      interval: number;
    };
    pending = {
      url,
      ...(flags.project ? { project: flags.project } : {}),
      pollSecret,
      ...start,
    };
    await save(pendingFile(), pending);
  }
  out(`Open ${pending.verifyUrl}\nCode: ${pending.code}`);
  if (options.openBrowser) options.openBrowser(pending.verifyUrl);
  else
    try {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "cmd"
            : "xdg-open";
      const child = spawn(
        command,
        process.platform === "win32"
          ? ["/c", "start", "", pending.verifyUrl]
          : [pending.verifyUrl],
        { stdio: "ignore" },
      );
      child.on("error", () => {});
      child.unref();
    } catch {}
  let seconds = pending.interval;
  let lastConflict: string | undefined;
  for (;;) {
    await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
      Math.max(0, seconds) * 1000,
    );
    let r: Response;
    try {
      r = await fetch(url + "/api/cli/logins/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: pending.code,
          pollSecret: pending.pollSecret,
        }),
      });
    } catch {
      throw new CliError(
        "Sign-in interrupted. Run the same login command to resume.",
      );
    }
    if (r.status === 429) {
      seconds = Number(r.headers.get("retry-after")) || pending.interval;
      continue;
    }
    seconds = pending.interval;
    const data = (await r.json()) as Record<string, any>;
    if (r.status === 409) {
      const message = safeMessage(
        data.error?.message ??
          data.error ??
          "Revoke an unused management key in Settings, then keep this terminal open.",
      )
        .split(pending.pollSecret)
        .join("[redacted]");
      if (message !== lastConflict) out(message);
      lastConflict = message;
      continue;
    }
    if (!r.ok)
      throw new CliError(
        "Sign-in could not continue. Run the same login command to resume.",
      );
    if (data.status === "pending") continue;
    if (data.status === "approved") {
      await save(file(), {
        url,
        agentsUrl: data.agentsUrl ?? null,
        key: data.key,
        organization: data.organization,
        project: data.project,
        scopes: ["read", "deploy"],
      });
      await rm(pendingFile(), { force: true });
      out(`Signed in to ${data.organization.name} / ${data.project.name}.`);
      return;
    }
    if (data.status === "denied" || data.status === "expired") {
      await rm(pendingFile(), { force: true });
      throw new CliError(
        `Sign-in ${data.status}. Run littledb login --url ${url} to start again.`,
      );
    }
    throw new CliError(
      "Unexpected sign-in response. Run the same login command to resume.",
    );
  }
}
export async function logout(out: (s: string) => void) {
  const s = await savedLogin();
  const removed: string[] = [];
  for (const [path, name] of [
    [file(), "config.json"],
    [legacyFile(), "legacy agents.json"],
    [pendingFile(), "login-pending.json"],
  ] as const) {
    try {
      await unlink(path);
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  out(
    `Signed out on this machine. ${removed.length ? `Removed ${removed.join(", ")}.` : "No saved sign-in files were present."} This does not revoke the key${s?.url ? ` at ${s.url}` : ""}.`,
  );
}
export async function whoami(out: (s: string) => void, flags: Flags = {}) {
  const saved = await savedLogin();
  const url = flags.url ?? process.env.LITTLEDB_URL ?? saved?.url;
  const key = flags.key || process.env.LITTLEDB_MANAGEMENT_KEY || saved?.key;
  if (saved && !flags.key && !process.env.LITTLEDB_MANAGEMENT_KEY && url)
    assertSavedDestination(saved.url, url);
  const project =
    flags.project ?? process.env.LITTLEDB_PROJECT ?? saved?.project?.slug;
  if (!saved && (!url || !key || !project))
    throw new CliError("Not signed in. Run littledb login --url <LittleDB>.");
  if (
    url &&
    key &&
    project &&
    (flags.url || flags.key || process.env.LITTLEDB_MANAGEMENT_KEY)
  ) {
    const response = await fetch(
      origin(url) + "/api/org/key?project=" + encodeURIComponent(project),
      { headers: { authorization: `Bearer ${key}` } },
    );
    if (!response.ok)
      throw new CliError(
        "The management key was refused. Run login and ask an owner or admin to approve.",
      );
    const me = (await response.json()) as {
      organization: Named;
      project: Named;
      key: { scopes: string[] };
    };
    out(
      `${origin(url)}\n${me.organization.name} / ${me.project.name}\nScopes: ${me.key.scopes.join(", ")}`,
    );
    return;
  }
  out(
    `${saved!.url}\n${saved!.organization?.name ?? "Organization"} / ${saved!.project?.name ?? "Project"}\nScopes: ${saved!.scopes?.join(", ") ?? "check Settings"}`,
  );
}
