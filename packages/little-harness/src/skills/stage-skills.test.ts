import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { withTempDir } from "../test/temp.js";
import { stageResolvedSkills } from "./stage-skills.js";

describe("stageResolvedSkills", () => {
  it("stages remote-resolved .agents skills", async () => {
    await withTempDir(async (dir) => {
      await stageResolvedSkills(dir, [
        {
          name: "alpha",
          description: "Alpha skill.",
          harnessDir: ".agents/skills/alpha",
          files: {
            "SKILL.md": new TextEncoder().encode("Alpha body"),
          },
        },
      ]);

      await expect(readFile(path.join(dir, ".agents/skills/alpha/SKILL.md"), "utf8"))
        .resolves.toBe("Alpha body");
    });
  });

  it("rejects legacy /skills paths", async () => {
    await withTempDir(async (dir) => {
      await expect(
        stageResolvedSkills(dir, [
          {
            name: "legacy",
            description: "Legacy skill.",
            harnessDir: "/skills/legacy",
            files: {
              "SKILL.md": new TextEncoder().encode("Legacy body"),
            },
          },
        ]),
      ).rejects.toThrow(/\.agents\/skills/u);
    });
  });

  it("rejects duplicate staged skill names", async () => {
    await withTempDir(async (dir) => {
      await expect(
        stageResolvedSkills(dir, [
          {
            name: "figma-mcp",
            description: "Use the Figma MCP server.",
            harnessDir: ".agents/skills/figma-mcp-a",
            files: {
              "SKILL.md": new TextEncoder().encode("First body"),
            },
          },
          {
            name: "figma-mcp",
            description: "Use the Figma MCP server.",
            harnessDir: ".agents/skills/figma-mcp-b",
            files: {
              "SKILL.md": new TextEncoder().encode("Second body"),
            },
          },
        ]),
      ).rejects.toThrow(HarnessInputError);
    });
  });

  it("rejects duplicate staged skill roots", async () => {
    await withTempDir(async (dir) => {
      await expect(
        stageResolvedSkills(dir, [
          {
            name: "figma-mcp-a",
            description: "Use the Figma MCP server.",
            harnessDir: ".agents/skills/figma-mcp",
            files: {
              "SKILL.md": new TextEncoder().encode("First body"),
            },
          },
          {
            name: "figma-mcp-b",
            description: "Use the Figma MCP server.",
            harnessDir: ".agents/skills/figma-mcp/..//figma-mcp",
            files: {
              "SKILL.md": new TextEncoder().encode("Second body"),
            },
          },
        ]),
      ).rejects.toThrow(HarnessInputError);
    });
  });

  it("rejects the shared .agents/skills root as a staged skill root", async () => {
    await withTempDir(async (dir) => {
      await expect(
        stageResolvedSkills(dir, [
          {
            name: "root-skill",
            description: "Invalid root skill.",
            harnessDir: ".agents/skills",
            files: {
              "SKILL.md": new TextEncoder().encode("Root body"),
            },
          },
        ]),
      ).rejects.toThrow(/inside \.agents\/skills/u);
    });
  });
});
