import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import type { ResolvedSkill } from "../types.js";

export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** Most bytes of one skill file returned at a time. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/**
 * Opens a skill for an agent without bash, which cannot `cat` the staged SKILL.md. Returns the
 * file and the names of the skill's other files, which the same tool opens with `file`.
 */
export function createLoadSkillTool(skills: readonly ResolvedSkill[]): ToolSet {
  const names = skills.map((skill) => skill.name);
  return {
    [LOAD_SKILL_TOOL_NAME]: tool({
      description:
        "Open one of the available skills by name. Returns its SKILL.md, or another of its files with file.",
      inputSchema: zodSchema(
        z.object({
          name: z.string().min(1).max(128).describe(`One of: ${names.join(", ")}.`),
          file: z
            .string()
            .min(1)
            .max(512)
            .optional()
            .describe("Another file of the skill, as listed in otherFiles. Default: SKILL.md."),
        }),
      ),
      execute: async (input: { name: string; file?: string | undefined }) => {
        const skill = skills.find((candidate) => candidate.name === input.name.trim());
        if (skill === undefined) {
          throw new HarnessInputError(`No skill named ${input.name}. Available skills: ${names.join(", ")}.`);
        }
        const file = (input.file ?? "SKILL.md").trim().replace(/^\.?\/+/u, "");
        const content = Object.hasOwn(skill.files, file) ? skill.files[file] : undefined;
        if (content === undefined) {
          throw new HarnessInputError(`Skill ${skill.name} has no file ${file}.`, {
            files: Object.keys(skill.files),
          });
        }
        if (content.includes(0)) {
          return { name: skill.name, file, binary: true, bytes: content.byteLength };
        }
        const truncated = content.byteLength > MAX_SKILL_FILE_BYTES;
        return {
          name: skill.name,
          file,
          content: new TextDecoder().decode(truncated ? content.subarray(0, MAX_SKILL_FILE_BYTES) : content),
          ...(truncated ? { truncated: true } : {}),
          otherFiles: Object.keys(skill.files).filter((other) => other !== file).sort(),
        };
      },
    }),
  };
}
