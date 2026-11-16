/**
 * The wire shapes shared by the service Worker, the runtime inside each deployment and the
 * browser client. Kept free of imports so every side can use it.
 */

/** A JSON Schema object, as tools carry it over the wire. */
export type JsonSchema = { readonly [key: string]: unknown };

/** Bounds on an agent's public connection URLs, effective for every branch. */
export type AgentLimits = {
  readonly turnsPerUserPerMinute: number;
  readonly turnsPerUserPerDay: number;
  readonly newUsersPerAddressPerHour: number;
  readonly turnsPerConnectionPerMinute: number;
  readonly maxTurnSeconds: number;
  readonly maxSteps: number;
  /** Active container vCPU-seconds each UTC day; zero keeps the user on the folder tier. */
  readonly computeSecondsPerUserPerDay: number;
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  turnsPerUserPerMinute: 10,
  turnsPerUserPerDay: 300,
  newUsersPerAddressPerHour: 20,
  turnsPerConnectionPerMinute: 120,
  maxTurnSeconds: 300,
  maxSteps: 25,
  computeSecondsPerUserPerDay: 1_800,
});

/** Old agents with no saved limits, and unspecified fields, use the service defaults. */
export function effectiveAgentLimits(limits?: Partial<AgentLimits> | null): AgentLimits {
  return { ...DEFAULT_AGENT_LIMITS, ...limits };
}

/** A settings patch: reject misspellings and invalid counts or compute allowances. */
export function parseAgentLimits(value: unknown): Partial<AgentLimits> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("limits must be an object.");
  const patch: Record<string, number> = {};
  for (const [key, number] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_AGENT_LIMITS, key)) throw new Error(`Unknown limits field ${JSON.stringify(key)}.`);
    if (key === "computeSecondsPerUserPerDay") {
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
        throw new Error("limits.computeSecondsPerUserPerDay must be a finite number from 0 to 9007199254740991.");
      }
      patch[key] = number;
      continue;
    }
    const maximum = key === "maxTurnSeconds" ? 900 : key === "maxSteps" ? 100 : Number.MAX_SAFE_INTEGER;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new Error(`limits.${key} must be an integer from 1 to ${maximum}.`);
    }
    patch[key] = number;
  }
  return patch;
}

export type AgentLimitErrorCode = "rate_limited" | "connection_busy" | "too_many_new_users";

/** Every HTTP 429 from connection admission has this shape and a matching Retry-After header. */
export type AgentLimitError = {
  readonly error: string;
  readonly code: AgentLimitErrorCode;
  readonly retryAfterSeconds: number;
};

/** Compute is recorded by default. Charging is reserved and is refused by the service. */
export type ComputeBilling = "off" | "record" | "credits";
export type ProjectSettings = { readonly computeBilling: ComputeBilling };

/** The last 30 days of one user's managed compute, within the selected agent and scope. */
export type EndUserCompute = {
  readonly turns: number;
  readonly activeMs: number;
  readonly vcpuSeconds: number;
  readonly browserSeconds: number;
  readonly costUsd: number;
  readonly charged: false;
};

/** Automatic removal of idle end users is off until a developer enables it. */
export type AgentRetention = { readonly idleDays: number | null };

export function effectiveAgentRetention(retention?: Partial<AgentRetention> | null): AgentRetention {
  return { idleDays: retention?.idleDays ?? null };
}

export function parseAgentRetention(value: unknown): Partial<AgentRetention> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("retention must be an object.");
  for (const key of Object.keys(value)) {
    if (key !== "idleDays") throw new Error(`Unknown retention field ${JSON.stringify(key)}.`);
  }
  if (!Object.hasOwn(value, "idleDays")) return {};
  const idleDays = (value as Record<string, unknown>).idleDays;
  if (idleDays !== null && (typeof idleDays !== "number" || !Number.isSafeInteger(idleDays) || idleDays < 7)) {
    throw new Error("retention.idleDays must be null or an integer of at least 7.");
  }
  return { idleDays: idleDays as number | null };
}

