import { describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { createLoadSkillTool } from "../skills/load-skill-tool.js";
import { withTempDir } from "../test/temp.js";
import type { FileWriter, ResolvedSkill } from "../types.js";
import { createMemoryFileTools } from "./file-tools.js";
import {
  buildMemorySystemContext,
  MEMORY_INDEX_SUMMARY_CHARS,
  memory,
  memorySummary,
  resolveHarnessMemory,
} from "./memory.js";
import { MEMORY_SKILL_BODY, withMemorySkill } from "./skill.js";

type Body = { userId: string; role: "officer" | "underwriter" };

const encode = (text: string) => new TextEncoder().encode(text);

function layers() {
  return [
    memory<Body>({
      sourceDir: "memory/company",
      harnessDir: "/persistent/company",
      description: "The bank's shared lending rules.",
      canWrite: ({ extraBody }) => extraBody?.role === "underwriter",
    }),
    memory<Body>({
      sourceDir: ({ extraBody }) => `memory/users/${extraBody?.userId}`,
      harnessDir: "/persistent/me",
      description: "This person's own preferences.",
    }),
  ];
}

async function withSession(fn: (files: FileWriter, session: any) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
      id: "chat",
    });
    await fn(session.files, session);
  });
}

describe("resolveHarnessMemory", () => {
  it("turns a memory into a Persistent Dir and a config, with no tool", () => {
    const resolved = resolveHarnessMemory(memory({ sourceDir: "memory/agent" }));
    expect(resolved.configs).toEqual([
      { harnessDir: "/persistent/memory", commit: "after-turn", maxIndexBytes: 8000, skill: true },
    ]);
    expect(resolved.persistentDirs).toHaveLength(1);
    expect(resolved.persistentDirs[0]).toMatchObject({ harnessDir: "/persistent/memory", commit: "after-turn" });
    expect(resolved).not.toHaveProperty("tools");
  });

  it("mounts each layer at its own harnessDir and hands canWrite to the Persistent Dir", () => {
    const resolved = resolveHarnessMemory(layers());
    expect(resolved.configs.map((config) => [config.harnessDir, config.description])).toEqual([
      ["/persistent/company", "The bank's shared lending rules."],
      ["/persistent/me", "This person's own preferences."],
    ]);
    expect(typeof resolved.persistentDirs[0]?.canWrite).toBe("function");
    expect(resolved.persistentDirs[1]?.canWrite).toBeUndefined();
  });

  it("rejects two memories at the same harnessDir or one inside another", () => {
    expect(() =>
      resolveHarnessMemory([
        memory({ sourceDir: "a", harnessDir: "/persistent/company/" }),
        memory({ sourceDir: "b", harnessDir: "/persistent/company" }),
      ]),
    ).toThrow("Each memory needs its own harnessDir");
    expect(() =>
      resolveHarnessMemory([
        memory({ sourceDir: "a", harnessDir: "/persistent/company" }),
        memory({ sourceDir: "b", harnessDir: "/persistent/company/team" }),
      ]),
    ).toThrow("not inside another memory");
  });

  it("uses a backend as the Persistent Dir's load and store", async () => {
    const stored: unknown[] = [];
    const resolved = resolveHarnessMemory(
      memory({
        harnessDir: "/persistent/company",
        backend: {
          load: () => ({ "rule.md": "From the backend." }),
          store: ({ changes }) => void stored.push(changes),
        },
      }),
    );
    const dir = resolved.persistentDirs[0]!;
    expect(await dir.load!({ session: {} as any })).toEqual({ "rule.md": "From the backend." });
    const changes = { created: {}, updated: {}, deleted: ["rule.md"] };
    await dir.store!({ changes } as any);
    expect(stored).toEqual([changes]);

    const noStore = resolveHarnessMemory(memory({ backend: { load: () => ({}) } })).persistentDirs[0]!;
    expect(noStore.store).toBeUndefined();
  });

  it("rejects invalid options early", () => {
    expect(() => resolveHarnessMemory(memory({ harnessDir: "/persistent/x" }))).toThrow(
      "Memory needs exactly one of sourceDir or backend.",
    );
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", backend: { load: () => ({}) } }))).toThrow(
      "Memory needs exactly one of sourceDir or backend.",
    );
    expect(() => resolveHarnessMemory(memory({ backend: {} as any }))).toThrow("load function");
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", canWrite: true as any }))).toThrow(
      "canWrite must be a function",
    );
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", maxIndexBytes: 0 }))).toThrow(HarnessInputError);
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", instructions: "x".repeat(4097) }))).toThrow(
      "at most 4096 characters",
    );
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", skill: true as any }))).toThrow(
      "add a skill named memory",
    );
    expect(() => resolveHarnessMemory(memory({ sourceDir: "x", commit: "never" as any }))).toThrow(
      "Memory commit must be",
    );
  });

  it("names an option the remember-tool memory took instead of ignoring it", () => {
    for (const [key, value] of [
      ["tool", { name: "remember" }],
      ["indexPath", "MEMORY.md"],
      ["maxEntryBytes", 1000],
      ["now", () => new Date()],
    ] as const) {
      expect(() => resolveHarnessMemory(memory({ sourceDir: "x", [key]: value } as any))).toThrow(
        new RegExp(`Memory option ${key} was removed: memory is now files .* built-in memory skill`),
      );
    }
  });

  it("canonicalizes safe harnessDir equivalents and rejects escapes", () => {
    expect(resolveHarnessMemory(memory({ sourceDir: "x", harnessDir: "/persistent/./a//b/" })).configs[0]?.harnessDir).toBe(
      "/persistent/a/b",
    );
    for (const harnessDir of ["persistent/a", "/persistent", "/persistent/../etc", "/tmp/a"]) {
      expect(() => resolveHarnessMemory(memory({ sourceDir: "x", harnessDir }))).toThrow(HarnessInputError);
    }
  });
});

