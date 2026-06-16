import { HarnessInputError } from "../errors.js";
import type { RemoteSkillOptions, ResolvedSkill, SkillOidcToken, SkillRiskLevel } from "../types.js";
import type { ParsedRemoteSkillSource } from "./remote-source.js";

const RISK_ORDER: Record<SkillRiskLevel, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export type AuditRemoteSkillsOptions = Pick<RemoteSkillOptions, "skillMaxRisk" | "skillRisk"> & {
  skillOidcToken?: SkillOidcToken;
};

export async function auditRemoteSkills(
  source: ParsedRemoteSkillSource,
  skills: readonly ResolvedSkill[],
  options: AuditRemoteSkillsOptions,
): Promise<void> {
  const effectiveGates = skills
    .map((skill) => ({ skill, maxRisk: effectiveMaxRisk(skill.name, options) }))
    .filter((entry): entry is { skill: ResolvedSkill; maxRisk: SkillRiskLevel } =>
      entry.maxRisk !== undefined
    );

  if (effectiveGates.length === 0) {
    return;
  }

  const token = await resolveOidcToken(options.skillOidcToken);
  if (token === undefined || token.length === 0) {
    throw new HarnessInputError("Remote skill risk gate requires an OIDC token");
  }

  if (source.provider !== "github" || source.ownerRepo === undefined) {
    throw new HarnessInputError("Remote skill audit unavailable for this source", {
      source: source.original,
    });
  }

  for (const { skill, maxRisk } of effectiveGates) {
    const risk = await fetchSkillRisk(source.ownerRepo, skill.name, token);
    if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
      throw new HarnessInputError("Remote skill audit risk exceeds maximum risk", {
        skill: skill.name,
        risk,
        maxRisk,
      });
    }
  }
}

async function resolveOidcToken(
  tokenSource: SkillOidcToken,
): Promise<string | undefined> {
  const fallback = process.env.VERCEL_OIDC_TOKEN;
  if (typeof tokenSource === "function") {
    return (await tokenSource()) ?? fallback;
  }
  return tokenSource ?? fallback;
}

async function fetchSkillRisk(
  ownerRepo: string,
  skill: string,
  token: string,
): Promise<SkillRiskLevel> {
  const url = `https://skills.sh/api/v1/skills/audit/${encodeURIComponent(ownerRepo)}/${encodeURIComponent(skill)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    throw new HarnessInputError("Remote skill audit unavailable", { skill });
  }

  if (response.status === 404) {
    throw new HarnessInputError("Remote skill audit missing", { skill });
  }
  if (!response.ok) {
    throw new HarnessInputError("Remote skill audit unavailable", {
      skill,
      status: response.status,
    });
  }

  const body = await response.json().catch(() => undefined);
  const risk = auditRiskFromBody(body);
  if (risk === undefined) {
    throw new HarnessInputError("Remote skill audit missing", { skill });
  }
  return risk;
}

function auditRiskFromBody(body: unknown): SkillRiskLevel | undefined {
  if (Array.isArray(body)) {
    return maxRisk(body.map((item) => auditRiskFromBody(item)));
  }
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const bodyRecord = body as Record<string, unknown>;
  const rawRisk = riskField(bodyRecord) ?? nestedRiskField(bodyRecord);
  if (typeof rawRisk !== "string") {
    return undefined;
  }
  const normalized = rawRisk.toUpperCase();
  return isRiskLevel(normalized) ? normalized : undefined;
}

function maxRisk(risks: Array<SkillRiskLevel | undefined>): SkillRiskLevel | undefined {
  let max: SkillRiskLevel | undefined;
  for (const risk of risks) {
    if (risk !== undefined && (max === undefined || RISK_ORDER[risk] > RISK_ORDER[max])) {
      max = risk;
    }
  }
  return max;
}

function isRiskLevel(value: string): value is SkillRiskLevel {
  return value === "NONE" || value === "LOW" || value === "MEDIUM" ||
    value === "HIGH" || value === "CRITICAL";
}

function effectiveMaxRisk(
  skillName: string,
  options: Pick<RemoteSkillOptions, "skillMaxRisk" | "skillRisk">,
): SkillRiskLevel | undefined {
  const override = skillRiskOverride(skillName, options.skillRisk);
  return override ?? options.skillMaxRisk;
}

function skillRiskOverride(
  skillName: string,
  skillRisk: Record<string, SkillRiskLevel> | undefined,
): SkillRiskLevel | undefined {
  if (skillRisk === undefined) {
    return undefined;
  }
  const normalized = skillName.toLowerCase();
  for (const [name, risk] of Object.entries(skillRisk)) {
    if (name.toLowerCase() === normalized) {
      return risk;
    }
  }
  return undefined;
}

function riskField(body: Record<string, unknown>): unknown {
  return body.riskLevel ?? body.risk;
}

function nestedRiskField(body: Record<string, unknown>): unknown {
  const audit = body.audit;
  if (typeof audit !== "object" || audit === null) {
    return undefined;
  }
  const auditRecord = audit as Record<string, unknown>;
  return auditRecord.riskLevel ?? auditRecord.risk;
}
