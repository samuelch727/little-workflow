import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, localHost } from "little-harness";
import type { StreamHarnessFinished, StreamHarnessOptions } from "little-harness/execution";
import { afterEach, describe, expect, test } from "vitest";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function mockHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "concierge-slack-"));
  tempDirs.push(dataDir);
  return createHarness({ host: localHost({ dataDir }), model });
}

/**
 * A stubbed harness turn that exercises the Slack-only `post-to-channel` tool the
 * way the real model would, then posts a reply — so we can verify the connector
 * wiring and channel feed without a live DeepSeek call.
 */
function slackToolStub(reply: string) {
  return (options: StreamHarnessOptions<any, any>): any => {
    const postTool = options.connectorTools?.["post-to-channel"] as
      | { execute?: (input: unknown, ctx: unknown) => Promise<unknown> }
      | undefined;
    const text = Promise.resolve().then(async () => {
      await postTool?.execute?.(
        { channel: "#releases", summary: "v4.2.0 is healthy in canary." },
        { connector: options.connector },
      );
      return reply;
    });
    return {
      text,
      output: text,
      textStream: (async function* () {
        yield await text;
      })(),
      toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }),
      toUIMessageStreamResponse: () => new Response(""),
      finished: text.then(
        () =>
          ({
            status: "completed",
            session: {} as any,
            artifacts: [],
            trace: { id: "slack-sim-test" },
            persistence: { status: "not-configured" },
            warnings: [],
            commitManual: async () => ({ status: "not-configured" }),
          }) satisfies StreamHarnessFinished,
      ),
    };
  };
}

describe("concierge Slack connector (synthetic event)", () => {
  test("exposes the Slack-only tools and records a channel post", async () => {
    const { runConciergeSlackSimulation } = await import("./simulate/route");
    const harness = await mockHarness();

    const result = await runConciergeSlackSimulation(
      { message: "Post the v4.2.0 release status to #releases." },
      { streamHarness: slackToolStub("Posted the v4.2.0 status to #releases."), loadHarness: async () => harness },
    );

    expect(result.connectorTools).toEqual(
      expect.arrayContaining(["post-to-channel", "reply-in-thread"]),
    );
    expect(result.sessionId).toBe("concierge:slack:sim");
    expect(result.reply).toBe("Posted the v4.2.0 status to #releases.");
    expect(result.channelFeed).toEqual([
      expect.objectContaining({ kind: "channel-post", connector: "slack", channel: "#releases" }),
    ]);
    // render-dashboard is web-only, so it must never appear on the Slack connector.
    expect(result.connectorTools).not.toContain("render-dashboard");
  }, 20_000);
});