describe("memorySummary", () => {
  it("uses the frontmatter description when there is one", () => {
    expect(memorySummary(encode("---\ndescription: Decline under 12 months.\n---\n\nLonger body.\n"))).toBe(
      "Decline under 12 months.",
    );
    expect(memorySummary(encode('---\ndescription: "Rule: 12 months, \\"strict\\"."\n---\n'))).toBe(
      'Rule: 12 months, "strict".',
    );
    expect(memorySummary(encode("---\ndescription: 'It''s 12 months.'\n---\n"))).toBe("It's 12 months.");
    expect(memorySummary(encode("---\ndescription: >\n  Two lines\n  of rule.\nother: x\n---\n"))).toBe(
      "Two lines of rule.",
    );
  });

  it("falls back to the memory's own words, keeping colons and cutting only long ones", () => {
    expect(memorySummary(encode("# Score rule\n\nScores under 600: decline.\nUnless a co-signer.\n"))).toBe(
      "Score rule Scores under 600: decline. Unless a co-signer.",
    );
    const long = "word ".repeat(400);
    const summary = memorySummary(encode(long))!;
    expect(summary).toHaveLength(MEMORY_INDEX_SUMMARY_CHARS + 1);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("gives no summary for binary or empty files", () => {
    expect(memorySummary(new Uint8Array([0x89, 0x50, 0x00, 0x01]))).toBeUndefined();
    expect(memorySummary(encode("---\ntags: [a]\n---\n\n   \n"))).toBeUndefined();
  });
});

describe("buildMemorySystemContext", () => {
  it("shows each memory's folder, description, access and files every turn", async () => {
    await withSession(async (files) => {
      const { configs } = resolveHarnessMemory(layers());
      await files.writeText(
        "/persistent/company/rules/time-in-business.md",
        "---\ndescription: Applicants need 12 months in business.\n---\n\nSet by underwriting.\n",
      );
      await files.writeText("/persistent/company/rules/credit-score.md", "Scores under 600: decline.\n");
      await files.writeText("/persistent/company/.gitkeep", "");

      const context = await buildMemorySystemContext(configs, files, {
        readOnlyDirs: ["/persistent/company"],
        hasMemorySkill: true,
      });
      expect(context.warnings).toEqual([]);
      expect(context.text).toBe(
        [
          "# Memory",
          "",
          "Long-term memory is kept as files in the folders below. It carries over to later conversations.",
          "",
          "## /persistent/company",
          "The bank's shared lending rules.",
          "This memory is read-only in this conversation: use it, but do not change it. If someone asks you to change it, say you can't here.",
          "Files (one line each):",
          "- rules/credit-score.md: Scores under 600: decline.",
          "- rules/time-in-business.md: Applicants need 12 months in business.",
          "",
          "## /persistent/me",
          "This person's own preferences.",
          "You may change this memory in this conversation. Read the memory skill before you save, change or forget anything here.",
          "No memories yet.",
        ].join("\n"),
      );
    });
  });

  it("points at the skill only when the turn has one and the memory uses it", async () => {
    await withSession(async (files) => {
      const withoutSkill = await buildMemorySystemContext(
        resolveHarnessMemory(memory({ sourceDir: "x" })).configs,
        files,
        { readOnlyDirs: [], hasMemorySkill: false },
      );
      expect(withoutSkill.text).toContain("You may change this memory in this conversation.\n");
      expect(withoutSkill.text).not.toContain("memory skill");

      const optedOut = await buildMemorySystemContext(
        resolveHarnessMemory(memory({ sourceDir: "x", skill: false, instructions: "Keep one file per topic." })).configs,
        files,
        { readOnlyDirs: [], hasMemorySkill: true },
      );
      expect(optedOut.text).not.toContain("memory skill");
      expect(optedOut.text).toContain("Keep one file per topic.");
    });
  });

  it("lists as many files as fit in maxIndexBytes and warns about the rest", async () => {
    await withSession(async (files) => {
      const { configs } = resolveHarnessMemory(memory({ sourceDir: "x", maxIndexBytes: 120 }));
      for (const name of ["a", "b", "c", "d", "e"]) {
        await files.writeText(`/persistent/memory/${name}.md`, `Memory ${name} is about twenty bytes.`);
      }
      const context = await buildMemorySystemContext(configs, files, { readOnlyDirs: [], hasMemorySkill: true });
      expect(context.text).toContain("- a.md: Memory a is about twenty bytes.");
      expect(context.text).toContain("- b.md: Memory b is about twenty bytes.");
      expect(context.text).not.toContain("- c.md");
      expect(context.text).toContain("- … 3 more not shown. List /persistent/memory to see them.");
      expect(context.warnings).toEqual([
        expect.objectContaining({
          code: "policy_warning",
          metadata: { reason: "memory_index_truncated", harnessDir: "/persistent/memory", shown: 2, omitted: 3 },
        }),
      ]);
    });
  });

  it("rethrows read errors other than a missing folder", async () => {
    const files = {
      list: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    } as unknown as FileWriter;
    await expect(
      buildMemorySystemContext(resolveHarnessMemory(memory({ sourceDir: "x" })).configs, files, {
        readOnlyDirs: [],
        hasMemorySkill: false,
      }),
    ).rejects.toThrow("permission denied");
  });
});

describe("the built-in memory skill", () => {
  const own: ResolvedSkill = { name: "memory", description: "Ours", harnessDir: ".agents/skills/ours", files: {} };
  const other: ResolvedSkill = { name: "billing", description: "B", harnessDir: ".agents/skills/billing", files: {} };

  it("joins the turn's skills when a memory uses it", () => {
    const { configs } = resolveHarnessMemory(memory({ sourceDir: "x" }));
    const skills = withMemorySkill([other], configs);
    expect(skills.map((skill) => skill.name)).toEqual(["billing", "memory"]);
    expect(new TextDecoder().decode(skills[1]!.files["SKILL.md"])).toBe(MEMORY_SKILL_BODY);
    expect(skills[1]!.harnessDir).toBe(".agents/skills/memory");
  });

  it("gives way to a developer skill named memory, and stays out when no memory uses it", () => {
    const { configs } = resolveHarnessMemory(memory({ sourceDir: "x" }));
    expect(withMemorySkill([own, other], configs)).toEqual([own, other]);
    expect(withMemorySkill([other], resolveHarnessMemory(memory({ sourceDir: "x", skill: false })).configs)).toEqual([
      other,
    ]);
    expect(withMemorySkill([other], [])).toEqual([other]);
  });

  it("says how to keep memories without naming folders or who may write", () => {
    expect(MEMORY_SKILL_BODY).toMatch(/^---\nname: memory\ndescription: .+\n---\n/);
    expect(MEMORY_SKILL_BODY).toContain("delete its file");
    expect(MEMORY_SKILL_BODY).not.toContain("/persistent");
  });
});

describe("memory file tools (bash off)", () => {
  it("lists, reads, writes and deletes files inside the memory folders only", async () => {
    await withSession(async (files, session) => {
      const tools = createMemoryFileTools(resolveHarnessMemory(layers()).configs) as any;
      const context = { files, session };

      await expect(
        tools.write_file.execute({ path: "/persistent/me/style.md", content: "Bullets." }, context),
      ).resolves.toMatchObject({ ok: true, path: "/persistent/me/style.md" });
      await expect(tools.read_file.execute({ path: "/persistent/me/style.md" }, context)).resolves.toEqual({
        path: "/persistent/me/style.md",
        content: "Bullets.",
      });
      await expect(tools.list_files.execute({}, context)).resolves.toEqual({
        files: [{ path: "/persistent/me/style.md", bytes: 8 }],
      });
      await expect(tools.delete_file.execute({ path: "/persistent/me/style.md" }, context)).resolves.toMatchObject({
        ok: true,
      });
      await expect(tools.read_file.execute({ path: "/persistent/me/style.md" }, context)).rejects.toThrow("No file at");

      await expect(tools.read_file.execute({ path: "/session/notes.md" }, context)).rejects.toThrow(
        "outside your memory folders",
      );
      await expect(tools.write_file.execute({ path: "/persistent/me/../other/x.md", content: "x" }, context)).rejects.toThrow(
        "outside your memory folders",
      );
      await expect(tools.write_file.execute({ path: "style.md", content: "x" }, context)).rejects.toThrow(
        "absolute path",
      );
    });
  });

  it("refuses to change a folder that is read-only this turn", async () => {
    await withSession(async (files, session) => {
      const tools = createMemoryFileTools(resolveHarnessMemory(layers()).configs) as any;
      await files.writeText("/persistent/company/rule.md", "24 months");
      session.setReadOnlyPersistentDirs(["/persistent/company"]);
      const context = { files, session };

      await expect(
        tools.write_file.execute({ path: "/persistent/company/rule.md", content: "12 months" }, context),
      ).rejects.toThrow("/persistent/company is read-only in this conversation");
      await expect(tools.delete_file.execute({ path: "/persistent/company/rule.md" }, context)).rejects.toThrow(
        "read-only in this conversation",
      );
      await expect(tools.read_file.execute({ path: "/persistent/company/rule.md" }, context)).resolves.toMatchObject({
        content: "24 months",
      });
    });
  });
});

describe("load_skill (bash off)", () => {
  const skills: ResolvedSkill[] = [
    {
      name: "memory",
      description: "How to keep memories",
      harnessDir: ".agents/skills/memory",
      files: { "SKILL.md": encode("# Memory\n"), "examples/rule.md": encode("Example") },
    },
  ];

  it("returns a skill's SKILL.md and its other files on request", async () => {
    const tool = createLoadSkillTool(skills).load_skill as any;
    await expect(tool.execute({ name: "memory" }, {})).resolves.toEqual({
      name: "memory",
      file: "SKILL.md",
      content: "# Memory\n",
      otherFiles: ["examples/rule.md"],
    });
    await expect(tool.execute({ name: "memory", file: "./examples/rule.md" }, {})).resolves.toMatchObject({
      content: "Example",
    });
  });

  it("names the available skills when asked for one that does not exist", async () => {
    const tool = createLoadSkillTool(skills).load_skill as any;
    await expect(tool.execute({ name: "billing" }, {})).rejects.toThrow("Available skills: memory");
    await expect(tool.execute({ name: "memory", file: "nope.md" }, {})).rejects.toThrow("has no file nope.md");
  });
});
