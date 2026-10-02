"use client";

import { Send } from "lucide-react";
import { useState } from "react";

type ConnectorId = "web-rich" | "discord";
type ChatRole = "user" | "assistant" | "tool";

type ChatMessage = {
  id: string;
  role: ChatRole;
  connectorId: ConnectorId;
  text: string;
  toolName?: "send-channel-update";
};

type ChatResult = {
  surface: ConnectorId;
  sessionId: string;
  messages: ChatMessage[];
  availableTools: string[];
};

type ChatPanelState = {
  messages: ChatMessage[];
  input: string;
  busy: boolean;
  error?: string;
};

const initialWebInput = "What tools are available to you in the web connector?";
const initialDiscordInput = "What tools are available to you in the Discord connector?";

export function ConnectorChatDemo() {
  const [web, setWeb] = useState<ChatPanelState>({
    messages: [],
    input: initialWebInput,
    busy: false,
  });
  const [discord, setDiscord] = useState<ChatPanelState>({
    messages: [],
    input: initialDiscordInput,
    busy: false,
  });

  async function send(kind: "web" | "discord") {
    const state = kind === "web" ? web : discord;
    const setState = kind === "web" ? setWeb : setDiscord;
    const connectorId: ConnectorId = kind === "web" ? "web-rich" : "discord";
    const text = state.input.trim();
    if (text.length === 0 || state.busy) return;

    const optimistic: ChatMessage = {
      id: `${connectorId}-pending-user`,
      role: "user",
      connectorId,
      text,
    };
    setState({ ...state, busy: true, error: undefined, messages: [optimistic], input: "" });

    try {
      const response = await fetch(`/api/chat-demo/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) throw new Error(`${kind} chat failed with ${response.status}.`);
      const result = (await response.json()) as ChatResult;
      setState({
        busy: false,
        error: undefined,
        input: "",
        messages: result.messages,
      });
    } catch (caught) {
      setState({
        ...state,
        busy: false,
        error: caught instanceof Error ? caught.message : "Chat request failed.",
        messages: [optimistic],
      });
    }
  }

  return (
    <main className="chat-demo-shell">
      <section className="chat-demo-board" aria-label="Connector chat demo">
        <ChatPanel
          connectorId="web-rich"
          description="General web support chat"
          label="Web Chat"
          onInput={(input) => setWeb((state) => ({ ...state, input }))}
          onSend={() => void send("web")}
          placeholder="Web message"
          state={web}
          submitLabel="Send web message"
        />
        <ChatPanel
          connectorId="discord"
          description="Discord connector chat"
          label="Discord Chat"
          onInput={(input) => setDiscord((state) => ({ ...state, input }))}
          onSend={() => void send("discord")}
          placeholder="Discord message"
          state={discord}
          submitLabel="Send Discord message"
        />
      </section>
    </main>
  );
}

function ChatPanel({
  connectorId,
  description,
  label,
  onInput,
  onSend,
  placeholder,
  state,
  submitLabel,
}: {
  connectorId: ConnectorId;
  description: string;
  label: string;
  onInput: (input: string) => void;
  onSend: () => void;
  placeholder: string;
  state: ChatPanelState;
  submitLabel: string;
}) {
  return (
    <section className="chat-demo-panel" data-connector={connectorId}>
      <header>
        <div>
          <h1>{label}</h1>
          <span>{description}</span>
        </div>
        <strong>{connectorId}</strong>
      </header>

      <div className="chat-demo-messages" aria-label={`${label} messages`}>
        {state.messages.length === 0 ? (
          <div className="chat-demo-empty">
            <p>Send a message to the harness.</p>
          </div>
        ) : (
          state.messages.map((message) => (
            <article
              className={`chat-demo-message chat-demo-message-${message.role}`}
              key={message.id}
            >
              <span>
                {message.role === "tool"
                  ? `${message.toolName} · ${message.connectorId}`
                  : `${message.role} · ${message.connectorId}`}
              </span>
              <p>{message.text}</p>
            </article>
          ))
        )}
        {state.busy ? (
          <article className="chat-demo-message chat-demo-message-assistant">
            <span>assistant · {connectorId}</span>
            <p>Thinking...</p>
          </article>
        ) : null}
      </div>

      {state.error ? <p className="chat-demo-error">{state.error}</p> : null}

      <form
        className="chat-demo-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          aria-label={placeholder}
          disabled={state.busy}
          onChange={(event) => onInput(event.currentTarget.value)}
          placeholder={placeholder}
          rows={3}
          value={state.input}
        />
        <button aria-label={submitLabel} disabled={state.busy} title={submitLabel} type="submit">
          <Send aria-hidden="true" size={18} />
        </button>
      </form>
    </section>
  );
}
