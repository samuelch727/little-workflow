import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSkill } from "../types.js";
import { auditRemoteSkills } from "./audit.js";
import type { ParsedRemoteSkillSource } from "./remote-source.js";

const githubSource: ParsedRemoteSkillSource = {
  original: "https://github.com/org/repo",
  cloneUrl: "https://github.com/org/repo.git",
  provider: "github",
  host: "github.com",
  ownerRepo: "org/repo",
};

const genericSource: ParsedRemoteSkillSource = {
  original: "https://git.company.com/org/repo.git",
  cloneUrl: "https://git.company.com/org/repo.git",
  provider: "git",
  host: "git.company.com",
};

const alphaSkill: ResolvedSkill = {
  name: "alpha",
  description: "Alpha skill.",
  harnessDir: ".agents/skills/alpha",
  files: {},
};

describe("auditRemoteSkills", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not call the audit API when no risk gate is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await auditRemoteSkills(githubSource, [alphaSkill], {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an OIDC token when a risk gate is configured", async () => {
    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], { skillMaxRisk: "LOW" }),
    ).rejects.toThrow(/OIDC token/u);
  });

  it("uses the explicit skill OIDC token option", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ riskLevel: "LOW" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "LOW",
      skillOidcToken: () => "skill-oidc-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://skills.sh/api/v1/skills/audit/org%2Frepo/alpha",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer skill-oidc-token" }),
      }),
    );
  });

  it("falls back to the env OIDC token when the explicit callback returns undefined", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "env-oidc-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ riskLevel: "LOW" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "LOW",
      skillOidcToken: () => undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://skills.sh/api/v1/skills/audit/org%2Frepo/alpha",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env-oidc-token" }),
      }),
    );
  });

  it("passes skills at or below the configured risk level", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ risk: "LOW" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "MEDIUM",
      skillOidcToken: () => "oidc-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://skills.sh/api/v1/skills/audit/org%2Frepo/alpha",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer oidc-token" }),
      }),
    );
  });

  it("accepts the Skills API riskLevel response field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ riskLevel: "LOW" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "LOW",
      skillOidcToken: "oidc-token",
    });
  });

  it("uses per-skill risk gates before the source-level risk gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ riskLevel: "MEDIUM" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "HIGH",
        skillRisk: { alpha: "LOW" },
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/exceeds maximum risk/u);
  });

  it("allows per-skill risk gates to relax the source-level risk gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ riskLevel: "MEDIUM" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "LOW",
      skillRisk: { alpha: "MEDIUM" },
      skillOidcToken: "oidc-token",
    });
  });

  it("uses the maximum risk from multi-record audit responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ riskLevel: "LOW" }, { riskLevel: "HIGH" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "MEDIUM",
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/exceeds maximum risk/u);
  });

  it("passes multi-record audit responses when every risk is below the gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ riskLevel: "LOW" }, { riskLevel: "MEDIUM" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await auditRemoteSkills(githubSource, [alphaSkill], {
      skillMaxRisk: "MEDIUM",
      skillOidcToken: "oidc-token",
    });
  });

  it("fails skills above the configured risk level", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ risk: "HIGH" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "MEDIUM",
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/exceeds maximum risk/u);
  });

  it("fails when the audit API returns 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not found", {
          status: 404,
        }),
      ),
    );

    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "LOW",
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/audit missing/u);
  });

  it("fails when the audit response has no risk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "LOW",
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/audit missing/u);
  });

  it("fails gated non-GitHub sources as audit unavailable", async () => {
    await expect(
      auditRemoteSkills(genericSource, [alphaSkill], {
        skillMaxRisk: "LOW",
        skillOidcToken: "oidc-token",
      }),
    ).rejects.toThrow(/audit unavailable/u);
  });

  it("redacts OIDC tokens from audit errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("backend saw oidc-secret-token", {
          status: 500,
        }),
      ),
    );

    try {
      await auditRemoteSkills(githubSource, [alphaSkill], {
        skillMaxRisk: "LOW",
        skillOidcToken: "oidc-secret-token",
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("oidc-secret-token");
      return;
    }

    throw new Error("Expected audit to fail");
  });
});
