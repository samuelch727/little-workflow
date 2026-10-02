import crypto from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  authorizeDiscordGatewayRequest,
  discordGatewayDurationMs,
  discordGatewayWebhookUrl,
  isDiscordGatewayAdapter,
} from "./gateway-policy";

describe("Discord gateway policy", () => {
  test("requires a configured cron secret and bearer authorization", async () => {
    const request = new Request("https://support.example.test/api/discord/gateway");

    // Assert on status + body text rather than deep-equaling whole Response objects (which is
    // fragile: their ReadableStream bodies are distinct instances even for identical content).
    const notConfigured = authorizeDiscordGatewayRequest(request, {});
    expect(notConfigured?.status).toBe(500);
    expect(await notConfigured?.text()).toBe("CRON_SECRET not configured");

    const unauthorized = authorizeDiscordGatewayRequest(request, { CRON_SECRET: "secret" });
    expect(unauthorized?.status).toBe(401);
    expect(await unauthorized?.text()).toBe("Unauthorized");

    expect(
      authorizeDiscordGatewayRequest(
        new Request("https://support.example.test/api/discord/gateway", {
          headers: { authorization: "Bearer secret" },
        }),
        { CRON_SECRET: "secret" },
      ),
    ).toBeNull();
  });

  test("uses constant-time comparison for equal-length bearer tokens", async () => {
    const timingSafeEqual = vi.spyOn(crypto, "timingSafeEqual");

    try {
      const response = authorizeDiscordGatewayRequest(
        new Request("https://support.example.test/api/discord/gateway", {
          headers: { authorization: "Bearer secRet" },
        }),
        { CRON_SECRET: "secret" },
      );

      expect(response?.status).toBe(401);
      expect(await response?.text()).toBe("Unauthorized");
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    } finally {
      timingSafeEqual.mockRestore();
    }
  });

  test("builds the forwarded webhook URL from explicit env, Vercel URL, or request origin", () => {
    const request = new Request("https://local.example.test/api/discord/gateway");

    expect(
      discordGatewayWebhookUrl(request, {
        DISCORD_GATEWAY_WEBHOOK_URL: "https://bot.example.test/custom/discord",
      }),
    ).toBe("https://bot.example.test/custom/discord");
    expect(discordGatewayWebhookUrl(request, { VERCEL_URL: "support.example.test" })).toBe(
      "https://support.example.test/api/discord",
    );
    expect(discordGatewayWebhookUrl(request, {})).toBe("https://local.example.test/api/discord");
  });

  test("uses a ten minute default listener duration with an env override", () => {
    expect(discordGatewayDurationMs({})).toBe(600_000);
    expect(discordGatewayDurationMs({ DISCORD_GATEWAY_DURATION_MS: "120000" })).toBe(120_000);
    expect(discordGatewayDurationMs({ DISCORD_GATEWAY_DURATION_MS: "not-a-number" })).toBe(600_000);
  });

  test("recognizes adapters that can start a Gateway listener", () => {
    expect(isDiscordGatewayAdapter({ startGatewayListener: async () => new Response("ok") })).toBe(
      true,
    );
    expect(isDiscordGatewayAdapter({})).toBe(false);
  });
});
