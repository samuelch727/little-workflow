import crypto from "node:crypto";

export const DISCORD_GATEWAY_DEFAULT_DURATION_MS = 600_000;
export const DISCORD_WEBHOOK_PATH = "/api/discord";

type GatewayEnv = Partial<Record<string, string>>;

export type DiscordGatewayAdapter = {
  startGatewayListener(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
};

export function authorizeDiscordGatewayRequest(
  request: Request,
  env: GatewayEnv = process.env,
): Response | null {
  const cronSecret = env.CRON_SECRET ?? env.DISCORD_GATEWAY_SECRET;
  if (cronSecret === undefined || cronSecret.length === 0) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }

  if (!matchesBearerSecret(request.headers.get("authorization"), cronSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

function matchesBearerSecret(authorization: string | null, secret: string): boolean {
  if (authorization === null) return false;

  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function discordGatewayDurationMs(env: GatewayEnv = process.env): number {
  const parsed = Number(env.DISCORD_GATEWAY_DURATION_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DISCORD_GATEWAY_DEFAULT_DURATION_MS;
}

export function discordGatewayWebhookUrl(
  request: Request,
  env: GatewayEnv = process.env,
): string {
  if (env.DISCORD_GATEWAY_WEBHOOK_URL !== undefined && env.DISCORD_GATEWAY_WEBHOOK_URL.length > 0) {
    return env.DISCORD_GATEWAY_WEBHOOK_URL;
  }

  const baseUrl =
    env.VERCEL_URL !== undefined && env.VERCEL_URL.length > 0
      ? `https://${env.VERCEL_URL}`
      : new URL(request.url).origin;
  return new URL(DISCORD_WEBHOOK_PATH, baseUrl).toString();
}

export function isDiscordGatewayAdapter(value: unknown): value is DiscordGatewayAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { startGatewayListener?: unknown }).startGatewayListener === "function"
  );
}
