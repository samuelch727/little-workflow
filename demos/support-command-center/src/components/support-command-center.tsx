"use client";

import { useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { AlertTriangle, Clock3, MessageSquare, Search, Send, Square, Workflow } from "lucide-react";
import { DefaultChatTransport } from "ai";
import { SupportMessage } from "../../agents/support/ui/support-message";
import type { SupportUIMessage } from "../../agents/support/ui/types";
import { ConnectorToolDemo } from "./connector-tool-demo";
import { PortableSessionDemo } from "./portable-session-demo";

const cases = [
  {
    id: "tic_helio_refund_1042",
    customer: "HelioSoft Global",
    tier: "enterprise",
    issue: "Duplicate support charge and renewal risk",
    severity: "high",
    age: "2d",
  },
  {
    id: "tic_northstar_delay_1187",
    customer: "Northstar Launch Co.",
    tier: "growth",
    issue: "Launch kit shipment missed event setup",
    severity: "medium",
    age: "18h",
  },
  {
    id: "tic_atlas_incident_2201",
    customer: "Atlas Labs",
    tier: "enterprise",
    issue: "Workflow runtime write failures",
    severity: "urgent",
    age: "43m",
  },
] as const;

const promptTemplates = [
  {
    label: "Refund policy check",
    text: "Look up HelioSoft Global, summarize ticket tic_helio_refund_1042, review order ord_helio_2026_06, and evaluate whether a $9,200 refund is allowed for a duplicate annual support charge.",
  },
  {
    label: "Shipment rescue",
    text: "Investigate Northstar Launch Co. and propose a support response for their delayed launch kit shipment.",
  },
  {
    label: "Incident escalation",
    text: "Check Atlas Labs service status, summarize their ticket history, and create an urgent engineering escalation with evidence from the active incident.",
  },
] as const;

type CaseId = (typeof cases)[number]["id"];

function statusLabel(status: string) {
  if (status === "streaming") return "Streaming";
  if (status === "submitted") return "Submitted";
  return "Ready";
}

export function SupportCommandCenter() {
  const [input, setInput] = useState("");
  const [activeCase, setActiveCase] = useState<CaseId>(cases[0].id);
  const { messages, sendMessage, status, stop, error } = useChat<SupportUIMessage>({
    transport: new DefaultChatTransport<SupportUIMessage>({
      api: "/api/chat",
    }),
  });
  const busy = status === "streaming" || status === "submitted";

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === activeCase) ?? cases[0],
    [activeCase],
  );

  function submitText(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    void sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <main className="console-shell">
      <aside className="case-rail" aria-label="Support case queue">
        <div className="console-brand">
          <Workflow aria-hidden="true" size={22} />
          <div>
            <p>Support Command Center</p>
            <span>customer operations</span>
          </div>
        </div>

        <div className="case-search">
          <Search aria-hidden="true" size={16} />
          <span>Queue filter</span>
        </div>

        <div className="case-list">
          {cases.map((item) => (
            <button
              className={item.id === activeCase ? "case-item case-item-active" : "case-item"}
              key={item.id}
              onClick={() => setActiveCase(item.id)}
              type="button"
            >
              <span>{item.customer}</span>
              <strong>{item.issue}</strong>
              <small>
                {item.severity} · {item.tier} · {item.age}
              </small>
            </button>
          ))}
        </div>
      </aside>

      <section className="conversation-pane" aria-label="Support agent conversation">
        <header className="conversation-header">
          <div>
            <p>Active case</p>
            <h1>{selectedCase.customer}</h1>
            <span>{selectedCase.issue}</span>
          </div>
          <div className="status-pill">
            <span data-busy={busy} />
            {statusLabel(status)}
          </div>
        </header>

        <div className="prompt-strip" aria-label="Suggested support prompts">
          {promptTemplates.map((prompt) => (
            <button
              disabled={busy}
              key={prompt.label}
              onClick={() => submitText(prompt.text)}
              type="button"
            >
              {prompt.label}
            </button>
          ))}
        </div>

        <div className="message-scroll">
          {messages.length === 0 ? (
            <div className="empty-thread">
              <MessageSquare aria-hidden="true" size={28} />
              <h2>Ask the support agent</h2>
              <p>
                Use the queue context or a prompt above to run customer, order, service,
                refund, and escalation tools.
              </p>
            </div>
          ) : (
            messages.map((message) => <SupportMessage key={message.id} message={message} />)
          )}
        </div>

        {error ? <p className="error-line">{error.message}</p> : null}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitText(input);
          }}
        >
          <textarea
            aria-label="Message"
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="Ask about a customer, refund, order, incident, or escalation..."
            rows={3}
            value={input}
          />
          {busy ? (
            <button aria-label="Stop response" onClick={() => void stop()} title="Stop response" type="button">
              <Square aria-hidden="true" size={18} />
            </button>
          ) : (
            <button aria-label="Send message" title="Send message" type="submit">
              <Send aria-hidden="true" size={18} />
            </button>
          )}
        </form>
      </section>

      <aside className="inspector-pane" aria-label="Case inspector">
        <section>
          <h2>Customer signals</h2>
          <div className="metric-grid">
            <div>
              <span>Renewal</span>
              <strong>30d</strong>
            </div>
            <div>
              <span>Risk</span>
              <strong>{selectedCase.severity}</strong>
            </div>
            <div>
              <span>Open</span>
              <strong>2</strong>
            </div>
            <div>
              <span>SLA</span>
              <strong>{selectedCase.severity === "urgent" ? "15m" : "1h"}</strong>
            </div>
          </div>
        </section>

        <section>
          <h2>Connector surfaces</h2>
          <div className="surface-row">
            <MessageSquare aria-hidden="true" size={18} />
            <div>
              <strong>Web rich</strong>
              <span>full typed tool cards</span>
            </div>
          </div>
          <div className="surface-row">
            <AlertTriangle aria-hidden="true" size={18} />
            <div>
              <strong>Discord</strong>
              <span>read-only tool summaries</span>
            </div>
          </div>
        </section>

        <ConnectorToolDemo />
        <PortableSessionDemo />

        <section>
          <h2>Next action</h2>
          <div className="next-action">
            <Clock3 aria-hidden="true" size={18} />
            <p>Run context tools, confirm policy evidence, then draft the operator response.</p>
          </div>
        </section>
      </aside>
    </main>
  );
}