/** Inbound email is opt-in; an empty sender list admits nobody. */
export type AgentEmailSettings = { readonly enabled: boolean; readonly allowFrom: readonly string[] };

export function effectiveAgentEmailSettings(email?: Partial<AgentEmailSettings> | null): AgentEmailSettings {
  return { enabled: email?.enabled ?? false, allowFrom: [...(email?.allowFrom ?? [])] };
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function dnsName(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => DNS_LABEL.test(label));
}

/** Exact URL hosts, with optional ports. Schemes, wildcards and alternate IP spellings fail. */
export function parseWebhookCallbackHosts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("webhookCallbackHosts must be a list of at most 100 exact hosts.");
  const hosts = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("webhookCallbackHosts entries must be host names, without a URL or wildcard.");
    const host = entry.trim().toLowerCase();
    const parts = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(host);
    if (parts === null || parts[2] !== undefined && Number(parts[2]) > 65535) throw new Error(`Invalid callback host ${JSON.stringify(entry)}; use a host or host:port, without a URL or wildcard.`);
    let url: URL;
    try { url = new URL(`https://${host}`); }
    catch { throw new Error(`Invalid callback host ${JSON.stringify(entry)}.`); }
    if (url.hostname !== parts[1] || !parts[1]!.startsWith("[") && !dnsName(parts[1]!)) throw new Error(`Callback host ${JSON.stringify(entry)} is not a canonical DNS name or IP address.`);
    return url.host;
  });
  return [...new Set(hosts)];
}

/** Canonical exact domains or ordinary mailbox addresses; a domain does not include subdomains. */
export function parseEmailAllowFrom(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("email.allowFrom must be a list of at most 100 exact domains or addresses.");
  const entries = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("email.allowFrom entries must be exact domains or addresses.");
    const text = entry.trim().toLowerCase();
    const [local, domain, extra] = text.split("@");
    const validDomain = (name: string) => dnsName(name) && name.includes(".") && !/^\d+(?:\.\d+)*$/.test(name);
    const valid = domain === undefined
      ? validDomain(text)
      : extra === undefined && local!.length > 0 && local!.length <= 64 && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local!) && validDomain(domain) && text.length <= 254;
    if (!valid) throw new Error(`Invalid email sender rule ${JSON.stringify(entry)}; use an exact domain or address, without wildcards.`);
    return text;
  });
  return [...new Set(entries)];
}

export function parseAgentEmailSettings(value: unknown): Partial<AgentEmailSettings> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("email must be an object.");
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (key !== "enabled" && key !== "allowFrom") throw new Error(`Unknown email field ${JSON.stringify(key)}.`);
  if (Object.hasOwn(fields, "enabled") && typeof fields.enabled !== "boolean") throw new Error("email.enabled must be true or false.");
  return {
    ...(Object.hasOwn(fields, "enabled") ? { enabled: fields.enabled as boolean } : {}),
    ...(Object.hasOwn(fields, "allowFrom") ? { allowFrom: parseEmailAllowFrom(fields.allowFrom) } : {}),
  };
}

/** Shared by activity reports and management routes; preserves the registry's existing bound. */
export const MAX_END_USER_ID_LENGTH = 512;

export type EndUserSummary = {
  readonly scope: string;
  readonly user: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly turns: number;
  readonly compute?: EndUserCompute;
};

export type EndUserPage = { readonly users: readonly EndUserSummary[]; readonly cursor: string | null };

export type EndUserExport = {
  readonly agent: string;
  readonly scope: string;
  readonly user: string;
  readonly exportedAt: string;
  readonly chats: readonly { readonly id: string; readonly title: string; readonly createdAt: string; readonly messages: readonly WireUIMessage[] }[];
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly contentBase64: string }[];
};

/** False means a part was absent or could not be removed; errors explain retained data. */
export type EndUserDeletion = {
  readonly complete: boolean;
  readonly deleted: {
    readonly host: boolean;
    readonly machine: boolean;
    readonly snapshot: boolean;
    readonly traces: number | null;
    readonly memory: boolean | null;
  };
  readonly errors?: Readonly<Record<string, string>>;
  /** Present only when the delete token named an operation (`op`). */
  readonly operation?: EndUserDeletionOperation;
};

