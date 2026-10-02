"use client";

import { CheckCircle2, Globe2, MessageSquareText, RefreshCw } from "lucide-react";
import { useState } from "react";

type ConnectorAttachment = {
  connectorId: string;
  delivery: string;
  endpoint: {
    id: string;
    platform?: string;
    threadId?: string;
    userId?: string;
    label?: string;
  };
};

type PortableDemoResponse = {
  surface: "web-rich" | "discord";
  sessionId: string;
  connectorToolNames: string[];
  connectors: ConnectorAttachment[];
  mirrorDeliveries: Array<{
    connectorId: string;
    sourceConnectorId: string;
    text: string;
  }>;
  channelUpdates: Array<{
    channel: string;
    message: string;
    auditId: string;
  }>;
  transcript: Array<{
    connectorId: "web-rich" | "discord";
    label: string;
    direction: "inbound" | "outbound" | "tool";
    text: string;
  }>;
  replyText?: string;
  postedText?: string;
  responseBytes?: number;
};

type RunState = "idle" | "running-web" | "running-discord" | "ready" | "failed";

export function PortableSessionDemo() {
  const [state, setState] = useState<RunState>("idle");
  const [webResult, setWebResult] = useState<PortableDemoResponse | undefined>();
  const [discordResult, setDiscordResult] = useState<PortableDemoResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function runTurn(kind: "web" | "discord") {
    setState(kind === "web" ? "running-web" : "running-discord");
    setError(undefined);

    try {
      const response = await fetch(`/api/portable-demo/${kind}`, { method: "POST" });
      if (!response.ok) throw new Error(`${kind} turn failed with ${response.status}.`);
      const payload = (await response.json()) as PortableDemoResponse;
      if (kind === "web") setWebResult(payload);
      else setDiscordResult(payload);
      setState("ready");
    } catch (caught) {
      setState("failed");
      setError(caught instanceof Error ? caught.message : "Portable demo failed.");
    }
  }

  const latest = discordResult ?? webResult;
  const latestChannelUpdate = discordResult?.channelUpdates.at(-1);
  const transcript = [
    ...(webResult?.transcript ?? [
      {
        connectorId: "web-rich" as const,
        label: "Web operator",
        direction: "inbound" as const,
        text:
          "Start the portable HelioSoft support session from the web command center.",
      },
    ]),
    ...(discordResult?.transcript ?? [
      {
        connectorId: "discord" as const,
        label: "Discord teammate",
        direction: "inbound" as const,
        text:
          "Continue the same portable support session from Discord and send a channel update.",
      },
    ]),
  ];

  return (
    <section className="portable-session-demo">
      <h2>Portable session demo</h2>
      <div className="portable-session-panel" data-state={state}>
        <div className="portable-session-id">
          <span>Session</span>
          <strong>{latest?.sessionId ?? "support:portable:heliosoft"}</strong>
        </div>

        <div className="portable-actions">
          <button
            disabled={state === "running-web" || state === "running-discord"}
            onClick={() => void runTurn("web")}
            type="button"
          >
            {state === "running-web" ? (
              <RefreshCw aria-hidden="true" size={16} />
            ) : (
              <Globe2 aria-hidden="true" size={16} />
            )}
            Run web turn
          </button>
          <button
            disabled={state === "running-web" || state === "running-discord"}
            onClick={() => void runTurn("discord")}
            type="button"
          >
            {state === "running-discord" ? (
              <RefreshCw aria-hidden="true" size={16} />
            ) : (
              <MessageSquareText aria-hidden="true" size={16} />
            )}
            Run Discord turn
          </button>
        </div>

        <div className="portable-lanes">
          <PortableLane label="Web rich" result={webResult} />
          <PortableLane label="Discord" result={discordResult} />
        </div>

        {latest ? (
          <div className="portable-connectors">
            {latest.connectors.map((connector) => (
              <div key={`${connector.connectorId}:${connector.endpoint.id}`}>
                <span>{connector.delivery}</span>
                <strong>{connector.connectorId}</strong>
                <small>{connector.endpoint.label ?? connector.endpoint.threadId ?? connector.endpoint.id}</small>
              </div>
            ))}
          </div>
        ) : null}

        <div className="portable-transcript">
          <h3>Portable transcript</h3>
          <div>
            {transcript.map((entry, index) => (
              <article
                data-direction={entry.direction}
                key={`${entry.connectorId}:${entry.direction}:${index}`}
              >
                <span>
                  {entry.label} · {entry.connectorId}
                </span>
                <p>{entry.text}</p>
              </article>
            ))}
          </div>
        </div>

        {latestChannelUpdate ?? discordResult?.postedText ? (
          <div className="portable-tool-output">
            <CheckCircle2 aria-hidden="true" size={16} />
            <div>
              <strong>{latestChannelUpdate?.channel ?? "Discord posted reply"}</strong>
              <span>{latestChannelUpdate?.auditId ?? "connector reply"}</span>
              <p>{latestChannelUpdate?.message ?? discordResult?.postedText}</p>
            </div>
          </div>
        ) : null}

        {error ? <p className="connector-tool-error">{error}</p> : null}
      </div>
    </section>
  );
}

function PortableLane({
  label,
  result,
}: {
  label: string;
  result?: PortableDemoResponse;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{result ? "done" : "waiting"}</strong>
      <small>
        {result?.surface === "discord"
          ? `${result.connectorToolNames.length} connector tools`
          : result?.responseBytes
            ? `${result.responseBytes} stream bytes`
            : "same harness"}
      </small>
    </div>
  );
}
