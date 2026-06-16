import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
});
