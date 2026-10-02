"use client";

import { CheckCircle2, Play, RadioTower, XCircle } from "lucide-react";

import { useState } from "react";

type ConnectorToolDemoResponse = {
  connectorId: "discord";
  toolName: "send-channel-update";
  discordToolNames: string[];
  webRichExposesTool: boolean;
  output: {
    delivered: boolean;
    connector: "discord";
    channel: string;
    audience: "internal_support";
    message: string;
    auditId: string;
  };
};

type DemoState = "idle" | "running" | "delivered" | "failed";

export function ConnectorToolDemo() {
  const [state, setState] = useState<DemoState>("idle");
  const [result, setResult] = useState<ConnectorToolDemoResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function runDemo() {
    setState("running");
    setError(undefined);

    try {
      const response = await fetch("/api/discord/tool-demo", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Demo request failed with ${response.status}.`);
      }
      const payload = (await response.json()) as ConnectorToolDemoResponse;
      setResult(payload);
      setState("delivered");
    } catch (caught) {
      setState("failed");
      setError(caught instanceof Error ? caught.message : "Demo request failed.");
    }
  }

  return (
    <section className="connector-tool-demo">
      <h2>Connector tool demo</h2>
      <div className="connector-tool-panel" data-state={state}>
        <div className="connector-tool-head">
          <RadioTower aria-hidden="true" size={18} />
          <div>
            <strong>send-channel-update</strong>
            <span>Discord only</span>
          </div>
        </div>

        <button disabled={state === "running"} onClick={() => void runDemo()} type="button">
          <Play aria-hidden="true" size={16} />
          {state === "running" ? "Running..." : "Run Discord tool"}
        </button>

        {result ? (
          <div className="connector-tool-result">
            <p>
              {result.output.delivered ? (
                <CheckCircle2 aria-hidden="true" size={16} />
              ) : (
                <XCircle aria-hidden="true" size={16} />
              )}
              <span>
                {result.output.connector} · {result.output.channel}
              </span>
            </p>
            <dl>
              <div>
                <dt>Message</dt>
                <dd>{result.output.message}</dd>
              </div>
              <div>
                <dt>Audit</dt>
                <dd>{result.output.auditId}</dd>
              </div>
              <div>
                <dt>Web rich</dt>
                <dd>{result.webRichExposesTool ? "also exposed" : "not exposed"}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {error ? <p className="connector-tool-error">{error}</p> : null}
      </div>
    </section>
  );
}