/**
 * What the receiver bound a delete token's `op` to, echoed in its receipt. Times are the
 * receiver's own clock.
 */
export type EndUserDeletionOperation = {
  readonly op: string;
  readonly agent: string;
  readonly scope: string;
  readonly user: string;
  /** One host lifetime's deletion. Takeovers keep it; the next lifetime gets a new one. */
  readonly deletionId: string;
  /** The deletion owner's number for this receipt. It rises on every takeover. */
  readonly generation: number;
  /** When the receiver first accepted this operation. */
  readonly acceptedAt: string;
  /** When this agent stopped accepting delete tokens without an operation, if it has. */
  readonly legacyDeleteTokensClosedAt: string | null;
};

/**
 * A delete-token request the receiver turned away before it started anything, so it had no
 * effect. Sent with 409.
 */
export type EndUserDeletionRefusal = {
  readonly refused: "busy" | "legacy_delete_tokens_closed" | "operation_target_mismatch" | "operation_lifetime_ended";
  readonly message: string;
  readonly operation?: { readonly op: string };
};

/** What `littledb-agents deploy` uploads beside the code. */
export type AgentManifest = {
  readonly format: 1;
  /** The agent's tools, as the model sees them. `client` tools run in the website. */
  readonly tools: readonly ManifestTool[];
  readonly skills: readonly string[];
  /** Older deployments list ids only; they remain readable but cannot run until redeployed. */
  readonly schedules: readonly (string | ScheduleSpec)[];
  readonly workflows: readonly string[];
  /** True when the folder has an `instructions.md`. */
  readonly instructions: boolean;
  /** True when `agent.ts` exports `managed`: settings LittleDB versions and improves. */
  readonly managed?: boolean | undefined;
  /** `agent.ts`'s `sandbox` export: commands just-bash cannot run go to a container this size. */
  readonly sandbox?: SandboxSpec | undefined;
  /** The SDK versions the folder was built against. */
  readonly sdk: { readonly harness?: string | undefined; readonly ai?: string | undefined };
  /** Every source file and its hash, so a version says exactly what went in. */
  readonly files: Readonly<Record<string, string>>;
};

/** Timer metadata is public to the service; the prompt and input stay in the agent's bundle. */
export type ScheduleSpec = {
  readonly id: string;
  readonly cron: string;
  readonly timezone: string;
  readonly session: string;
  readonly catchUp: boolean;
  readonly kind: "prompt" | "type";
  readonly description?: string | undefined;
};

/**
 * Container sizes on Cloudflare an agent can ask for, smallest first: `basic` is 1/4 vCPU, 1 GiB
 * and 4 GB of disk, `standard-4` 4 vCPU and 12 GiB. `lite` is not offered: its 2 GB of disk
 * cannot hold the sandbox image (sandbox/Dockerfile, 1.2 GB).
 */
