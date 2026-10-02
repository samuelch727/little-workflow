import { join } from "node:path";
import { loadConnectorToolExtensions } from "little-harness/connectors/discovery";
import { describe, expect, test } from "vitest";
import slackConnector from "../../../../agents/concierge/connectors/slack/connector";
import webConnector from "../../../../agents/concierge/connectors/web/connector";
import {
  CONCIERGE_WEB_CONNECTOR_ID,
  createConciergeWebConnectorLoadOptions,
} from "./web/route";
import {
  CONCIERGE_SLACK_CONNECTOR_ID,
  createConciergeSlackConnectorLoadOptions,
} from "./slack/connector";

const agentDir = join(process.cwd(), "agents", "concierge");

describe("concierge connector route wiring", () => {
  test("loads web and Slack connectors by descriptor + connectorId (enables discovery + tool extensions)", () => {
    expect(CONCIERGE_WEB_CONNECTOR_ID).toBe("web");
    expect(CONCIERGE_SLACK_CONNECTOR_ID).toBe("slack");
    // Typed descriptor object + connectorId, not a bare string id.
    expect(createConciergeWebConnectorLoadOptions().connector).toBe(webConnector);
    expect(createConciergeWebConnectorLoadOptions().connectorId).toBe(CONCIERGE_WEB_CONNECTOR_ID);
    expect(createConciergeSlackConnectorLoadOptions().connector).toBe(slackConnector);
    expect(createConciergeSlackConnectorLoadOptions().connectorId).toBe(CONCIERGE_SLACK_CONNECTOR_ID);
  });

  test("agentDir points at the concierge agent folder", () => {
    expect(createConciergeWebConnectorLoadOptions().agentDir).toMatch(/agents[/\\]concierge$/u);
    expect(createConciergeSlackConnectorLoadOptions().agentDir).toMatch(/agents[/\\]concierge$/u);
  });

  test("routes carry no manual tool whitelist — availability is structural", () => {
    // Availability is structural (global tools + connectors/<id>/tools/*) narrowed only by the
    // descriptor toolPolicy, so the routes pass no streamHarness override to whitelist tools.
    expect(createConciergeWebConnectorLoadOptions().streamHarness).toBeUndefined();
    expect(createConciergeSlackConnectorLoadOptions().streamHarness).toBeUndefined();
  });

  describe("structure-derived connector tool isolation", () => {
    test("the web connector folder exposes only render-dashboard", async () => {
      const tools = await loadConnectorToolExtensions(agentDir, "web", {});
      expect(Object.keys(tools)).toEqual(["render-dashboard"]);
    });

    test("the Slack connector folder exposes only its channel tools", async () => {
      const tools = await loadConnectorToolExtensions(agentDir, "slack", {});
      expect(Object.keys(tools).sort()).toEqual(["post-to-channel", "reply-in-thread"]);
    });

    test("Slack denies the global list-releases tool (blacklist)", () => {
      expect(slackConnector.toolPolicy).toEqual({ deny: ["list-releases"] });
    });
  });
});
