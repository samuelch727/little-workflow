import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "../trace/options.js";
import { stageChatMessages } from "./stage-message.js";

describe("stageChatMessages", () => {
  it("stages file parts from raw UIMessage input once by default", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const messages = [
        {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "Review this." },
            {
              type: "file",
              filename: "report.pdf",
              mediaType: "application/pdf",
              data: new TextEncoder().encode("pdf"),
            },
          ],
        },
      ] as unknown as UIMessage[];

      const result = await stageChatMessages({
        messages,
        session,
        files: session.files,
        chat: {
          stageMessage: async ({ message, inputFiles, files }) => ({
            stagedFiles: await Promise.all(
              inputFiles.map((file) =>
                files.write(`/session/user-input/${message.id}/${file.safeName}`, file.content),
              ),
            ),
            notice: "File staged.",
          }),
        },
      });

      expect(result.notices).toEqual(["File staged."]);
      expect((await session.files.read("/session/user-input/m1/report.pdf")).text()).toBe("pdf");

      const second = await stageChatMessages({
        messages,
        session,
        files: session.files,
        chat: {
          stageMessage: async () => {
            throw new Error("should not restage");
          },
        },
      });
      expect(second.notices).toEqual([]);
      expect(second.stripStagedFileParts).toBe(true);

      const alreadyStagedWithoutData = await stageChatMessages({
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [
              { type: "text", text: "Review this." },
              {
                type: "file",
                filename: "report.pdf",
                mediaType: "application/pdf",
              },
            ],
          },
        ] as unknown as UIMessage[],
        session,
        files: session.files,
        chat: {
          stageMessage: async () => {
            throw new Error("should not restage");
          },
        },
      });
      expect(alreadyStagedWithoutData.notices).toEqual([]);
      expect(alreadyStagedWithoutData.stripStagedFileParts).toBe(true);
    });
  });

  it("signals file stripping when a handler stages files without a notice", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const messages = [
        {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "Review this." },
            {
              type: "file",
              filename: "report.txt",
              mediaType: "text/plain",
              data: new TextEncoder().encode("report"),
            },
          ],
        },
      ] as unknown as UIMessage[];

      const result = await stageChatMessages({
        messages,
        session,
        files: session.files,
        chat: {
          stageMessage: async ({ message, inputFiles, files }) => ({
            stagedFiles: await Promise.all(
              inputFiles.map((file) =>
                files.write(`/session/user-input/${message.id}/${file.safeName}`, file.content),
              ),
            ),
          }),
        },
      });

      expect(result.notices).toEqual([]);
      expect(result.stripStagedFileParts).toBe(true);
    });
  });

  it("redacts staged-message metadata and emits file metadata for trace validation", async () => {
    await withTempDir(async (dir) => {
      const hostPaths = resolveLocalHostPaths({ dataDir: dir }, dir);
      const session = await new LocalSessionStore(hostPaths).getOrCreate({ id: "chat" });
      const events: any[] = [];
      const messages = [
        {
          id: "m1",
          role: "user",
          parts: [
            {
              type: "file",
              filename: "report.txt",
              mediaType: "text/plain",
              data: new TextEncoder().encode("file"),
            },
          ],
        },
      ] as unknown as UIMessage[];

      await stageChatMessages({
        messages,
        session,
        files: session.files,
        traceOptions: resolveTraceOptions(undefined, undefined),
        emit: async (event) => {
          events.push(event);
        },
        chat: {
          stageMessage: async ({ message, inputFiles, files }) => ({
            stagedFiles: await Promise.all(
              inputFiles.map((file) =>
                files.write(`/session/user-input/${message.id}/${file.safeName}`, file.content),
              ),
            ),
            metadata: { authorization: "stage-secret", safe: "visible" },
          }),
        },
      });

      expect(events.find((event) => event.type === "harness.file.staged_from_message")).toMatchObject({
        metadata: {
          path: "/session/user-input/m1/report.txt",
          root: "session",
          source: "user-message",
          safe: "visible",
          authorization: "[redacted]",
          after: { bytes: 4, sha256: expect.any(String) },
        },
      });
      expect(JSON.stringify(events)).not.toContain("stage-secret");
    });
  });
});
