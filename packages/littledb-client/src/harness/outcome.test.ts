import { describe, expect, it, vi } from "vitest";
import { createOutcomeReporter } from "./outcome.js";

describe("createOutcomeReporter", () => {
  it("POSTs the outcome to the control plane with the api key and returns ok on 200", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://cp/api/outcomes");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
      expect(JSON.parse(String(init?.body))).toMatchObject({ runId: "run_1", status: "success", score: 0.9 });
      return Response.json({ ok: true });
    });
    const r = createOutcomeReporter({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never });
    expect(await r.report({ runId: "run_1", status: "success", score: 0.9, detail: "ok" })).toEqual({ ok: true });
  });

  it("is best-effort: returns {ok:false} on non-2xx and never throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const r = createOutcomeReporter({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never });
    expect(await r.report({ runId: "run_1", status: "failure" })).toEqual({ ok: false });
  });

  it("is best-effort: returns {ok:false} on a network error and never throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = createOutcomeReporter({ controlPlaneUrl: "http://cp", projectKey: "k", fetchImpl: fetchImpl as never });
    expect(await r.report({ runId: "run_1", status: "partial" })).toEqual({ ok: false });
  });
});
