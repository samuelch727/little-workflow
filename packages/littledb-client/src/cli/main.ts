import { commandHint } from "./messages.js";
export { CliError } from "./auth.js";
import { AsyncLocalStorage } from "node:async_hooks";
/**
 * littledb: deploy Little Harness agent folders to LittleDB, branch them, promote a
 * version to production, roll back, and hand websites a connection URL.
 */
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { git, GitProvenance } from "./git.js";
import { bundleAgent } from "../agents/bundle/index.js";
import { bundleWorkspace } from "../agents/bundle/workspace.js";
import { littleAgent } from "../agents/client/index.js";
import {
  parseAgentEmailSettings,
  parseAgentLimits,
  parseAgentRetention,
  parseWebhookCallbackHosts,
  type AgentEmailSettings,
  type AgentLimits,
  type AgentRetention,
  type EndUserDeletion,
  type EndUserExport,
  type EndUserPage,
  type ProjectSettings,
  type ScheduleSpec,
  type ScheduleStatus,
} from "../agents/protocol.js";

const help = () => `littledb: sign in, deploy agents and send runs to LittleDB
  login --url <LittleDB> [--project <slug>] [--key <management-key>]
  logout | whoami
  deploy [folder] [--all --branch <b>] [--dry-run] [--rotate-tracing-key]
  build [folder] [--out <file>]
  agents | status <agent> | versions <agent> | history <agent>
  promote <agent> <branch|vN> | rollback <agent> | production <agent> <branch>
  branch delete <agent> <branch> | url <agent> [--branch <b>]
  secrets set|list|rm (values from stdin) | users | origins | models
  chat <agent|url> [--branch <b>]
  schedules <agent> | schedules run|pause|resume <agent> <id>
  credits | limits <agent> | retention <agent> | webhooks <agent>
  email <agent> | user-secret <agent>
Use the scoped package name in full: ${commandHint("<command>")}.`;

type Flags = Record<string, string>;

const BOOLEAN_FLAGS = new Set([
  "all",
  "dry-run",
  "all-agents",
  "yes",
  "off",
  "rotate",
  "enable",
  "disable",
  "no-callbacks",
  "littledb",
  "credits",
  "own-key",
  "default",
  "now",
  "rotate-tracing-key",
]);

export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Flags;
} {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-m") {
      flags.message = argv[++i] ?? "";
    } else if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=", 2) as [
        string,
        string | undefined,
      ];
      if (value !== undefined) flags[key] = value;
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = "true";
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--"))
        flags[key] = argv[++i]!;
      else flags[key] = "true";
    } else positional.push(arg);
  }
  return { positional, flags };
}

import {
  CliError,
  boundControlKey,
  savedLogin,
  config as resolveConfig,
  savedConfig,
  login,
  logout,
  whoami,
  safeMessage,
  type ServiceConfig as Config,
} from "./auth.js";
const legacyMode = new AsyncLocalStorage<boolean>();
const config = (flags: Flags) =>
  resolveConfig(flags, legacyMode.getStore() === true);
async function api<T = any>(
  flags: Flags,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  return configuredApi<T>(
    await config(flags),
    method,
    path,
    body,
    extraHeaders,
  );
}

