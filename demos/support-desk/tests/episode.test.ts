import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readActions, readDb } from "../agents/support/episode";
import { setSupportModel } from "../agents/support/env";
import { runEpisode } from "../agents/support/run-episode";
import { scriptedModel, unparseableSuccessError, type ScriptedModel } from "./support/mock-model";

/**
 * The episode loop itself: does a scripted conversation reach the tools, does the second turn
 * see the first, and can two episodes running through the same loaded agent touch each
 * other's data?
 *
 * That last question is the one that would silently corrupt every score. The agent folder is
 * loaded ONCE per process (jiti's module cache is process-wide), so every scenario in a run
 * shares one harness and one set of tool closures; the only thing separating them is the
 * `sessionId -> episode dir` binding in `episode.ts`.
 */

const ROOT = mkdtempSync(join(tmpdir(), "support-episode-"));
let model: ScriptedModel;

beforeAll(() => {
  model = scriptedModel({ steps: [] });
  setSupportModel(model);
  process.env.SUPPORT_DATA_DIR = join(ROOT, ".little-harness");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.SUPPORT_DATA_DIR;
});

it("runs a scripted episode through the real tools and records both stores", async () => {
  model.setScript({
    steps: [
      { toolCalls: [{ toolName: "read_policy", input: {} }] },
      {
        toolCalls: [
          { toolName: "lookup_order", input: { orderId: "ORD-1001", email: "ada.whitfield@example.com" } },
        ],
      },
      {
        toolCalls: [
          { toolName: "refund_order", input: { orderId: "ORD-1001", amount: 129, reason: "in window" } },
        ],
      },
      { text: "Refunded $129.00 to your original payment method." },
    ],
  });

  const result = await runEpisode({
    sessionId: "smoke-1",
    episodeDir: join(ROOT, "smoke-1"),
    turns: ["Hi, I'd like to return ORD-1001. My email is ada.whitfield@example.com."],
  });

  expect(result.toolCalls).toEqual(["read_policy", "lookup_order", "refund_order"]);
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0]?.assistant).toContain("Refunded");

  // The store: the refund really happened.
  const db = readDb(result.episodeDir);
  expect(db.refunds.map((refund) => [refund.orderId, refund.amount])).toEqual([
    ["ORD-1011", 64],
    ["ORD-1021", 68],
    ["ORD-1001", 129],
  ]);
  expect(db.orders.find((order) => order.id === "ORD-1001")?.refunded).toBe(true);

  // The log: every call, in order, with the fields the compliance grader keys on.
  const actions = readActions(result.episodeDir);
  expect(actions.map((action) => action.tool)).toEqual([
    "read_policy",
    "lookup_order",
    "refund_order",
  ]);
  expect(actions[1]?.outcome).toMatchObject({ orderId: "ORD-1001", emailVerified: true });
  expect(actions.map((action) => action.seq)).toEqual([1, 2, 3]);
});

it("carries the conversation forward: turn 2's model sees turn 1", async () => {
  model.setScript({
    steps: [
      { text: "Could you confirm the email on the account?" },
      {
        toolCalls: [
          { toolName: "lookup_order", input: { orderId: "ORD-1013", email: "gita.rahman@example.com" } },
        ],
      },
      { text: "Thanks — verified." },
    ],
  });

  const result = await runEpisode({
    sessionId: "smoke-2",
    episodeDir: join(ROOT, "smoke-2"),
    turns: ["I want to return ORD-1013.", "It's gita.rahman@example.com."],
  });

  expect(result.turns).toHaveLength(2);
  expect(result.turnsWithheld).toBe(0);
  // The second turn's prompt carries the whole thread: both user turns and the first answer.
  const second = model.prompts.at(-1) ?? "";
  expect(second).toContain("I want to return ORD-1013.");
  expect(second).toContain("Could you confirm the email on the account?");
  expect(second).toContain("gita.rahman@example.com");
});

it("withholds the remaining scripted turns when the episode is already resolved", async () => {
  model.setScript({
    steps: [
      {
        toolCalls: [
          {
            toolName: "decline_request",
            input: { orderId: "ORD-1002", reason: "out-of-window", explanation: "70 days." },
          },
        ],
      },
      { text: "That order is outside the 30-day window." },
    ],
  });

  const result = await runEpisode({
    sessionId: "smoke-3",
    episodeDir: join(ROOT, "smoke-3"),
    turns: ["Refund ORD-1002 please.", "That's not right — I already told you it just arrived."],
    shouldSendTurn: () => false,
  });

  expect(result.turns).toHaveLength(1);
  expect(result.turnsWithheld).toBe(1);
  // The withheld pushback is not in the transcript, so nothing downstream — including a
  // pushback detector reading the trace — can see words the customer never said.
  expect(JSON.stringify(result.turns)).not.toContain("That's not right");
});

it("keeps two episodes' databases fully separate", async () => {
  const scriptFor = (orderId: string, amount: number) => ({
    steps: [
      {
        toolCalls: [
          { toolName: "refund_order", input: { orderId, amount, reason: "isolation check" } },
        ],
      },
      { text: "Done." },
    ],
  });

  model.setScript(scriptFor("ORD-1001", 129));
  const first = await runEpisode({
    sessionId: "iso-1",
    episodeDir: join(ROOT, "iso-1"),
    turns: ["Refund ORD-1001."],
  });

  model.setScript(scriptFor("ORD-1013", 58));
  const second = await runEpisode({
    sessionId: "iso-2",
    episodeDir: join(ROOT, "iso-2"),
    turns: ["Refund ORD-1013."],
  });

  const firstDb = readDb(first.episodeDir);
  const secondDb = readDb(second.episodeDir);

  // Each episode sees its own refund and NOT the other's — including the seed's two, which
  // both start from, proving the second run began from the seed rather than from run one's
  // end state.
  expect(firstDb.refunds.map((refund) => refund.orderId)).toEqual([
    "ORD-1011",
    "ORD-1021",
    "ORD-1001",
  ]);
  expect(secondDb.refunds.map((refund) => refund.orderId)).toEqual([
    "ORD-1011",
    "ORD-1021",
    "ORD-1013",
  ]);
  expect(readActions(first.episodeDir)).toHaveLength(1);
  expect(readActions(second.episodeDir)).toHaveLength(1);

  // And the tracked seed is untouched by any of it.
  const seed = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "seed-data", "db.json"), "utf8"),
  ) as { refunds: unknown[] };
  expect(seed.refunds).toHaveLength(2);
});

it("retries the transport failure the AI SDK will not retry", async () => {
  model.setScript({
    steps: [
      { toolCalls: [{ toolName: "read_policy", input: {} }] },
      { text: "Read it." },
    ],
  });
  model.failNext(unparseableSuccessError());

  const result = await runEpisode({
    sessionId: "retry-1",
    episodeDir: join(ROOT, "retry-1"),
    turns: ["What is the refund window?"],
  });

  // The wrapper is really in the agent's path: the model threw an unparseable 200 on the
  // first call and the episode still completed, on the same script, one step later.
  expect(result.turns[0]?.assistant).toBe("Read it.");
  expect(model.calls.steps).toBe(2);
}, 30_000);
