import { describe, expect, it } from "vitest";

import { createHarnessFileMutationEvents } from "./file-events.js";

const before = { bytes: 3, sha256: "a".repeat(64) } as const;
const after = { bytes: 4, sha256: "b".repeat(64) } as const;
const occurrenceId = "file-mutation-1";

describe("canonical remote Harness file events", () => {
  it("serializes the same file and artifact vocabulary used by local writers", () => {
    expect(
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "updated",
        file: {
          path: "/artifacts/shot.png",
          bytes: after.bytes,
          mediaType: "image/png",
          sha256: after.sha256,
        },
        source: "tool",
        metadata: { purpose: "verification" },
        before,
        after,
        diff: { available: false, reason: "content_unavailable" },
        artifact: {
          id: "artifact-1",
          path: "/artifacts/shot.png",
          bytes: after.bytes,
          mediaType: "image/png",
          sha256: after.sha256,
          metadata: { purpose: "verification" },
        },
      }),
    ).toEqual([
      {
        type: "harness.file.updated",
        occurrenceId,
        metadata: {
          path: "/artifacts/shot.png",
          bytes: 4,
          mediaType: "image/png",
          sha256: "b".repeat(64),
          source: "tool",
          metadata: { purpose: "verification" },
          root: "artifacts",
          before,
          after,
          diff: { available: false, reason: "content_unavailable" },
        },
      },
      {
        type: "harness.file.written_by_tool",
        occurrenceId,
        metadata: {
          path: "/artifacts/shot.png",
          bytes: 4,
          mediaType: "image/png",
          sha256: "b".repeat(64),
          source: "tool",
          metadata: { purpose: "verification" },
          root: "artifacts",
          before,
          after,
          diff: { available: false, reason: "content_unavailable" },
        },
      },
      {
        type: "harness.artifact.created",
        occurrenceId,
        metadata: {
          path: "/artifacts/shot.png",
          bytes: 4,
          mediaType: "image/png",
          sha256: "b".repeat(64),
          source: "tool",
          metadata: { purpose: "verification" },
          artifact: {
            id: "artifact-1",
            path: "/artifacts/shot.png",
            bytes: 4,
            mediaType: "image/png",
            sha256: "b".repeat(64),
            metadata: { purpose: "verification" },
          },
        },
      },
    ]);
  });

  it("serializes deletion without inventing tool-write or artifact events", () => {
    expect(
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "deleted",
        file: { path: "/session/old.txt" },
        source: "tool",
        before,
        diff: { available: false, reason: "content_unavailable" },
      }),
    ).toEqual([
      {
        type: "harness.file.deleted",
        occurrenceId,
        metadata: {
          path: "/session/old.txt",
          source: "tool",
          root: "session",
          before,
          diff: { available: false, reason: "content_unavailable" },
        },
      },
    ]);
  });

  it("rejects contradictory or noncanonical adapter input", () => {
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "relative", bytes: after.bytes, sha256: after.sha256 },
        after,
        diff: {},
      }),
    ).toThrow(/absolute/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "updated",
        file: { path: "/session/x", bytes: after.bytes + 1, sha256: after.sha256 },
        before,
        after,
        diff: {},
      }),
    ).toThrow(/must match/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "deleted",
        file: { path: "/session/x" },
        before,
        after,
        diff: {},
      }),
    ).toThrow(/only a before/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        root: "artifacts",
        after,
        diff: {},
      }),
    ).toThrow(/root must match/u);
    const accessorDiff = Object.defineProperty({}, "available", {
      enumerable: true,
      get: () => false,
    });
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        after,
        diff: accessorDiff,
      }),
    ).toThrow(/enumerable data properties/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "deleted",
        file: { path: "/session/x", bytes: before.bytes + 1, sha256: before.sha256 },
        before,
        diff: {},
      }),
    ).toThrow(/before version/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        source: "x".repeat(1_025),
        after,
        diff: {},
      }),
    ).toThrow(/source exceeds/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        after,
        diff: { value: "x".repeat(64 * 1_024 + 1) },
      }),
    ).toThrow(/string exceeds/u);
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        after,
        diff: { value: "\u0000".repeat(50_000) },
      }),
    ).toThrow(/JSON limit/u);
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => "unsafe",
    });
    expect(() =>
      createHarnessFileMutationEvents({
        occurrenceId,
        kind: "created",
        file: { path: "/session/x", bytes: after.bytes, sha256: after.sha256 },
        after,
        diff: { values: accessorArray },
      }),
    ).toThrow(/dense enumerable data properties/u);
  });
});