export const SANDBOX_INSTANCE_TYPES = ["basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
export type SandboxInstanceType = (typeof SANDBOX_INSTANCE_TYPES)[number];

/** The container an agent runs its commands on when just-bash cannot run them. */
export type SandboxSpec = {
  readonly instanceType: SandboxInstanceType;
  /** Save the machine's disk after each turn that used it, and start from it next time. */
  readonly snapshots?: boolean | undefined;
  /** The machine reaches the whole internet. Off unless asked: it reaches only `hosts`. */
  readonly internet?: boolean | undefined;
  /** The hosts the machine may reach over HTTP and HTTPS, each with the secret the service adds. */
  readonly hosts?: readonly SandboxHost[] | undefined;
  /** A browser tool (Browser Run) that sees the machine's apps and the same hosts. */
  readonly browser?: boolean | undefined;
};

/** A host the machine may reach: a name such as `registry.npmjs.org`, or `*.example.com`. */
export type SandboxHost = { readonly host: string; readonly auth?: SandboxHostAuth | undefined };

/**
 * One of the agent's secrets, which the service adds to the machine's HTTPS requests to a host on
 * their way out, so the code running there never sees it. `{ bearer: "NAME" }` sends
 * `Authorization: Bearer <secret>`; `{ basic: "NAME", username }` sends `Authorization: Basic`,
 * what `git` over HTTPS takes (GitHub: username `x-access-token`); `{ header, secret: "NAME" }`
 * sends the secret as that header.
 */
export type SandboxHostAuth =
  | { readonly bearer: string }
  | { readonly basic: string; readonly username: string }
  | { readonly header: string; readonly secret: string };

/** Hosts a machine may declare: a container holds 128 intercepts, and each host takes four. */
export const SANDBOX_MAX_HOSTS = 30;

const SANDBOX_KEYS = new Set(["instanceType", "snapshots", "internet", "hosts", "browser"]);
const HOST_NAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * A `sandbox` export or manifest entry, checked and in manifest form (a host given as a string
 * becomes `{ host }`). Throws a message that says what is wrong with it.
 */
export function parseSandboxSpec(value: unknown): SandboxSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("it must be an object such as { instanceType: \"basic\" }.");
  const unknown = Object.keys(value).filter((key) => !SANDBOX_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`it has ${unknown.map((key) => JSON.stringify(key)).join(", ")}, which it doesn't know: it takes instanceType, snapshots, internet, hosts and browser.`);
  const { instanceType = "basic", snapshots, internet, hosts, browser } = value as Record<string, unknown>;
  if (!SANDBOX_INSTANCE_TYPES.includes(instanceType as never)) throw new Error(`instanceType must be ${SANDBOX_INSTANCE_TYPES.map((t) => JSON.stringify(t)).join(" | ")}.`);
  if (snapshots !== undefined && typeof snapshots !== "boolean") throw new Error("snapshots must be true or false.");
  if (internet !== undefined && typeof internet !== "boolean") throw new Error("internet must be true or false.");
  if (browser !== undefined && typeof browser !== "boolean") throw new Error("browser must be true or false.");
  let parsed: SandboxHost[] | undefined;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts)) throw new Error("hosts must be a list, such as [\"registry.npmjs.org\"].");
    if (hosts.length > SANDBOX_MAX_HOSTS) throw new Error(`hosts can name ${SANDBOX_MAX_HOSTS} hosts at most.`);
    parsed = hosts.map((entry, index) => parseSandboxHost(entry, `hosts[${index}]`));
    const names = parsed.map((entry) => entry.host);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined) throw new Error(`hosts names ${repeated} twice.`);
  }
  return {
    instanceType: instanceType as SandboxInstanceType,
    ...(snapshots === true ? { snapshots } : {}),
    ...(internet === true ? { internet } : {}),
    ...(parsed === undefined || parsed.length === 0 ? {} : { hosts: parsed }),
    ...(browser === true ? { browser } : {}),
  };
}

function parseSandboxHost(entry: unknown, where: string): SandboxHost {
  const { host, auth, ...rest } = (typeof entry === "string" ? { host: entry } : entry ?? {}) as Record<string, unknown>;
  if (typeof entry !== "string" && (typeof entry !== "object" || Array.isArray(entry) || Object.keys(rest).length > 0)) {
    throw new Error(`${where} must be a host name, or { host, auth? }.`);
  }
  const name = typeof host === "string" ? host.toLowerCase() : "";
  if (!HOST_NAME.test(name)) throw new Error(`${where} must be a host name such as "registry.npmjs.org" or "*.example.com", without a scheme, port or path.`);
  if (auth === undefined) return { host: name };
  return { host: name, auth: parseHostAuth(auth, `${where}.auth`) };
}

