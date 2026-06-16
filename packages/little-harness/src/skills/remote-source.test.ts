import { describe, expect, it } from "vitest";
import { parseRemoteSkillSource } from "./remote-source.js";

describe("parseRemoteSkillSource", () => {
  it("accepts explicit GitHub URLs", () => {
    expect(parseRemoteSkillSource("https://github.com/org/repo")).toMatchObject({
      original: "https://github.com/org/repo",
      cloneUrl: "https://github.com/org/repo.git",
      provider: "github",
      ownerRepo: "org/repo",
    });
  });

  it("extracts GitHub tree refs and skill subpaths", () => {
    expect(
      parseRemoteSkillSource("https://github.com/org/repo/tree/main/skills/frontend-design"),
    ).toMatchObject({
      cloneUrl: "https://github.com/org/repo.git",
      provider: "github",
      ownerRepo: "org/repo",
      ref: "main",
      subpath: "skills/frontend-design",
    });
  });

  it("preserves non-default ports in GitHub clone URLs", () => {
    expect(
      parseRemoteSkillSource("https://github.com:8443/org/repo/tree/main/skills/frontend-design"),
    ).toMatchObject({
      cloneUrl: "https://github.com:8443/org/repo.git",
      provider: "github",
      host: "github.com:8443",
      ownerRepo: "org/repo",
      ref: "main",
      subpath: "skills/frontend-design",
    });
  });

  it("accepts GitLab tree URLs on corporate hosts", () => {
    expect(
      parseRemoteSkillSource("https://gitlab.company.com/group/project/-/tree/main/skills/foo"),
    ).toMatchObject({
      cloneUrl: "https://gitlab.company.com/group/project.git",
      provider: "gitlab",
      ref: "main",
      subpath: "skills/foo",
    });
  });

  it("preserves non-default ports in GitLab clone URLs", () => {
    expect(
      parseRemoteSkillSource("https://gitlab.company.com:8443/group/project/-/tree/main/skills/foo"),
    ).toMatchObject({
      cloneUrl: "https://gitlab.company.com:8443/group/project.git",
      provider: "gitlab",
      host: "gitlab.company.com:8443",
      ref: "main",
      subpath: "skills/foo",
    });
  });

  it("accepts generic SSH Git URLs", () => {
    expect(parseRemoteSkillSource("ssh://git@git.company.com/group/project.git")).toMatchObject({
      cloneUrl: "ssh://git@git.company.com/group/project.git",
      provider: "git",
      host: "git.company.com",
    });
  });

  it("accepts scp-style Git URLs", () => {
    expect(parseRemoteSkillSource("git@git.company.com:group/project.git")).toMatchObject({
      cloneUrl: "git@git.company.com:group/project.git",
      provider: "git",
      host: "git.company.com",
    });
  });

  it("rejects shorthand sources", () => {
    expect(() => parseRemoteSkillSource("org/repo")).toThrow(/explicit Git URL/u);
    expect(() => parseRemoteSkillSource("github:org/repo")).toThrow(/explicit Git URL/u);
    expect(() => parseRemoteSkillSource("gitlab:org/repo")).toThrow(/explicit Git URL/u);
  });

  it("rejects non-HTTPS HTTP Git URLs", () => {
    expect(() => parseRemoteSkillSource("http://github.com/org/repo")).toThrow(/explicit Git URL/u);
    expect(() => parseRemoteSkillSource("http://git.company.com/group/project.git")).toThrow(
      /explicit Git URL/u,
    );
  });

  it("rejects git protocol URLs", () => {
    expect(() => parseRemoteSkillSource("git://git.company.com/group/project.git")).toThrow(
      /explicit Git URL/u,
    );
    expect(() => parseRemoteSkillSource("git:org/repo")).toThrow(/explicit Git URL/u);
  });

  it("rejects traversal in tree subpaths", () => {
    expect(() =>
      parseRemoteSkillSource("https://github.com/org/repo/tree/main/skills/../secret"),
    ).toThrow(/path traversal/u);
  });

  it("rejects credential-bearing URLs without leaking credentials", () => {
    try {
      parseRemoteSkillSource("https://secret-token@example.com/org/repo.git");
    } catch (error) {
      expect((error as Error).message).toMatch(/must not include credentials/u);
      expect(JSON.stringify(error)).not.toContain("secret-token");
      return;
    }

    throw new Error("Expected credential-bearing URL to fail");
  });

  it("rejects query-bearing HTTPS Git URLs without leaking query secrets", () => {
    for (const source of [
      "https://git.company.com/group/project.git?token=secret-token",
      "https://github.com/org/repo/tree/main/skills/foo?token=secret-token",
    ]) {
      try {
        parseRemoteSkillSource(source);
      } catch (error) {
        expect((error as Error).message).toMatch(/must not include query parameters/u);
        expect(JSON.stringify(error)).not.toContain("secret-token");
        continue;
      }

      throw new Error(`Expected query-bearing URL to fail: ${source}`);
    }
  });

  it("rejects encoded delimiters in GitHub and GitLab path segments without leaking secrets", () => {
    for (const source of [
      "https://github.com/org/repo%3Ftoken=secret-token",
      "https://github.com/org/repo%23secret-token",
      "https://github.com/org%2Fsecret-token/repo",
      "https://gitlab.com/group/project%3Ftoken=secret-token",
      "https://gitlab.com/group/project%23secret-token",
      "https://gitlab.com/group%2Fsecret-token/project",
    ]) {
      try {
        parseRemoteSkillSource(source);
      } catch (error) {
        expect((error as Error).message).toMatch(/encoded delimiters/u);
        expect(JSON.stringify(error)).not.toContain("secret-token");
        continue;
      }

      throw new Error(`Expected encoded delimiter URL to fail: ${source}`);
    }
  });

  it("rejects scp-style query or fragment values without leaking secrets", () => {
    for (const source of [
      "git@git.company.com:org/repo.git?token=secret-token",
      "git@git.company.com:org/repo.git#secret-token",
    ]) {
      try {
        parseRemoteSkillSource(source);
      } catch (error) {
        expect((error as Error).message).toMatch(/must not include query parameters or fragments/u);
        expect(JSON.stringify(error)).not.toContain("secret-token");
        continue;
      }

      throw new Error(`Expected scp-style query or fragment to fail: ${source}`);
    }
  });
});
