/**
 * In-memory record of what the Slack-only connector tools did, so the demo and
 * tests can verify channel posts and thread replies without a live Slack
 * workspace. In a real deployment the tools would also call the Slack Web API.
 *
 * IMPORTANT: connector tools are loaded through `little-harness/connectors/discovery`
 * via a dynamic `import()`, which lives in a SEPARATE module graph from the route
 * that statically imports this file (true in vitest and in Next.js). A plain
 * module-level array would therefore be duplicated and reads would come back
 * empty. We back the feed with `globalThis` so every instance shares one array.
 */
export type ChannelPost = {
  kind: "channel-post";
  connector: "slack";
  channel: string;
  summary: string;
  postedAt: string;
};

export type ThreadReply = {
  kind: "thread-reply";
  connector: "slack";
  threadTs: string;
  text: string;
  postedAt: string;
};

export type ChannelFeedEntry = ChannelPost | ThreadReply;

const FEED_KEY = "__conciergeSlackChannelFeed__";

function feed(): ChannelFeedEntry[] {
  const store = globalThis as Record<string, unknown>;
  if (!Array.isArray(store[FEED_KEY])) {
    store[FEED_KEY] = [] as ChannelFeedEntry[];
  }
  return store[FEED_KEY] as ChannelFeedEntry[];
}

export function recordChannelPost(entry: Omit<ChannelPost, "kind" | "connector" | "postedAt">): ChannelPost {
  const post: ChannelPost = { kind: "channel-post", connector: "slack", postedAt: nowIso(), ...entry };
  feed().push(post);
  return post;
}

export function recordThreadReply(entry: Omit<ThreadReply, "kind" | "connector" | "postedAt">): ThreadReply {
  const reply: ThreadReply = { kind: "thread-reply", connector: "slack", postedAt: nowIso(), ...entry };
  feed().push(reply);
  return reply;
}

export function listChannelFeed(): readonly ChannelFeedEntry[] {
  return [...feed()];
}

export function clearChannelFeed(): void {
  feed().length = 0;
}

// `Date.now()`/`new Date()` are fine in app/runtime code (only workflow scripts forbid them).
function nowIso(): string {
  return new Date().toISOString();
}
