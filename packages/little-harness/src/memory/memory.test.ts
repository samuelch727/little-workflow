import { describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { wrapToolsWithHarnessContext } from "../runtime/tools.js";
import { withTempDir } from "../test/temp.js";
import type { FileWriter } from "../types.js";
import { buildMemorySystemContext, memory, resolveHarnessMemory } from "./memory.js";

describe("memory", () => {
  it("normalizes an opt-in memory store into a persistent dir and remember tool", () => {
    const resolved = resolveHarnessMemory(
      memory({
        sourceDir: "memory/db-query-agent",
        harnessDir: "/persistent/memory",
        now: () => new Date("2026-06-09T00:00:00.000Z"),
      }),
      {},
    );

    expect(resolved.configs).toHaveLength(1);
    expect(resolved.persistentDirs).toHaveLength(1);
    expect(resolved.persistentDirs[0]).toMatchObject({
      harnessDir: "/persistent/memory",
      commit: "after-turn",
    });
    expect(resolved.tools).toHaveProperty("remember");
    expect(resolved.configs[0]).toMatchObject({
      harnessDir: "/persistent/memory",
      indexPath: "MEMORY.md",
      toolName: "remember",
      maxIndexBytes: 8000,
      maxEntryBytes: 4000,
    });
  });

  it("does not add a remember tool for read-only memory", () => {
    const resolved = resolveHarnessMemory(
      memory({
        sourceDir: "memory/org",
        harnessDir: "/persistent/org-memory",
        commit: "read-only",
      }),
      {},
    );

    expect(resolved.persistentDirs[0]?.commit).toBe("read-only");
    expect(resolved.tools).toEqual({});
    expect(resolved.configs[0]?.toolName).toBeUndefined();
  });

  it("describes writable memory without a remember tool when tool is disabled", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          tool: false,
        }),
        {},
      );

      const context = await buildMemorySystemContext(resolved.configs, session.files);

      expect(resolved.persistentDirs[0]?.commit).toBe("after-turn");
      expect(resolved.tools).toEqual({});
      expect(resolved.configs[0]?.toolName).toBeUndefined();
      expect(context).toContain("Write durable memory files under /persistent/memory");
      expect(context).not.toContain("read-only");
      expect(context).not.toContain("Use remember");
    });
  });

  it("throws instead of overwriting an existing tool named remember", () => {
    expect(() =>
      resolveHarnessMemory(
        memory({ sourceDir: "memory/db-query-agent" }),
        { remember: {} as any },
      ),
    ).toThrow(HarnessInputError);
  });

  it("writes a markdown entry and updates the memory index when remember runs", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: session.files,
        artifacts: session.artifacts,
      });

      const result = await (tools.remember as any).execute(
        {
          memory: "Database query agent prefers indexed lookups for account history.",
          reason: "The user confirmed this optimization should persist.",
          topic: "db-query-agent",
        },
        {},
      );

      expect(result).toMatchObject({
        ok: true,
        indexPath: "/persistent/memory/MEMORY.md",
      });
      expect(result.path).toMatch(
        /^\/persistent\/memory\/entries\/2026-06-09\/db-query-agent-[a-f0-9]{12}\.md$/,
      );
      const entry = (await session.files.read(result.path)).text();
      expect(entry).toContain("Database query agent prefers indexed lookups");
      expect(entry).toContain("The user confirmed this optimization should persist.");
      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      expect(index).toContain("Database query agent prefers indexed lookups");
      expect(index).toContain(result.path.slice("/persistent/memory/".length));
    });
  });

  it("preserves both index bullets when remember runs concurrently", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: session.files,
        artifacts: session.artifacts,
      });

      await Promise.all([
        (tools.remember as any).execute({ memory: "First concurrent durable memory." }, {}),
        (tools.remember as any).execute({ memory: "Second concurrent durable memory." }, {}),
      ]);

      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      expect(index).toContain("First concurrent durable memory.");
      expect(index).toContain("Second concurrent durable memory.");
    });
  });

  it("preserves concurrent index bullets when index reads are delayed", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const delayedFiles = {
        ...session.files,
        read: async (path: string, options?: Parameters<FileWriter["read"]>[1]) => {
          if (path === "/persistent/memory/MEMORY.md") {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return session.files.read(path, options);
        },
      } as FileWriter;
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: delayedFiles,
        artifacts: session.artifacts,
      });

      await Promise.all([
        (tools.remember as any).execute({ memory: "Delayed first durable memory." }, {}),
        (tools.remember as any).execute({ memory: "Delayed second durable memory." }, {}),
      ]);

      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      expect(index).toContain("Delayed first durable memory.");
      expect(index).toContain("Delayed second durable memory.");
    });
  });

  it("bounds the persisted memory index while retaining newest entries", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          maxIndexBytes: 220,
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: session.files,
        artifacts: session.artifacts,
      });

      const first = await (tools.remember as any).execute(
        { memory: "OLDEST_MEMORY_SENTINEL durable index lesson.", topic: "oldest" },
        {},
      );
      await (tools.remember as any).execute(
        { memory: "Middle durable lesson with enough text to pressure the bounded index.", topic: "middle" },
        {},
      );
      const newest = await (tools.remember as any).execute(
        { memory: "NEWEST_MEMORY_SENTINEL durable index lesson.", topic: "newest" },
        {},
      );

      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      expect(new TextEncoder().encode(index).byteLength).toBeLessThanOrEqual(220);
      expect(index).toContain("# Memory Index");
      expect(index).toContain("NEWEST_MEMORY_SENTINEL");
      expect(index).toContain(newest.path.slice("/persistent/memory/".length));
      expect(index).not.toContain("OLDEST_MEMORY_SENTINEL");
      expect((await session.files.read(first.path)).text()).toContain("OLDEST_MEMORY_SENTINEL");
      expect((await session.files.read(newest.path)).text()).toContain("NEWEST_MEMORY_SENTINEL");
    });
  });

  it("includes the trailing newline in the persisted memory index byte limit", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          maxIndexBytes: 64,
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: session.files,
        artifacts: session.artifacts,
      });

      await (tools.remember as any).execute(
        {
          memory: "A long durable lesson that forces the memory index to truncate at the exact byte boundary.",
          topic: "byte-limit",
        },
        {},
      );

      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      expect(new TextEncoder().encode(index).byteLength).toBeLessThanOrEqual(64);
      expect(index).toContain("# Memory Index");
    });
  });

  it("returns no memory system context when no memory stores are configured", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });

      await expect(buildMemorySystemContext([], session.files)).resolves.toBeUndefined();
    });
  });

  it("builds memory system context from existing index content", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      await session.files.writeText(
        "/persistent/memory/MEMORY.md",
        "# Memory Index\n- billing_invoices: Keep invoice status by account.\n",
      );
      const resolved = resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent" }), {});
      const context = await buildMemorySystemContext(resolved.configs, session.files);

      expect(context).toContain("# Memory");
      expect(context).toContain("Long-term memory is mounted at /persistent/memory.");
      expect(context).toContain("Use remember to save durable facts");
      expect(context).toContain("billing_invoices");
    });
  });

  it("truncates memory index content with a marker", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      await session.files.writeText("/persistent/memory/MEMORY.md", `# Memory Index\n${"x".repeat(200)}`);
      const context = await buildMemorySystemContext(
        [
          {
            harnessDir: "/persistent/memory",
            commit: "after-turn",
            indexPath: "MEMORY.md",
            maxIndexBytes: 64,
            maxEntryBytes: 4000,
            toolName: "remember",
          },
        ],
        session.files,
      );

      expect(context).toContain("[Memory index truncated]");
    });
  });

  it("builds bounded memory context from newest index content", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      await session.files.writeText(
        "/persistent/memory/MEMORY.md",
        [
          "# Memory Index",
          "- 2026-06-07: [old](entries/2026-06-07/old.md) - OLDEST_CONTEXT_SENTINEL should be omitted.",
          "- 2026-06-08: [middle](entries/2026-06-08/middle.md) - middle filler ".repeat(4),
          "- 2026-06-09: [new](entries/2026-06-09/new.md) - NEWEST_CONTEXT_SENTINEL should remain.",
          "",
        ].join("\n"),
      );
      const context = await buildMemorySystemContext(
        [
          {
            harnessDir: "/persistent/memory",
            commit: "after-turn",
            indexPath: "MEMORY.md",
            maxIndexBytes: 150,
            maxEntryBytes: 4000,
            toolName: "remember",
          },
        ],
        session.files,
      );

      expect(context).toContain("NEWEST_CONTEXT_SENTINEL");
      expect(context).toContain("[Memory index truncated]");
      expect(context).not.toContain("OLDEST_CONTEXT_SENTINEL");
    });
  });

  it("rethrows non-missing read errors while building memory context", async () => {
    const files = {
      read: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    } as unknown as FileWriter;

    await expect(
      buildMemorySystemContext(
        [
          {
            harnessDir: "/persistent/memory",
            commit: "after-turn",
            indexPath: "MEMORY.md",
            maxIndexBytes: 8000,
            maxEntryBytes: 4000,
          },
        ],
        files,
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects invalid memory config options early", () => {
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", harnessDir: "/session/memory" }), {}),
    ).toThrow(HarnessInputError);
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", indexPath: "../MEMORY.md" }), {}),
    ).toThrow(HarnessInputError);
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", indexPath: "" }), {}),
    ).toThrow(HarnessInputError);
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", maxIndexBytes: 0 }), {}),
    ).toThrow(HarnessInputError);
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", maxEntryBytes: 0 }), {}),
    ).toThrow(HarnessInputError);
  });

  it("canonicalizes safe memory harnessDir equivalents and rejects escapes", () => {
    for (const harnessDir of ["/persistent/./memory", "/persistent//memory", "/persistent/foo/../memory"]) {
      const resolved = resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", harnessDir }), {});
      expect(resolved.configs[0]?.harnessDir).toBe("/persistent/memory");
      expect(resolved.persistentDirs[0]?.harnessDir).toBe("/persistent/memory");
    }

    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", harnessDir: "/persistent/../session/memory" }), {}),
    ).toThrow(HarnessInputError);
  });

  it("rejects invalid memory commit values at runtime", () => {
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory", commit: "sometimes" as any }), {}),
    ).toThrow(HarnessInputError);
  });

  it("rejects absolute index paths but allows nested relative index paths", () => {
    expect(() =>
      resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent", indexPath: "/MEMORY.md" }), {}),
    ).toThrow(HarnessInputError);

    const resolved = resolveHarnessMemory(
      memory({ sourceDir: "memory/db-query-agent", indexPath: "notes/MEMORY.md" }),
      {},
    );
    expect(resolved.configs[0]?.indexPath).toBe("notes/MEMORY.md");
  });

  it("rejects invalid memory tool names", () => {
    for (const name of ["bash", "__proto__", "bad name"]) {
      expect(() =>
        resolveHarnessMemory(
          memory({
            sourceDir: "memory/db-query-agent",
            tool: { name },
          }),
          {},
        ),
      ).toThrow(HarnessInputError);
    }
  });

  it("rejects whitespace-only memories before creating entries", async () => {
    const resolved = resolveHarnessMemory(memory({ sourceDir: "memory/db-query-agent" }), {});
    const remember = resolved.tools.remember as any;

    await expect(remember.inputSchema.validate({ memory: "   " })).resolves.toMatchObject({
      success: false,
    });
  });

  it("sanitizes topic text so generated index lines stay one markdown link", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const resolved = resolveHarnessMemory(
        memory({
          sourceDir: "memory/db-query-agent",
          now: () => new Date("2026-06-09T12:34:56.000Z"),
        }),
        {},
      );
      const tools = wrapToolsWithHarnessContext(resolved.tools, {
        session,
        files: session.files,
        artifacts: session.artifacts,
      });

      await (tools.remember as any).execute(
        {
          memory: "Durable fact for generated index.",
          topic: "topic\n[bad](url): value",
        },
        {},
      );

      const index = (await session.files.read("/persistent/memory/MEMORY.md")).text();
      const bulletLines = index.split("\n").filter((line) => line.startsWith("- 2026-06-09:"));
      expect(bulletLines).toHaveLength(1);
      expect(index).not.toContain("topic\n");
      expect(bulletLines[0]).toContain("Durable fact for generated index.");
      expect(bulletLines[0]).toMatch(/\]\(entries\/2026-06-09\/topic-bad-url-value-[a-f0-9]{12}\.md\)/);
    });
  });
});