function parseHostAuth(auth: unknown, where: string): SandboxHostAuth {
  const fields = auth !== null && typeof auth === "object" && !Array.isArray(auth) ? (auth as Record<string, unknown>) : {};
  const keys = Object.keys(fields).sort().join(",");
  const secret = (name: unknown) => {
    if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new Error(`${where} must name one of the agent's secrets, in UPPER_SNAKE_CASE.`);
    return name;
  };
  if (keys === "bearer") return { bearer: secret(fields.bearer) };
  if (keys === "basic,username" && typeof fields.username === "string" && fields.username !== "" && !fields.username.includes(":")) {
    return { basic: secret(fields.basic), username: fields.username };
  }
  if (keys === "header,secret" && typeof fields.header === "string" && HEADER_NAME.test(fields.header) && fields.header.toLowerCase() !== "host") {
    return { header: fields.header.toLowerCase(), secret: secret(fields.secret) };
  }
  throw new Error(`${where} must be { bearer: "NAME" }, { basic: "NAME", username: "..." } or { header: "x-api-key", secret: "NAME" }.`);
}

export type ManifestTool = {
  readonly name: string;
  readonly kind: "server" | "client";
  readonly description?: string | undefined;
  readonly inputSchema?: JsonSchema | undefined;
};

/** A tool the website defines and runs: sent with each message, run in the browser. */
export type PageToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

/** `POST <connection>/chat`. */
export type ChatRequestBody = {
  /** The conversation. The service keeps its history; the website keeps only the id. */
  readonly chatId: string;
  /** The new user message, AI SDK `UIMessage` shaped. */
  readonly message: WireUIMessage;
  /** Tools the page defines (name, description, input schema). They run in the browser. */
  readonly tools?: readonly PageToolSpec[] | undefined;
  /** The agent's own client tools this page implements. Others are not offered to the model. */
  readonly implements?: readonly string[] | undefined;
  /** Anything the agent's code reads as `extraBody` (a case id, the page the user is on). */
  readonly context?: Readonly<Record<string, unknown>> | undefined;
};

/** `POST <connection>/chats/<chatId>/tool-results`: what the browser's tool returned. */
export type ToolResultBody = {
  readonly toolCallId: string;
  readonly output?: unknown;
  /** Set when the browser's tool threw; the model sees it as the tool's error. */
  readonly error?: string | undefined;
};

/** `GET <connection>`: what a website needs to know about the agent behind a URL. */
export type ConnectionInfo = {
  readonly agent: string;
  readonly branch: string;
  /** True when this URL follows the agent's production branch. */
  readonly production: boolean;
  readonly version: { readonly number: number; readonly id: string; readonly createdAt: string; readonly message?: string | undefined } | null;
  /** Client tools the agent declares; the page implements them by name. */
  readonly clientTools: readonly ManifestTool[];
  /** Whether the URL takes anonymous visitors, or only signed user tokens. */
  readonly users: "anonymous" | "signed";
};

/** A UI message as JSON: `{ id, role, parts }`. The service does not look inside parts. */
export type WireUIMessage = {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly parts: readonly unknown[];
  readonly metadata?: unknown;
};

export type ChatSummary = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: number;
};

/** The header that names the website's user: `anon:<id>` or a signed token. */
export const USER_HEADER = "x-little-user";

/**
 * What an agent gets in `extraBody.github` with a message from a GitHub webhook
 * (`<connection URL>/webhooks/github`): the pull request to review.
 */
export type GitHubPullRequestContext = {
  readonly event: "pull_request";
  readonly action: string;
  readonly delivery: string;
  /** `owner/name` of the repository the pull request is in. */
  readonly repository: string;
  readonly cloneUrl: string;
  readonly private: boolean;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    /** The pull request in GitHub's API (`…/repos/<owner>/<name>/pulls/<number>`): reviews are posted under it. */
    readonly apiUrl: string;
    readonly author: string;
    readonly draft: boolean;
    readonly head: { readonly ref: string; readonly sha: string; readonly repository: string };
    readonly base: { readonly ref: string; readonly sha: string };
    /** For a push: the head before it. */
    readonly before?: string;
  };
};

/** Agent and branch names accepted by the service and command. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export type ScheduleStatus = {
  readonly id: string;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly session: string | null;
  readonly catchUp: boolean | null;
  readonly kind: "prompt" | "type" | null;
  readonly description?: string;
  readonly runnable: boolean;
  readonly reason?: string;
  readonly paused: boolean;
  readonly handledThrough: string | null;
  readonly nextAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastResult: string | null;
};
