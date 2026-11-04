import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { inboxPrepareStep } from "./inbox.js";

const user = (content: string): ModelMessage => ({ role: "user", content });

describe("inboxPrepareStep", () => {
  it("places each arrival where it arrived, on every step and in a parked turn's conversation", async () => {
    const queue: string[] = [];
    const { prepareStep, withArrived } = inboxPrepareStep((async () => undefined) as never, { take: () => queue.splice(0) });
    const step = (messages: ModelMessage[]) => (prepareStep as (event: unknown) => unknown)({ messages }) as Promise<{ messages?: ModelMessage[] } | undefined>;

    expect(await step([user("a")])).toBeUndefined();
    queue.push("b", "c");
    expect((await step([user("a"), user("tool")]))?.messages).toEqual([user("a"), user("tool"), user("b"), user("c")]);
    // The next step's messages come without the arrivals; they are placed again.
    expect((await step([user("a"), user("tool"), user("reply")]))?.messages).toEqual([
      user("a"), user("tool"), user("b"), user("c"), user("reply"),
    ]);
    expect(withArrived([user("a"), user("tool"), user("reply"), user("more")])).toEqual([
      user("a"), user("tool"), user("b"), user("c"), user("reply"), user("more"),
    ]);
  });

  it("changes nothing without an inbox", async () => {
    const original = async () => ({ activeTools: ["x"] });
    const { prepareStep, withArrived } = inboxPrepareStep(original as never, undefined);
    expect(prepareStep).toBe(original);
    expect(withArrived([user("a")])).toEqual([user("a")]);
  });
});
