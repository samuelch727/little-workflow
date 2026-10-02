import { describe, expect, test } from "vitest";

/**
 * Live DeepSeek smoke. Skipped unless RUN_LIVE=1 (so it never hits the API in CI
 * or normal `pnpm test`). Run with:
 *   RUN_LIVE=1 DEEPSEEK_MODEL_ID=deepseek-v4-flash pnpm vitest run src/app/api/concierge/concierge-live.test.ts
 */
const live = process.env.RUN_LIVE === "1";

describe.skipIf(!live)("concierge live DeepSeek smoke", () => {
  test("web connector: model renders a json-render dashboard", async () => {
    const { POST } = await import("./web/route");
    const request = new Request("https://concierge.example.test/api/concierge/web", {
      method: "POST",
      headers: { "content-type": "application/json", "x-concierge-user-id": "live-smoke" },
      body: JSON.stringify({
        id: "live-web",
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "Show me the v4.2.0 release status as a dashboard." }],
          },
        ],
      }),
    });
    const response = await POST(request);
    const text = await response.text();
    // eslint-disable-next-line no-console
    console.log("[web smoke] stream length:", text.length, "has render-dashboard:", text.includes("render-dashboard"));
    expect(text).toContain("render-dashboard");
  }, 60_000);

  test("STRETCH: can DeepSeek author a full json-render spec? (generative mode)", async () => {
    const { generateObject } = await import("ai");
    const { validateSpec } = await import("@json-render/core");
    const { catalog } = await import("../../../../agents/concierge/ui/catalog");
    const { getConciergeModel } = await import("../../../../agents/concierge/env");
    const { z } = await import("zod");

    const elementSchema = z.object({
      type: z.string(),
      props: z.record(z.string(), z.any()).optional(),
      children: z.array(z.string()).optional(),
    });
    const specSchema = z.object({ root: z.string(), elements: z.record(z.string(), elementSchema) });

    let outcome = "unknown";
    try {
      const { object } = await generateObject({
        model: getConciergeModel(),
        schema: specSchema,
        system: catalog.prompt({ system: "You are a release dashboard builder." }),
        prompt: "Build a dashboard for release v4.2.0: stage canary, healthy, error rate 0.4%, incident INC-198.",
      });
      const valid = validateSpec(object as never).valid;
      outcome = `generated; validateSpec.valid=${valid}; elements=${Object.keys((object as { elements?: object }).elements ?? {}).length}`;
    } catch (error) {
      outcome = `threw: ${(error as Error).message.slice(0, 200)}`;
    }
    if (process.env.LIVE_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.LIVE_OUT, `[generative stretch] ${outcome}\n`, { flag: "a" });
    }
    expect(outcome).not.toBe("unknown");
  }, 60_000);

  test("slack connector: model posts to a channel", async () => {
    const { runConciergeSlackSimulation } = await import("./slack/simulate/route");
    const result = await runConciergeSlackSimulation({
      message: "Post the v4.2.0 release status to the #releases channel.",
    });
    // eslint-disable-next-line no-console
    console.log("[slack smoke] reply:", result.reply, "feed:", JSON.stringify(result.channelFeed));
    expect(result.connectorTools).toEqual(
      expect.arrayContaining(["post-to-channel", "reply-in-thread"]),
    );
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.channelFeed.length).toBeGreaterThan(0);
  }, 60_000);
});
