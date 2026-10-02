import { beforeEach, describe, expect, test } from "vitest";
import { clearChannelFeed, listChannelFeed } from "../channel-log";
import postToChannel from "./post-to-channel";
import replyInThread from "./reply-in-thread";

beforeEach(() => clearChannelFeed());

describe("Slack-only tools", () => {
  test("post-to-channel records a channel post", async () => {
    const output = await postToChannel.execute?.(
      { channel: "#releases", summary: "v4.2.0 is healthy in canary." },
      {} as never,
    );
    expect(output).toMatchObject({ kind: "channel-post", connector: "slack", channel: "#releases" });
    expect(listChannelFeed()).toEqual([
      expect.objectContaining({ kind: "channel-post", connector: "slack", channel: "#releases" }),
    ]);
  });

  test("reply-in-thread records a thread reply", async () => {
    await replyInThread.execute?.(
      { threadTs: "1700000000.0001", text: "On it — checking the canary metrics." },
      {} as never,
    );
    expect(listChannelFeed()).toEqual([
      expect.objectContaining({
        kind: "thread-reply",
        connector: "slack",
        threadTs: "1700000000.0001",
        text: "On it — checking the canary metrics.",
      }),
    ]);
  });
});
