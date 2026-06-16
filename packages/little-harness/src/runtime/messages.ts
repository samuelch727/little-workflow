import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { buildMemorySystemContext } from "../memory/memory.js";
import { resolveSkillsWithWarnings } from "../skills/skill.js";
import type {
  FileWriter,
  Harness,
  HarnessSession,
  HarnessWarning,
  ResolvedHarnessConfig,
  ResolvedSkill,
} from "../types.js";

export type BuildModelMessagesOptions<TExtraBody = unknown> = {
  harness: Harness<any, TExtraBody>;
  config: ResolvedHarnessConfig<any, TExtraBody>;
  session: HarnessSession;
  files?: FileWriter;
  messages?: UIMessage[];
  type?: string;
  input?: unknown;
  extraBody?: TExtraBody | undefined;
  stagingNotices?: string[];
  stripStagedFileParts?: boolean;
  resolvedSkills?: ResolvedSkill[];
};

export type BuildModelMessagesResult = {
  system: string;
  messages: ModelMessage[];
  warnings: HarnessWarning[];
  output?: unknown;
};

export async function buildModelMessages<TExtraBody>(
  options: BuildModelMessagesOptions<TExtraBody>,
): Promise<BuildModelMessagesResult> {
  const warnings: HarnessWarning[] = [];
  const systemParts: string[] = [];

  appendSystem(options.config.system, systemParts);

  const skills = options.resolvedSkills ?? [];
  if (options.resolvedSkills === undefined) {
    const resolved = await resolveSkillsWithWarnings(options.config.skills, {
      skillMaxRisk: options.config.skillMaxRisk,
      skillOidcToken: options.config.skillOidcToken,
    });
    skills.push(...resolved.skills);
    warnings.push(...resolved.warnings);
  }
  if (skills.length > 0) {
    systemParts.push(
      `Available skills:\n${skills
        .map((skill) => `- ${skill.name}: ${skill.description}. Read details at ${skill.harnessDir}/SKILL.md`)
        .join("\n")}`,
    );
  }

  const memoryContext = options.files
    ? await buildMemorySystemContext(options.config.memory, options.files)
    : undefined;
  if (memoryContext) {
    systemParts.push(memoryContext);
  }

  if (options.messages) {
    const messages = await convertToModelMessages(
      options.stripStagedFileParts ? stripFileParts(options.messages) : options.messages,
    );
    if (options.stagingNotices?.length) {
      messages.push({
        role: "user",
        content: `Files staged into the harness filesystem:\n${options.stagingNotices.join("\n")}`,
      });
    }
    return { system: systemParts.join("\n\n"), messages, warnings };
  }

  if (!options.type) {
    throw new Error("Either messages or type + input is required");
  }

  const definition = options.config.inputTypes?.[options.type];
  if (!definition) {
    warnings.push({
      code: "undefined_input_type",
      message: `Input Type '${options.type}' has no definition.`,
      metadata: { type: options.type },
    });
    return {
      system: systemParts.join("\n\n"),
      messages: [
        {
          role: "user",
          content: `Input Type: ${options.type}\n\nPayload:\n${JSON.stringify(options.input, null, 2)}`,
        },
      ],
      warnings,
    };
  }

  const parsed = definition.inputSchema ? definition.inputSchema.parse(options.input) : options.input;
  if (definition.instructions) {
    systemParts.push(definition.instructions);
  }
  if (definition.description) {
    systemParts.push(`Input Type '${options.type}': ${definition.description}`);
  }

  const messages = definition.toMessages
    ? await definition.toMessages({
        input: parsed,
        extraBody: options.extraBody,
        session: options.session,
        files: options.files ?? options.session.files,
      })
    : ([{ role: "user", content: JSON.stringify(parsed, null, 2) }] satisfies ModelMessage[]);

  const result: BuildModelMessagesResult = {
    system: systemParts.join("\n\n"),
    messages,
    warnings,
  };
  if (definition.output !== undefined) {
    result.output = definition.output;
  }

  return result;
}

function stripFileParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray((message as any).parts)
      ? ((message as any).parts as Array<{ type?: string }>)
      : undefined;
    if (!parts) {
      return message;
    }

    const filteredParts = parts.filter((part) => part?.type !== "file");
    return {
      ...message,
      parts: filteredParts,
    } as UIMessage;
  });
}

function appendSystem(
  system: ResolvedHarnessConfig<any, any>["system"],
  systemParts: string[],
): void {
  if (typeof system === "string") {
    systemParts.push(system);
    return;
  }

  if (Array.isArray(system)) {
    for (const message of system) {
      if (message.role === "system" && typeof message.content === "string") {
        systemParts.push(message.content);
      }
    }
    return;
  }

  if (system?.role === "system" && typeof system.content === "string") {
    systemParts.push(system.content);
  }
}
