import type { ResolvedHarnessMemoryConfig, ResolvedSkill } from "../types.js";

export const MEMORY_SKILL_NAME = "memory";
const MEMORY_SKILL_DESCRIPTION =
  "How to save, change and forget long-term memories. Read it before writing to a memory folder";

/**
 * The built-in `memory` skill: how to keep memory files, and nothing about where they are or
 * who may change them. The per-turn note carries those, so a developer's own copy of this skill
 * keeps working when the harness changes them.
 */
export const MEMORY_SKILL_BODY = `---
name: ${MEMORY_SKILL_NAME}
description: ${MEMORY_SKILL_DESCRIPTION}
---

# Memory

Your long-term memory is plain files in the memory folders your instructions list. Every turn you
see each folder, whether you may change it in this conversation, and one line per file. What you
write there is what you, and anyone who shares the folder, will see in later conversations.

## What to save

Save what will still matter in a later conversation:

- rules, facts and decisions someone gives you that will apply again;
- corrections to how you work, such as "don't do X" or "always do Y";
- a person's preferences about how you work with them.

Don't save:

- secrets, such as passwords, API keys, tokens or account numbers;
- details of the task at hand, such as one application or one ticket, unless someone asks you to
  remember them;
- what the conversation, the files or your tools already tell you;
- guesses. Save what someone told you or what you checked.

## Which folder

- Knowledge everyone shares, such as company rules, goes in the shared folder.
- One person's preferences go in that person's own folder.
- Follow each folder's description. If no folder fits, don't save.

## One file per memory

Write each memory as its own Markdown file, named for its topic, such as
\`rules/min-time-in-business.md\` or \`style/reply-tone.md\`:

\`\`\`markdown
---
description: Applicants need at least 12 months in business. Decline anything shorter.
---

Applicants need at least 12 months in business. Decline anything shorter.
Set by the head of underwriting, 2026-10-14.
\`\`\`

The \`description\` is the line you see every turn, so make it state the memory itself, not a
title. Keep it to a sentence or two. Put detail, examples and where it came from in the body.

## Change or forget

- Before you save, look for a memory on the same topic. Edit that file instead of adding another.
- When a memory changes, rewrite its file, description included, so only the new version is left.
- When a memory stops being true, or someone asks you to forget it, delete its file.
- When two memories disagree, keep the newer one and fix or delete the other.
- Tell the person in a few words what you saved, changed or forgot.

## When you may not change a folder

When a folder is read-only in this conversation, use it but don't write to it. If someone asks you
to change it, say you can't here, and who can if the folder's description says. Don't save the
change in another folder instead.
`;

export function builtInMemorySkill(): ResolvedSkill {
  return {
    name: MEMORY_SKILL_NAME,
    description: MEMORY_SKILL_DESCRIPTION,
    harnessDir: `.agents/skills/${MEMORY_SKILL_NAME}`,
    files: { "SKILL.md": new TextEncoder().encode(MEMORY_SKILL_BODY) },
  };
}

/**
 * The turn's skills with the built-in `memory` skill added when a memory uses it and no skill
 * named `memory` is already there: a developer's own skill of that name replaces it.
 */
export function withMemorySkill(
  skills: readonly ResolvedSkill[],
  memory: readonly ResolvedHarnessMemoryConfig[],
): ResolvedSkill[] {
  if (!memory.some((config) => config.skill) || skills.some((skill) => skill.name === MEMORY_SKILL_NAME)) {
    return [...skills];
  }
  return [...skills, builtInMemorySkill()];
}