async function configuredApi<T = any>(
  { url, key, project }: Config,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${url}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      // A management key says which LittleDB project; a project key is its own project.
      ...(key.startsWith("ldbm_") && project !== undefined
        ? { "x-littledb-project": project }
        : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data =
    text === ""
      ? {}
      : (JSON.parse(text) as { error?: string | { message?: string } });
  if (!response.ok) {
    const message = safeMessage(
      typeof data.error === "object"
        ? data.error?.message
        : (data.error ?? text),
    );
    const scopeRefusal =
      response.status === 403 &&
      /\b(?:key|token)\b.*\bscopes?\b|\bscopes?\b.*\b(?:key|token)\b|\b(?:requires?|needs?|missing|insufficient)\b.*\b(?:read|deploy|manage)\b.*\bscope/i.test(
        message,
      );
    const hint = scopeRefusal
      ? ` Run ${commandHint("login", legacyMode.getStore() === true)} and ask an organization owner or admin to approve the required scope.`
      : "";
    throw new CliError(`${response.status}: ${message}${hint}`);
  }
  return data as T;
}

/**
 * LittleDB's own API, for what lives there (agent models). Its URL: --littledb-url,
 * LITTLEDB_URL, or the one the agents service names. Its key: a management key (the login's,
 * or LITTLEDB_MANAGEMENT_KEY, with the project) or LITTLEDB_API_KEY, the project's own key.
 */
async function littledbApi<T = any>(
  flags: Flags,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const saved = await savedConfig();
  let url =
    flags["littledb-url"] ||
    (legacyMode.getStore() === true ? undefined : flags.url) ||
    process.env.LITTLEDB_URL ||
    (legacyMode.getStore() === true ? undefined : (await savedLogin())?.url);
  if (url === undefined)
    url = await api<{ littledbUrl?: string }>(flags, "GET", "/me").then(
      (me) => me.littledbUrl,
      () => undefined,
    );
  if (url === undefined)
    throw new CliError(
      "Where is LittleDB? Set LITTLEDB_URL (or --littledb-url).",
    );
  const key = await boundControlKey(flags, url);
  if (key === undefined)
    throw new CliError(
      "This needs a LittleDB key: LITTLEDB_MANAGEMENT_KEY (with --project) or LITTLEDB_API_KEY.",
    );
  const project =
    flags.project ?? process.env.LITTLEDB_PROJECT ?? saved.project;
  if (key.startsWith("ldbm_") && project === undefined)
    throw new CliError(
      "A LittleDB management key needs the project: --project <slug>, or LITTLEDB_PROJECT.",
    );
  const response = await fetch(`${url.replace(/\/+$/, "")}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(key.startsWith("ldbm_") ? { "x-littledb-project": project! } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data =
    text === ""
      ? {}
      : (JSON.parse(text) as { error?: string | { message?: string } });
  if (!response.ok)
    throw new CliError(
      `LittleDB ${response.status}: ${safeMessage(typeof data.error === "object" ? data.error?.message : (data.error ?? text))}`,
    );
  return data as T;
}

/** `provider/model`, as LittleDB names a model. */
const isModelId = (value: string) => /^[a-z0-9][a-z0-9-]*\/\S+$/i.test(value);

/** A git branch as a LittleDB branch name: `feature/Case-2` becomes `feature-case-2`. */
function branchName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 63);
  return name === "" ? "main" : name;
}

const compatible = (line: string) =>
  line.replace(
    /\blittledb(?= (?:deploy|build|agents|status|versions|history|promote|rollback|production|branch|url|secrets|users|origins|models|chat|schedules|credits|webhooks|email|retention|limits|user-secret|help|login))/g,
    () => commandHint("", legacyMode.getStore() === true).trimEnd(),
  );
const out = (line = ""): void => {
  process.stdout.write(`${safeMessage(compatible(line))}\n`);
};

type CliDependencies = {
  git: typeof git;
  GitProvenance: new () => Pick<
    GitProvenance,
    "dirty" | "inspectionFailed" | "hasRepository"
  >;
};
export async function main(
  argv: string[],
  legacy = false,
  dependencies?: CliDependencies,
): Promise<void> {
  return legacyMode.run(legacy, async () => {
    try {
      await runMain(argv, legacy, dependencies);
    } catch (error) {
      if (error instanceof CliError) error.message = compatible(error.message);
      throw error;
    }
  });
}
async function runMain(
  argv: string[],
  legacy: boolean,
  dependencies?: CliDependencies,
): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...args] = positional;
  if (flags.help !== undefined) return out(help());
  if (
    !legacy &&
    command &&
    ![
      "help",
      "login",
      "logout",
      "whoami",
      "deploy",
      "build",
      "agents",
      "status",
      "versions",
      "history",
      "promote",
      "rollback",
      "production",
      "branch",
      "url",
      "secrets",
      "users",
      "origins",
      "models",
      "chat",
      "schedules",
      "credits",
      "limits",
      "retention",
      "webhooks",
      "email",
      "user-secret",
    ].includes(command)
  )
    throw new CliError(
      `Unknown command ${command}. Run littledb help; operator commands remain in littledb-agents.`,
    );
  switch (command) {
    case undefined:
    case "help":
      return out(help());

    case "login":
      return login(flags, out);
    case "logout":
      return logout(out);
    case "whoami":
      return whoami(out, flags);

    case "build": {
      const result = await bundleAgent(args[0] ?? ".", { name: flags.name });
      for (const warning of result.warnings) out(`warning: ${warning}`);
      if (flags.out !== undefined) await writeFile(flags.out, result.bundle);
      out(`${result.name}: ${(result.bundle.length / 1024).toFixed(1)} KiB`);
      out(
        `tools: ${result.manifest.tools.map((t) => `${t.name}${t.kind === "client" ? " (client)" : ""}`).join(", ") || "none"}`,
      );
      out(`skills: ${result.manifest.skills.join(", ") || "none"}`);
      return;
    }

    case "deploy": {
      const allowed = new Set([
        "url",
        "key",
        "project",
        "name",
        "branch",
        "message",
        "all",
        "dry-run",
        "rotate-tracing-key",
      ]);
      for (const flag of Object.keys(flags))
        if (!allowed.has(flag))
          throw new CliError(`Unknown deployment flag --${flag}.`);
      const all = flags.all === "true";
      if (flags.all !== undefined && !all)
        throw new CliError("--all takes no value.");
      if (flags["dry-run"] !== undefined && flags["dry-run"] !== "true")
        throw new CliError("--dry-run takes no value.");
      if (all && (!flags.branch || flags.branch === "true"))
        throw new CliError(
          "Workspace deployment requires --branch <branch>, for example --branch dev. Choose its target explicitly.",
        );
      if (all && flags.name !== undefined)
        throw new CliError(
          "--name cannot be used with --all; folder names identify agents.",
        );
      if (args.length > 1)
        throw new CliError(
          "Usage: littledb deploy [folder] [--all --branch <branch>] [--dry-run]",
        );
      const folder = resolve(args[0] ?? (all ? "agents" : "."));
      const activeGit = dependencies?.git ?? git;
      const gitBranch = activeGit(folder, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const branch = branchName(
        flags.branch ??
          (gitBranch !== undefined && gitBranch !== "HEAD"
            ? gitBranch
            : "main"),
      );
      const login =
        flags["dry-run"] === "true" ? undefined : await config(flags);
      const results = all
        ? await bundleWorkspace(folder)
        : [{ ...(await bundleAgent(folder, { name: flags.name })), folder }];
      out(
        `Deployment preview: ${results.length} agent(s) to branch ${branch}.`,
      );
      for (const result of results) {
        out(
          `  ${result.name}: ${(Buffer.byteLength(result.bundle) / 1024).toFixed(1)} KiB`,
        );
        for (const warning of result.warnings)
          out(`warning: ${result.name}: ${warning}`);
        const source = await readFile(
          join(result.folder, "agent.ts"),
          "utf8",
        ).catch(() => "");
        if (/\bdemoModel\b/.test(source) && /demo-model/.test(source))
          out(
            `warning: ${result.name}: replies are canned by the keyless demo model. Use setup --littledb for a model-free managed starter, or remove the explicit demo model to use the project model.`,
          );
      }
      if (login === undefined) return;
      const failures: string[] = [];
      const provenance = new (dependencies?.GitProvenance ?? GitProvenance)();
      let rotateTracingKey = flags["rotate-tracing-key"] === "true";
      let needsTracingRepair = false;
      for (const result of results) {
        const commit = activeGit(result.folder, ["rev-parse", "HEAD"]);
        const sourceBranch = activeGit(result.folder, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]);
        const dirty = provenance.dirty(
          result.folder,
          result.inputs,
          result.traversals,
          result.searchPaths,
        );
        if (
          dirty === undefined &&
          (!result.provenanceInspected || provenance.inspectionFailed) &&
          (commit !== undefined ||
            sourceBranch !== undefined ||
            provenance.hasRepository(result.folder))
        ) {
          out(
            `warning: ${result.name}: Git provenance is incomplete; git.dirty is omitted.`,
          );
        }
        try {
          const rotateThisDeployment = rotateTracingKey;
          rotateTracingKey = false;
          const deployed = await configuredApi(
            login,
            "POST",
            `/agents/${encodeURIComponent(result.name)}/deployments`,
            {
              branch,
              ...(rotateThisDeployment ? { rotateTracingKey: true } : {}),
              bundle: result.bundle,
              manifest: result.manifest,
              ...(flags.message === undefined
                ? {}
                : { message: flags.message }),
              git: {
                ...(commit === undefined ? {} : { commit }),
                ...(sourceBranch === undefined ? {} : { branch: sourceBranch }),
                ...(dirty === undefined ? {} : { dirty }),
              },
            },
          );
          const d = deployed.deployment;
          out(
            deployed.reused
              ? `${result.name} v${d.number} is already the latest on ${branch}; nothing changed.`
              : `Deployed ${result.name} v${d.number} to ${branch}.`,
          );
          out(`  ${branch} URL:      ${deployed.branch.url}`);
          out(
            `  production URL: ${deployed.productionUrl}${deployed.branch.production ? `  (${branch} is production)` : `  (serves ${deployed.agent.productionBranch}${deployed.agent.production ? ` v${deployed.agent.production.number}` : ", empty so far"})`}`,
          );
          if (deployed.reporting?.ok)
            out(
              `Runs report to ${login.organizationName ?? "your organization"} / ${login.projectName ?? login.project ?? "your project"}.`,
            );
          else if (deployed.reporting) {
            out(safeMessage(deployed.reporting.reason));
            if (
              ["key_exists", "partial_secrets"].includes(
                deployed.reporting.code,
              )
            ) {
              needsTracingRepair = true;
            }
          }
          out(`Next: littledb chat ${result.name} --branch ${branch}`);
          if (!deployed.branch.production)
            out(`  To ship it: littledb promote ${result.name} ${branch}`);
        } catch (error) {
          if (!all) throw error;
          failures.push(result.name);
          out(
            `Failed ${result.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (needsTracingRepair) {
        out("Repair (the old tracing key stops working):");
        out(
          `littledb deploy ${args[0] ?? (all ? "agents" : ".")} ${all ? "--all " : ""}--branch ${branch} --rotate-tracing-key`,
        );
      }
      if (failures.length)
        throw new CliError(
          `Workspace deployment incomplete: ${failures.join(", ")}. Successful uploads remain deployed; retry the command to reuse unchanged versions.`,
        );
      return;
    }

    case "agents": {
      const { agents } = await api<{ agents: any[] }>(flags, "GET", "/agents");
      if (agents.length === 0)
        return out("No agents yet. Deploy one: littledb deploy <folder>");
      for (const agent of agents)
        out(
          `${agent.name}  production: ${agent.productionBranch}${agent.production ? ` v${agent.production.number}` : " (empty)"}  ${agent.productionUrl}`,
        );
      return;
    }

    case "status": {
      const agent = (
        await api(flags, "GET", `/agents/${need(args[0], "status <agent>")}`)
      ).agent;
      out(`${agent.name}`);
      out(
        `  production: ${agent.productionBranch}${agent.production ? ` v${agent.production.number}` : " (empty)"}  ${agent.productionUrl}`,
      );
      out(
        `  users: ${agent.users}   origins: ${agent.allowedOrigins.join(", ")}`,
      );
      const productionDeployment = agent.deployments.find(
        (deployment: { id: string }) => deployment.id === agent.production?.id,
      );
      // The deployment list is capped at 100; a long-lived production version may be older.
      const schedules: readonly (string | ScheduleSpec | ScheduleStatus)[] =
        productionDeployment !== undefined
          ? productionDeployment.manifest.schedules
          : agent.production === null
            ? []
            : (
                await api<{ schedules: ScheduleStatus[] }>(
                  flags,
                  "GET",
                  `/agents/${encodeURIComponent(agent.name)}/schedules`,
                )
              ).schedules;
      out(`  schedules:${schedules.length === 0 ? " none on production" : ""}`);
      for (const schedule of schedules) {
        if (typeof schedule === "string")
          out(
            `    ${schedule}: unknown spec, not runnable. Redeploy the agent.`,
          );
        else if ("runnable" in schedule && !schedule.runnable)
          out(
            `    ${schedule.id}: unknown spec, not runnable. ${schedule.reason ?? "Redeploy the agent."}`,
          );
        else
          out(
            `    ${schedule.id}: ${schedule.cron} (${schedule.timezone}), session ${schedule.session}, catch-up ${schedule.catchUp ? "on" : "off"}`,
          );
      }
      out(`  branches:`);
      for (const b of agent.branches)
        out(
          `    ${b.production ? "*" : " "} ${b.name.padEnd(20)} v${String(b.deployment.number).padEnd(4)} ${b.url}`,
        );
      out(`  versions:`);
      for (const d of agent.deployments.slice(0, 10))
        out(
          `      v${String(d.number).padEnd(4)} ${d.branch.padEnd(20)} ${d.createdAt.slice(0, 16).replace("T", " ")}  ${d.message ?? ""}`,
        );
      return;
    }

    case "versions": {
      const agent = (
        await api(flags, "GET", `/agents/${need(args[0], "versions <agent>")}`)
      ).agent;
      for (const d of agent.deployments.filter(
        (d: any) => flags.branch === undefined || d.branch === flags.branch,
      )) {
        const serving = agent.branches
          .filter((b: any) => b.deployment.id === d.id)
          .map((b: any) => (b.production ? `${b.name}*` : b.name));
        out(
          `v${String(d.number).padEnd(4)} ${d.branch.padEnd(20)} ${d.createdAt.slice(0, 16).replace("T", " ")}  ${d.git?.commit?.slice(0, 7) ?? "       "}${d.git?.dirty ? "+" : " "} ${d.message ?? ""}${serving.length ? `  [serving: ${serving.join(", ")}]` : ""}`,
        );
      }
      return;
    }

    case "history": {
      const { history } = await api<{ history: any[] }>(
        flags,
        "GET",
        `/agents/${need(args[0], "history <agent>")}/history`,
      );
      for (const h of history) {
        out(
          `${h.at.slice(0, 16).replace("T", " ")}  ${h.action.padEnd(10)} ${h.branch.padEnd(20)} ${h.previous ? `v${h.previous.number} -> ` : ""}${h.deployment ? `v${h.deployment.number}` : ""} ${h.detail ?? ""}`,
        );
      }
      return;
    }

    case "promote": {
      const agent = need(
        args[0],
        "promote <agent> <branch|vN> [--to <branch>]",
      );
      const from = need(args[1], "promote <agent> <branch|vN> [--to <branch>]");
      const { branch, productionUrl } = await api(
        flags,
        "POST",
        `/agents/${agent}/promote`,
        { from, ...(flags.to === undefined ? {} : { to: flags.to }) },
      );
      return out(
        `${branch.name} now serves v${branch.deployment.number}.\n` +
          (branch.production
            ? `  production URL: ${productionUrl}`
            : `  ${branch.name} URL: ${branch.url}`),
      );
    }

    case "rollback": {
      const agent = need(args[0], "rollback <agent> [--branch <b>] [--to vN]");
      const { branch, productionUrl } = await api(
        flags,
        "POST",
        `/agents/${agent}/rollback`,
        {
          ...(flags.branch === undefined ? {} : { branch: flags.branch }),
          ...(flags.to === undefined ? {} : { to: flags.to }),
        },
      );
      return out(
        `${branch.name} is back on v${branch.deployment.number}${branch.production ? `, and the production URL serves it: ${productionUrl}` : "."}`,
      );
    }

    case "production": {
      const agent = need(args[0], "production <agent> <branch>");
      const result = await api(flags, "POST", `/agents/${agent}/production`, {
        branch: need(args[1], "production <agent> <branch>"),
      });
      return out(
        `${result.agent.productionBranch} is production now (v${result.agent.production?.number}). The production URL follows it.`,
      );
    }

    case "branch": {
      if (args[0] !== "delete")
        throw new CliError("Usage: littledb branch delete <agent> <branch>");
      await api(
        flags,
        "DELETE",
        `/agents/${need(args[1], "branch delete <agent> <branch>")}/branches/${need(args[2], "branch delete <agent> <branch>")}`,
      );
      return out(
        `Deleted ${args[2]}. Its URL stops working; its versions stay.`,
      );
    }

    case "url": {
      const agent = (
        await api(
          flags,
          "GET",
          `/agents/${need(args[0], "url <agent> [--branch <b>]")}`,
        )
      ).agent;
      if (flags.branch === undefined) return out(agent.productionUrl);
      const branch = agent.branches.find((b: any) => b.name === flags.branch);
      if (branch === undefined)
        throw new CliError(`${agent.name} has no branch ${flags.branch}.`);
      return out(branch.url);
    }

    case "secrets": {
      if (flags["all-agents"] === "true")
        return projectSecrets(args[0], args[1], flags);
      const [action, agent, name] = args;
      if (action === "list") {
        const { secrets } = await api<{ secrets: any[] }>(
          flags,
          "GET",
          `/agents/${need(agent, "secrets list <agent>")}/secrets`,
        );
        for (const s of secrets)
          out(
            `${s.name.padEnd(30)} ${s.branch ?? "all branches"}  ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
          );
        return;
      }
      const query =
        flags.branch === undefined
          ? ""
          : `?branch=${encodeURIComponent(flags.branch)}`;
      if (action === "set") {
        need(agent, "secrets set <agent> <NAME>");
        need(name, "secrets set <agent> <NAME>");
        const value = await readSecret(name!);
        await api(flags, "PUT", `/agents/${agent}/secrets/${name}${query}`, {
          value,
        });
        return out(
          `Set ${name} for ${agent}${flags.branch === undefined ? "" : ` on ${flags.branch}`}. The next message loads it.`,
        );
      }
      if (action === "rm") {
        const { deleted } = await api(
          flags,
          "DELETE",
          `/agents/${need(agent, "secrets rm <agent> <NAME>")}/secrets/${need(name, "secrets rm <agent> <NAME>")}${query}`,
        );
        return out(deleted ? `Removed ${name}.` : `${name} was not set.`);
      }
      throw new CliError("Usage: littledb secrets set|list|rm <agent> [NAME]");
    }

    case "schedules": {
      for (const flag of Object.keys(flags)) {
        if (flag === "branch")
          throw new CliError(
            "Schedules run on production only; --branch is not supported.",
          );
        if (!["url", "key", "project"].includes(flag))
          throw new CliError(`Unknown schedules flag --${flag}.`);
      }
      const [first, name, id] = args;
      if (first === "run" || first === "pause" || first === "resume") {
        const usage = `schedules ${first} <agent> <id>`;
        need(name, usage);
        need(id, usage);
        if (args.length !== 3) throw new CliError(`Usage: littledb ${usage}`);
        const path = `/agents/${encodeURIComponent(name!)}/schedules/${encodeURIComponent(id!)}/${first}`;
        if (first === "run") {
          const result = await api<{
            queued: boolean;
            chatId: string;
            reason?: string;
          }>(flags, "POST", path);
          return out(
            result.queued
              ? `Queued ${id} in chat ${result.chatId}.`
              : `${id} was not queued${result.reason === undefined ? "." : `: ${result.reason}`}`,
          );
        }
        const { schedule } = await api<{ schedule: ScheduleStatus }>(
          flags,
          "POST",
          path,
        );
        return out(
          first === "pause"
            ? `Paused ${id}.`
            : `Resumed ${id}; next run ${schedule.nextAt ?? "not scheduled"}.`,
        );
      }
      const agent = need(first, "schedules <agent>");
      if (args.length !== 1)
        throw new CliError(
          "Usage: littledb schedules <agent>, or schedules run|pause|resume <agent> <id>",
        );
      const { schedules } = await api<{ schedules: ScheduleStatus[] }>(
        flags,
        "GET",
        `/agents/${encodeURIComponent(agent)}/schedules`,
      );
      if (schedules.length === 0) return out("No schedules on production.");
      for (const schedule of schedules) {
        out(
          `${schedule.id}  ${schedule.runnable ? (schedule.paused ? "paused" : "active") : "not runnable"}`,
        );
        if (!schedule.runnable)
          out(
            `  ${schedule.reason ?? "Unknown schedule spec. Redeploy the agent."}`,
          );
        else
          out(
            `  ${schedule.cron} (${schedule.timezone}); session ${schedule.session}; catch-up ${schedule.catchUp ? "on" : "off"}`,
          );
        if (schedule.description !== undefined)
          out(`  ${schedule.description}`);
        out(
          `  next: ${schedule.nextAt ?? "-"}  last: ${schedule.lastRunAt ?? "-"}  result: ${schedule.lastResult ?? "-"}`,
        );
      }
      return;
    }

    case "users": {
      const action = args[0];
      const legacyMode =
        args.length === 2 && (args[1] === "anonymous" || args[1] === "signed");
      if (
        !legacyMode &&
        (action === "list" || action === "export" || action === "delete")
      ) {
        const usage = `users ${action} <agent>${action === "list" ? "" : " <user>"} [--branch <b>]${action === "delete" ? " --yes" : ""}`;
        const agent = need(args[1], usage);
        const user = action === "list" ? undefined : need(args[2], usage);
        if (args.length !== (action === "list" ? 2 : 3))
          throw new CliError(`Usage: littledb ${usage}`);
        const allowed = [
          "url",
          "key",
          "project",
          "branch",
          ...(action === "export"
            ? ["out", "files"]
            : action === "delete"
              ? ["yes"]
              : []),
        ];
        for (const flag of Object.keys(flags))
          if (!allowed.includes(flag))
            throw new CliError(`Unknown users ${action} flag --${flag}.`);
        if (
          flags.branch !== undefined &&
          !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(flags.branch)
        )
          throw new CliError("--branch must name a branch.");
        const scope =
          flags.branch === undefined ? "production" : `branch:${flags.branch}`;
        const query = new URLSearchParams({ scope });
        const path = `/agents/${encodeURIComponent(agent)}/users`;
        if (action === "list") {
          let cursor: string | null = null;
          let count = 0;
          const seen = new Set<string>();
          do {
            if (cursor !== null) query.set("cursor", cursor);
            const page = await api<EndUserPage>(
              flags,
              "GET",
              `${path}?${query}`,
            );
            for (const row of page.users) {
              out(
                `${row.user.padEnd(30)} ${row.lastSeen}  ${row.turns} turns  first ${row.firstSeen}`,
              );
              if (row.compute !== undefined)
                out(
                  `  compute, last 30 days: ${row.compute.vcpuSeconds.toFixed(3)} active vCPU-seconds, ${row.compute.browserSeconds.toFixed(3)} browser seconds, ${dollars(row.compute.costUsd)} list-price estimate (not charged)`,
                );
              count++;
            }
            cursor = page.cursor ?? null;
            if (cursor !== null && seen.has(cursor))
              throw new CliError(
                "The service returned a repeated users cursor.",
              );
            if (cursor !== null) seen.add(cursor);
          } while (cursor !== null);
          if (count === 0) out("No end users yet.");
          return;
        }
        if (action === "export") {
          if (flags.files !== undefined) {
            if (flags.files !== "0" && flags.files !== "1")
              throw new CliError("--files is 0 (chats only) or 1.");
            query.set("files", flags.files);
          }
          const data = await api<EndUserExport>(
            flags,
            "GET",
            `${path}/${encodeURIComponent(user!)}/export?${query}`,
          );
          const document = `${JSON.stringify(data, null, 2)}\n`;
          if (flags.out === undefined)
            return void process.stdout.write(document);
          const file = await open(flags.out, "w", 0o600);
          try {
            await file.chmod(0o600);
            await file.writeFile(document);
          } finally {
            await file.close();
          }
          return out(`Exported to ${flags.out}.`);
        }
        if (flags.yes !== "true")
          throw new CliError(
            "Deleting an end user requires --yes. Export their data first if you need a copy.",
          );
        const result = await api<EndUserDeletion>(
          flags,
          "DELETE",
          `${path}/${encodeURIComponent(user!)}?${query}`,
        );
        out(JSON.stringify(result, null, 2));
        if (!result.complete)
          throw new CliError(
            "Deletion is incomplete. The response names any retained data; retry this command to continue.",
          );
        return;
      }
      const mode = args[1];
      if (mode !== "anonymous" && mode !== "signed")
        throw new CliError("Usage: littledb users <agent> anonymous|signed");
      await api(
        flags,
        "PATCH",
        `/agents/${need(args[0], "users <agent> anonymous|signed")}/settings`,
        { users: mode },
      );
      return out(
        mode === "signed"
          ? "Only signed user tokens from your backend may connect now."
          : "Anonymous visitors may connect now.",
      );
    }

    case "webhooks": {
      const name = need(
        args[0],
        "webhooks <agent> [--callback-hosts <host,...>|--no-callbacks]",
      );
      if (args.length !== 1)
        throw new CliError(
          "Usage: littledb webhooks <agent> [--callback-hosts <host,...>|--no-callbacks]",
        );
      for (const flag of Object.keys(flags))
        if (
          !["url", "key", "project", "callback-hosts", "no-callbacks"].includes(
            flag,
          )
        )
          throw new CliError(`Unknown webhooks flag --${flag}.`);
      if (
        flags["callback-hosts"] !== undefined &&
        flags["no-callbacks"] !== undefined
      )
        throw new CliError("Choose --callback-hosts or --no-callbacks.");
      if (
        flags["no-callbacks"] !== undefined &&
        flags["no-callbacks"] !== "true"
      )
        throw new CliError(
          "Use --no-callbacks to remove every allowed callback host.",
        );
      const path = `/agents/${encodeURIComponent(name)}`;
      if (
        flags["callback-hosts"] !== undefined ||
        flags["no-callbacks"] === "true"
      ) {
        let hosts: readonly string[];
        try {
          hosts = parseWebhookCallbackHosts(
            flags["no-callbacks"] === "true"
              ? []
              : flags["callback-hosts"]!.split(","),
          );
        } catch (error) {
          throw new CliError(
            error instanceof Error ? error.message : String(error),
          );
        }
        await api(flags, "PATCH", `${path}/settings`, {
          webhookCallbackHosts: hosts,
        });
      }
      const [{ agent }, own, inherited] = await Promise.all([
        api<{
          agent: {
            productionUrl: string;
            productionBranch: string;
            webhookCallbackHosts: readonly string[];
          };
        }>(flags, "GET", path),
        api<{ secrets: { name: string; branch: string | null }[] }>(
          flags,
          "GET",
          `${path}/secrets`,
        ),
        api<{ secrets: { name: string }[] }>(flags, "GET", "/secrets"),
      ]);
      const configured =
        own.secrets.some(
          (secret) =>
            secret.name === "WEBHOOK_SECRET" &&
            (secret.branch === null ||
              secret.branch === agent.productionBranch),
        ) ||
        inherited.secrets.some((secret) => secret.name === "WEBHOOK_SECRET");
      out(
        `HTTP webhook: ${agent.productionUrl.replace(/\/+$/, "")}/webhooks/http`,
      );
      out(`WEBHOOK_SECRET: ${configured ? "set" : "not set"}`);
      return out(
        `Callback hosts: ${agent.webhookCallbackHosts.join(", ") || "none"}`,
      );
    }

    case "email": {
      const name = need(
        args[0],
        "email <agent> [--enable|--disable] [--allow <domain-or-address,...>]",
      );
      if (args.length !== 1)
        throw new CliError(
          "Usage: littledb email <agent> [--enable|--disable] [--allow <domain-or-address,...>]",
        );
      for (const flag of Object.keys(flags))
        if (
          !["url", "key", "project", "enable", "disable", "allow"].includes(
            flag,
          )
        )
          throw new CliError(`Unknown email flag --${flag}.`);
      if (flags.enable !== undefined && flags.disable !== undefined)
        throw new CliError("Choose --enable or --disable.");
      for (const flag of ["enable", "disable"])
        if (flags[flag] !== undefined && flags[flag] !== "true")
          throw new CliError(`Use --${flag} without a value.`);
      let email: Partial<AgentEmailSettings>;
      try {
        email = parseAgentEmailSettings({
          ...(flags.enable === "true"
            ? { enabled: true }
            : flags.disable === "true"
              ? { enabled: false }
              : {}),
          ...(flags.allow === undefined
            ? {}
            : {
                allowFrom:
                  flags.allow.trim() === "" ? [] : flags.allow.split(","),
              }),
        });
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const path = `/agents/${encodeURIComponent(name)}`;
      const { agent } =
        Object.keys(email).length === 0
          ? await api<{ agent: { email: AgentEmailSettings } }>(
              flags,
              "GET",
              path,
            )
          : await api<{ agent: { email: AgentEmailSettings } }>(
              flags,
              "PATCH",
              `${path}/settings`,
              { email },
            );
      out(`Email: ${agent.email.enabled ? "enabled" : "disabled"}`);
      return out(
        `Allowed senders: ${agent.email.allowFrom.join(", ") || "nobody"}`,
      );
    }

    case "retention": {
      const name = need(args[0], "retention <agent> [--idle-days <n>|--off]");
      if (args.length !== 1)
        throw new CliError(
          "Usage: littledb retention <agent> [--idle-days <n>|--off]",
        );
      for (const flag of Object.keys(flags))
        if (!["url", "key", "project", "idle-days", "off"].includes(flag))
          throw new CliError(`Unknown retention flag --${flag}.`);
      if (flags.off !== undefined && flags["idle-days"] !== undefined)
        throw new CliError("Choose --idle-days or --off.");
      if (flags.off !== undefined && flags.off !== "true")
        throw new CliError("Use --off to disable retention.");
      let retention: Partial<AgentRetention> | undefined;
      try {
        if (flags.off === "true")
          retention = parseAgentRetention({ idleDays: null });
        else if (flags["idle-days"] !== undefined)
          retention = parseAgentRetention({
            idleDays: Number(flags["idle-days"]),
          });
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const path = `/agents/${encodeURIComponent(name)}`;
      const { agent } =
        retention === undefined
          ? await api<{ agent: { retention: AgentRetention } }>(
              flags,
              "GET",
              path,
            )
          : await api<{ agent: { retention: AgentRetention } }>(
              flags,
              "PATCH",
              `${path}/settings`,
              { retention },
            );
      return out(
        agent.retention.idleDays === null
          ? "Retention is off."
          : `Delete end users idle for more than ${agent.retention.idleDays} days.`,
      );
    }

    case "origins": {
      const list = need(args[1], "origins <agent> <origin,...|*>")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      await api(
        flags,
        "PATCH",
        `/agents/${need(args[0], "origins <agent> <origins>")}/settings`,
        { allowedOrigins: list },
      );
      return out(`Browsers may connect from: ${list.join(", ")}`);
    }

    case "limits": {
      const name = need(
        args[0],
        "limits <agent> [--turns-per-user-per-minute <n>] ...",
      );
      if (args.length !== 1)
        throw new CliError(
          "Usage: littledb limits <agent> [--turns-per-user-per-minute <n>] ...",
        );
      const fields: Record<string, keyof AgentLimits> = {
        "turns-per-user-per-minute": "turnsPerUserPerMinute",
        "turns-per-user-per-day": "turnsPerUserPerDay",
        "new-users-per-address-per-hour": "newUsersPerAddressPerHour",
        "turns-per-connection-per-minute": "turnsPerConnectionPerMinute",
        "max-turn-seconds": "maxTurnSeconds",
        "max-steps": "maxSteps",
        "compute-seconds-per-user-per-day": "computeSecondsPerUserPerDay",
      };
      const values: Record<string, number> = {};
      for (const [flag, value] of Object.entries(flags)) {
        if (["url", "key", "project"].includes(flag)) continue;
        const field = fields[flag];
        if (field === undefined)
          throw new CliError(
            `Unknown limits flag --${flag}. See littledb help.`,
          );
        values[field] = Number(value);
      }
      let patch: Partial<AgentLimits>;
      try {
        patch = parseAgentLimits(values);
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const path = `/agents/${encodeURIComponent(name)}`;
      const { agent } =
        Object.keys(patch).length === 0
          ? await api<{ agent: { limits: AgentLimits } }>(flags, "GET", path)
          : await api<{ agent: { limits: AgentLimits } }>(
              flags,
              "PATCH",
              `${path}/settings`,
              { limits: patch },
            );
      for (const [field, value] of Object.entries(agent.limits))
        out(`${field.padEnd(30)} ${value}`);
      return;
    }

    case "user-secret": {
      const { secret } = await api(
        flags,
        flags.rotate === "true" ? "POST" : "GET",
        `/agents/${need(args[0], "user-secret <agent>")}/user-secret`,
      );
      return out(secret);
    }

    case "models":
      return models(args, flags);

    case "credits":
      return credits(args, flags);

    case "chat":
      return chat(args[0], flags);

    default:
      throw new CliError(`Unknown command ${command}. Run littledb help.`);
  }
}

async function chat(target: string | undefined, flags: Flags): Promise<void> {
  need(target, "chat <agent|url> [--branch <b>]");
  let url = target!;
  if (!/^https?:\/\//.test(url)) {
    const agent = (await api(flags, "GET", `/agents/${target}`)).agent;
    url =
      flags.branch === undefined
        ? agent.productionUrl
        : agent.branches.find((b: any) => b.name === flags.branch)?.url;
    if (url === undefined)
      throw new CliError(`${target} has no branch ${flags.branch}.`);
  }
  const agent = littleAgent(url, {
    user: `anon:terminal-${process.env.USER ?? "user"}-cli`,
  });
  const info = await agent.info();
  out(
    `${info.agent} on ${info.branch}${info.version ? ` v${info.version.number}` : ""}. Empty line to quit.`,
  );
  const session = agent.chat({
    id: flags.chat ?? `cli-${Date.now()}`,
    ...(flags.context === undefined
      ? {}
      : { context: JSON.parse(flags.context) as Record<string, unknown> }),
  });
  const send = async (line: string): Promise<void> => {
    await session.send(line);
    const last = session.messages[session.messages.length - 1];
    for (const part of (last?.parts ?? []) as {
      type: string;
      text?: string;
      toolCallId?: string;
      state?: string;
    }[]) {
      if (part.type === "text") out(part.text);
      else if (part.type.startsWith("tool-"))
        out(`  [${part.type.slice(5)}: ${part.state}]`);
    }
    if (session.error !== undefined) {
      if (!process.stdin.isTTY) throw new CliError(String(session.error));
      out(`error: ${session.error}`);
    }
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!process.stdin.isTTY) {
      for await (const line of rl) {
        if (line.trim() !== "") await send(line.trim());
      }
    } else {
      for (;;) {
        const line = (await rl.question("> ").catch(() => "")).trim();
        if (line === "") break;
        await send(line);
      }
    }
  } finally {
    rl.close();
  }
}

type ModelChoice = {
  id: string;
  paidBy: "key" | "credits";
  sweep: boolean;
  label: string;
  keyName: string;
  credits: boolean;
  price: { input: number; output: number } | null;
  default: boolean;
};

/** `models`: the list lives in LittleDB's settings; a production switch is a LittleDB version, a branch's is its secret. */
async function models(args: string[], flags: Flags): Promise<void> {
  const [action, id] = args;
  if (action === undefined || action === "list") {
    const list = await littledbApi<{
      default: string;
      models: ModelChoice[];
      agents: {
        slug: string;
        liveNumber: number | null;
        setting: string | null;
        model: { id: string; paidBy: string; source: string };
      }[];
    }>(flags, "GET", "/agent-models");
    out("Models agents may run:");
    for (const m of list.models) {
      const price =
        m.price === null
          ? "no price"
          : `$${m.price.input}/$${m.price.output} per M tokens in/out`;
      const payer =
        m.paidBy === "credits"
          ? "LittleDB credits (cost + 5%)"
          : `your key (${m.keyName || "its secret"})`;
      out(
        `  ${m.default ? "*" : " "} ${m.id.padEnd(28)} ${m.label.padEnd(22)} ${price.padEnd(34)} ${payer}`,
      );
    }
    if (list.agents.length > 0) out("Agents:");
    const from = {
      version: "its live version",
      agent: "its setting",
      project: "the project's default",
    } as Record<string, string>;
    for (const a of list.agents)
      out(
        `    ${a.slug.padEnd(28)} ${a.model.id.padEnd(28)} from ${from[a.model.source] ?? a.model.source}${a.liveNumber === null ? "" : ` (v${a.liveNumber})`}`,
      );
    return;
  }
  if (action === "add" || action === "rm") {
    const model = need(id, `models ${action} <provider/model>`).toLowerCase();
    if (!isModelId(model))
      throw new CliError(
        `Name the model as provider/model, such as deepseek/deepseek-flash.`,
      );
    const view = await littledbApi<{
      settings: { agentModels?: { default?: string } } | null;
      agentModels: { choices: ModelChoice[] };
    }>(flags, "GET", "/settings");
    const current = view.agentModels.choices.map(({ id, paidBy, sweep }) => ({
      id,
      paidBy,
      sweep,
    }));
    let next = current.filter((m) => m.id !== model);
    if (action === "add") {
      const was = current.find((m) => m.id === model);
      next = [
        ...next,
        {
          id: model,
          paidBy:
            flags.credits === "true"
              ? "credits"
              : flags["own-key"] === "true"
                ? "key"
                : (was?.paidBy ?? "key"),
          sweep: was?.sweep ?? true,
        },
      ];
    } else if (next.length === current.length) {
      return out(`${model} is not on the list.`);
    } else if (next.length === 0) {
      throw new CliError(
        "Agents need at least one model; add another before removing this one.",
      );
    }
    const stored = view.settings?.agentModels?.default;
    const defaultModel =
      flags.default === "true" && action === "add"
        ? model
        : stored === model
          ? undefined
          : stored;
    await littledbApi(flags, "PATCH", "/settings", {
      agentModels: {
        ...(defaultModel === undefined ? {} : { default: defaultModel }),
        models: next,
      },
    });
    if (action === "rm")
      return out(
        `Removed ${model}. Agents running it keep it until they switch.`,
      );
    const added = next[next.length - 1]!;
    return out(
      `${model} is on the list, paid with ${added.paidBy === "credits" ? "LittleDB credits" : "your own key"}${defaultModel === model ? ", and is the default" : ""}.`,
    );
  }
  if (action === "use") {
    const model = need(
      id,
      "models use <provider/model> --agent <a> [--now|--branch <b>]",
    ).toLowerCase();
    const agent = need(
      flags.agent,
      "models use <provider/model> --agent <a> [--now|--branch <b>]",
    );
    if (flags.branch !== undefined) {
      // One branch: its own secret, which wins over LittleDB's answer for that branch alone.
      const query = `?branch=${encodeURIComponent(flags.branch)}`;
      if (model === "default") {
        const { deleted } = await api(
          flags,
          "DELETE",
          `/agents/${encodeURIComponent(agent)}/secrets/LITTLEDB_MODEL${query}`,
        );
        return out(
          deleted
            ? `${flags.branch} runs LittleDB's model again.`
            : `${flags.branch} already runs LittleDB's model.`,
        );
      }
      if (!isModelId(model))
        throw new CliError(
          `Name the model as provider/model, such as deepseek/deepseek-flash, or local/<model>.`,
        );
      await api(
        flags,
        "PUT",
        `/agents/${encodeURIComponent(agent)}/secrets/LITTLEDB_MODEL${query}`,
        { value: model },
      );
      return out(
        `${agent} on ${flags.branch} runs ${model} from its next message, on your key. Production is unchanged.`,
      );
    }
    const harness = flags.harness ?? agent;
    const result = await littledbApi<{
      action: string;
      versionId: string | null;
      proposalId: string | null;
    }>(
      flags,
      "POST",
      `/subjects/harness:${encodeURIComponent(harness)}/model`,
      {
        model,
        ...(flags.now === "true" ? { now: true } : {}),
        ...(flags.message === undefined ? {} : { reason: flags.message }),
      },
    );
    if (result.action === "promoted")
      return out(
        `${agent} runs ${model} now (${result.versionId}). The release watch rolls it back if live scores fall.`,
      );
    if (result.action === "setting")
      return out(
        `${agent} has nothing live yet; its first version runs ${model}.`,
      );
    return out(
      `Proposed switching ${agent} to ${model} (${result.proposalId}). It is tested like any fix and ships when the gates pass; --now ships it at once.`,
    );
  }
  throw new CliError(
    "Usage: littledb models [add|rm|use] ...  (littledb help)",
  );
}

type CreditSummary = {
  account: string;
  balanceUsd: number;
  heldUsd: number;
  caps: {
    projectMonthUsd: number | null;
    userDayUsd: number | null;
    agentPerMinute: number | null;
  };
  autoTopUp: { belowUsd: number; amountUsd: number } | null;
  card: boolean;
  month: {
    projectId: string;
    chargeUsd: number;
    costUsd: number;
    calls: number;
  }[];
  compute?: {
    since: string;
    agents: {
      projectId: string;
      agent: string;
      turns: number;
      activeMs: number;
      vcpuSeconds: number;
      browserSeconds: number;
      costUsd: number;
      charged: false;
    }[];
  };
  ledger: {
    at: string;
    kind: string;
    agent: string | null;
    user: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    chargeUsd: number;
    note: string | null;
  }[];
};

const dollars = (x: number) =>
  Math.abs(x) >= 0.01 || x === 0 ? `$${x.toFixed(2)}` : `$${x.toFixed(6)}`;

/** `credits`: the account models on credits are billed to (the agents service's model gateway). */
async function credits(args: string[], flags: Flags): Promise<void> {
  const [action, value] = args;
  const show = (c: CreditSummary) => {
    out(
      `${c.account}: ${dollars(c.balanceUsd)} left${c.heldUsd > 0 ? ` (${dollars(c.heldUsd)} held by calls running now)` : ""}`,
    );
    const cap = (x: number | null, unit: string) =>
      x === null
        ? "none"
        : `${unit === "calls" ? x : dollars(x)}${unit === "calls" ? " calls" : ""}`;
    out(
      `  caps: ${cap(c.caps.userDayUsd, "usd")} per user a day, ${cap(c.caps.projectMonthUsd, "usd")} per project a month, ${cap(c.caps.agentPerMinute, "calls")} per agent a minute`,
    );
    out(
      `  auto top-up: ${c.autoTopUp === null ? "off" : `${dollars(c.autoTopUp.amountUsd)} when below ${dollars(c.autoTopUp.belowUsd)}`}${c.card ? "" : " (no card saved yet: buy once first)"}`,
    );
    for (const m of c.month)
      out(
        `  this month: ${m.calls} calls, ${dollars(m.chargeUsd)} (LittleDB's cost ${dollars(m.costUsd)})`,
      );
    out("  Compute (not charged), last 30 days:");
    if ((c.compute?.agents.length ?? 0) === 0) out("    No recorded compute.");
    for (const row of c.compute?.agents ?? [])
      out(
        `    ${row.agent}  ${row.turns} turns, ${row.vcpuSeconds.toFixed(3)} active vCPU-seconds, ${row.browserSeconds.toFixed(3)} browser seconds, ${dollars(row.costUsd)} list-price estimate`,
      );
    for (const row of c.ledger.slice(0, 15)) {
      out(
        `    ${row.at.slice(0, 16).replace("T", " ")}  ${row.kind.padEnd(7)} ${dollars(-row.chargeUsd).padStart(11)}  ${row.kind === "call" ? `${row.agent} ${row.model} ${row.inputTokens}/${row.outputTokens} tokens${row.user ? ` ${row.user}` : ""}` : (row.note ?? "")}`,
      );
    }
  };
  if (action === undefined)
    return show(
      (await api<{ credits: CreditSummary }>(flags, "GET", "/credits")).credits,
    );
  if (action === "compute") {
    if (
      args.length > 2 ||
      (value !== undefined && !["off", "record", "credits"].includes(value))
    )
      throw new CliError(
        "Usage: littledb credits compute [off|record|credits]",
      );
    for (const flag of Object.keys(flags))
      if (!["url", "key", "project"].includes(flag))
        throw new CliError(`Unknown compute recording flag --${flag}.`);
    const { settings } =
      value === undefined
        ? await api<{ settings: ProjectSettings }>(flags, "GET", "/settings")
        : await api<{ settings: ProjectSettings }>(
            flags,
            "PATCH",
            "/settings",
            { computeBilling: value },
          );
    return out(
      `Compute recording: ${settings.computeBilling}. Compute is not charged.`,
    );
  }
  if (action === "buy") {
    const { url } = await api<{ url: string }>(
      flags,
      "POST",
      "/credits/checkout",
      { amountUsd: Number(need(value, "credits buy <usd>")) },
    );
    return out(
      `Pay here: ${url}\nThe credit arrives once Stripe confirms the payment; the card is kept for auto top-up.`,
    );
  }
  if (action === "caps") {
    const num = (flag: string) =>
      flags[flag] === undefined
        ? undefined
        : flags[flag] === "off"
          ? null
          : Number(flags[flag]);
    const patch = Object.fromEntries(
      Object.entries({
        userDayUsd: num("user-day"),
        projectMonthUsd: num("project-month"),
        agentPerMinute: num("agent-minute"),
      }).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0)
      throw new CliError(
        "Usage: littledb credits caps [--user-day <usd>] [--project-month <usd>] [--agent-minute <n>]",
      );
    return show(
      (await api<{ credits: CreditSummary }>(flags, "PATCH", "/credits", patch))
        .credits,
    );
  }
  if (action === "auto") {
    const autoTopUp =
      value === "off"
        ? null
        : {
            belowUsd: Number(
              need(flags.below, "credits auto --below <usd> --amount <usd>"),
            ),
            amountUsd: Number(
              need(flags.amount, "credits auto --below <usd> --amount <usd>"),
            ),
          };
    return show(
      (
        await api<{ credits: CreditSummary }>(flags, "PATCH", "/credits", {
          autoTopUp,
        })
      ).credits,
    );
  }
  throw new CliError(
    "Usage: littledb credits [buy|caps|auto|compute] ...  (littledb help)",
  );
}

/** `secrets ... --all-agents`: the project's secrets, which every agent gets under its own. */
async function projectSecrets(
  action: string | undefined,
  name: string | undefined,
  flags: Flags,
): Promise<void> {
  if (action === "list") {
    const { secrets } = await api<{
      secrets: { name: string; updatedAt: string }[];
    }>(flags, "GET", "/secrets");
    for (const s of secrets)
      out(
        `${s.name.padEnd(30)} every agent  ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
      );
    return;
  }
  if (action === "set") {
    need(name, "secrets set <NAME> --all-agents");
    await api(flags, "PUT", `/secrets/${name}`, {
      value: await readSecret(name!),
    });
    return out(
      `Set ${name} for every agent in the project. An agent's own ${name} still wins.`,
    );
  }
  if (action === "rm") {
    const { deleted } = await api(
      flags,
      "DELETE",
      `/secrets/${need(name, "secrets rm <NAME> --all-agents")}`,
    );
    return out(deleted ? `Removed ${name}.` : `${name} was not set.`);
  }
  throw new CliError("Usage: littledb secrets set|list|rm [NAME] --all-agents");
}

async function readSecret(name: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }
  process.stdout.write(`${name} (input hidden): `);
  return new Promise((resolveValue) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", function onData(data: Buffer) {
      const char = data.toString("utf8");
      if (char === "\r" || char === "\n" || char === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolveValue(value);
      } else if (char === "\u0003") {
        process.exit(130);
      } else if (char === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    });
  });
}

function need(value: string | undefined, usage: string): string {
  if (value === undefined || value === "")
    throw new CliError(`Usage: littledb ${usage}`);
  return value;
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${safeMessage(error instanceof Error ? error.message : error)}\n`,
    );
    process.exit(1);
  });
}
