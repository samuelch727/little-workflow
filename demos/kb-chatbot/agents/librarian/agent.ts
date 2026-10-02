import { createHarness, localDir, localHost, projectDir } from "little-harness";
import { dataDir, demoRoot, librarianModel } from "./env";
import { ensureKnowledgeBase } from "./knowledge";

ensureKnowledgeBase();

/**
 * "Librarian" — a company knowledge-base chatbot.
 *
 * `instructions.md` is the system prompt (picked up by `loadHarness`) AND the littleDB
 * bootstrap prompt, so the behaviour dreaming can improve — cite your source, consult the
 * catalog first, copy uploads into the shared KB — lives in ONE editable place.
 *
 * Files: an attachment on the inbound chat message is staged into `/session/uploads` by
 * the `chat.stageMessage` hook below. The hook deliberately does NOT write into
 * `/persistent/knowledge`: a host-side write bypasses the Persistent Dir change tracking,
 * so only the MODEL moving the file (a bash `cp`, tracked and committed after the turn)
 * actually publishes it to the shared knowledge base.
 */
export default createHarness({
  host: localHost({ dataDir, projectRoot: demoRoot }),
  model: librarianModel(),
  persistentDirs: [
    localDir({
      harnessDir: "/persistent/knowledge",
      // One static sourceDir — every thread reads and writes the same knowledge base.
      sourceDir: projectDir("knowledge"),
      commit: "after-turn",
    }),
  ],
  chat: {
    stageMessage: async ({ inputFiles, files }) => {
      const staged = [];
      for (const file of inputFiles) {
        staged.push({
          ...(await files.write(`/session/uploads/${file.safeName}`, file.content)),
          originalName: file.name,
        });
      }
      if (staged.length === 0) return {};
      return {
        stagedFiles: staged,
        notice: staged
          .map((file) => `Uploaded file staged at ${file.path}. Ingest it into the knowledge base.`)
          .join("\n"),
      };
    },
  },
});
