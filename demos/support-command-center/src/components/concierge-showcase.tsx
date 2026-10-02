"use client";

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { ChannelFeedEntry } from "../../agents/concierge/connectors/slack/channel-log";
import { RenderDashboardToolPart } from "../../agents/concierge/ui/tool-parts/render-dashboard";
import type { ConciergeUIMessage, RenderDashboardOutputPart } from "../../agents/concierge/ui/types";

const WEB_SAMPLE = "Show me the v4.2.0 release status as a dashboard.";
const SLACK_SAMPLE = "Post the v4.2.0 release status to the #releases channel.";

// Display-only labels (not a policy). Availability is derived from structure:
// global tools (get-release-status, list-releases) + each connector's own tools,
// with Slack opting out of list-releases via its descriptor's toolPolicy.deny.
const WEB_TOOLS = ["get-release-status", "list-releases", "render-dashboard"] as const;
const SLACK_TOOLS = ["get-release-status", "post-to-channel", "reply-in-thread"] as const;

function ToolBadges({ tools }: { tools: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((tool) => (
        <span
          key={tool}
          className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
        >
          {tool}
        </span>
      ))}
    </div>
  );
}

export function WebMessage({ message }: { message: ConciergeUIMessage }) {
  return (
    <div className={`rounded-lg p-2 text-sm ${message.role === "user" ? "bg-neutral-100" : ""}`}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {message.role}
      </div>
      {message.parts.map((part, index) => {
        if (part.type === "text" && part.text.trim().length > 0) {
          return (
            <p key={`${message.id}:t:${index}`} className="whitespace-pre-wrap text-neutral-800">
              {part.text}
            </p>
          );
        }
        if (part.type === "tool-render-dashboard") {
          if (part.state === "output-available") {
            return (
              <RenderDashboardToolPart
                key={`${message.id}:d:${index}`}
                part={part as RenderDashboardOutputPart}
              />
            );
          }
          return (
            <p key={`${message.id}:d:${index}`} className="text-xs text-neutral-400">
              Rendering dashboard…
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}

function WebPanel() {
  const [input, setInput] = useState(WEB_SAMPLE);
  const { messages, sendMessage, status } = useChat<ConciergeUIMessage>({
    transport: new DefaultChatTransport<ConciergeUIMessage>({ api: "/api/concierge/web" }),
  });
  const busy = status === "streaming" || status === "submitted";

  return (
    <section className="flex flex-col rounded-xl border border-neutral-200 bg-white">
      <header className="border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">Web (json-render)</h2>
        <p className="text-xs text-neutral-500">
          Rich generative UI — the agent renders a dashboard via the web-only{" "}
          <code className="font-mono">render-dashboard</code> tool.
        </p>
        <div className="mt-2">
          <ToolBadges tools={WEB_TOOLS} />
        </div>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ minHeight: 280 }}>
        {messages.length === 0 ? (
          <p className="text-sm text-neutral-400">Ask for a release status to see a rendered dashboard.</p>
        ) : (
          messages.map((message) => <WebMessage key={message.id} message={message} />)
        )}
      </div>
      <form
        className="flex gap-2 border-t border-neutral-200 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim().length === 0 || busy) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask the concierge…"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function ChannelEntry({ entry }: { entry: ChannelFeedEntry }) {
  return (
    <div className="rounded-md bg-white p-2 text-sm shadow-sm">
      <div className="mb-0.5 text-[11px] font-semibold text-neutral-500">
        {entry.kind === "channel-post" ? `posted to ${entry.channel}` : `reply in thread ${entry.threadTs}`}
      </div>
      <p className="text-neutral-800">{entry.kind === "channel-post" ? entry.summary : entry.text}</p>
    </div>
  );
}

function SlackPanel() {
  const [input, setInput] = useState(SLACK_SAMPLE);
  const [feed, setFeed] = useState<ChannelFeedEntry[]>([]);
  const [reply, setReply] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function run() {
    if (input.trim().length === 0 || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/concierge/slack/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: input }),
      });
      const data = (await response.json()) as {
        reply?: string;
        channelFeed?: ChannelFeedEntry[];
        connectorTools?: string[];
        error?: string;
      };
      if (data.error) {
        setError(data.error);
        return;
      }
      setReply(data.reply ?? "");
      setFeed(data.channelFeed ?? []);
      setTools(data.connectorTools ?? []);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col rounded-xl border border-neutral-200 bg-[#f8f4f9]">
      <header className="border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">Slack</h2>
        <p className="text-xs text-neutral-500">
          Channel text — the same agent posts via the Slack-only{" "}
          <code className="font-mono">post-to-channel</code> /{" "}
          <code className="font-mono">reply-in-thread</code> tools (synthetic event, no creds).
        </p>
        <div className="mt-2">
          <ToolBadges tools={SLACK_TOOLS} />
        </div>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ minHeight: 280 }}>
        <div className="text-xs font-semibold text-neutral-500"># releases</div>
        {feed.length === 0 ? (
          <p className="text-sm text-neutral-400">Ask the concierge to post an update to a channel.</p>
        ) : (
          feed.map((entry, index) => <ChannelEntry key={index} entry={entry} />)
        )}
        {reply ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-2 text-sm text-neutral-600">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              relay
            </span>
            <p>{reply}</p>
          </div>
        ) : null}
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        {tools.length > 0 ? (
          <p className="text-[11px] text-neutral-400">connector tools seen: {tools.join(", ")}</p>
        ) : null}
      </div>
      <form
        className="flex gap-2 border-t border-neutral-200 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask the concierge…"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-[#611f69] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Posting…" : "Send"}
        </button>
      </form>
    </section>
  );
}

/**
 * Side-by-side connector showcase: one agent ("Relay"), two connectors. The same
 * prompt produces a rich json-render dashboard on the web surface and a channel
 * post on the Slack surface — driven entirely by which connector-specific tools
 * each connector exposes.
 */
export function ConciergeShowcase() {
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-neutral-900">Connector Showcase — Relay</h1>
        <p className="text-sm text-neutral-600">
          One agent, two real connectors, platform-native tools. Web renders generative UI with{" "}
          <a className="underline" href="https://json-render.dev/" target="_blank" rel="noreferrer">
            json-render
          </a>
          ; Slack posts to channels.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <WebPanel />
        <SlackPanel />
      </div>
    </main>
  );
}
