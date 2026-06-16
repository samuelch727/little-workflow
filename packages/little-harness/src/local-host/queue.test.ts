import { describe, expect, it } from "vitest";
import { HarnessConcurrencyError } from "../errors.js";
import { LocalSessionQueue } from "./queue.js";

describe("LocalSessionQueue", () => {
  it("serializes work for the same session", async () => {
    const queue = new LocalSessionQueue({ sameSession: "queue" });
    const order: string[] = [];

    const first = queue.run("s1", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return 1;
    });

    const second = queue.run("s1", async () => {
      order.push("second-start");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("allows different sessions to run together", async () => {
    const queue = new LocalSessionQueue({ sameSession: "queue" });
    let running = 0;
    let peak = 0;

    await Promise.all([
      queue.run("s1", async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
      }),
      queue.run("s2", async () => {
        running += 1;
        peak = Math.max(peak, running);
        running -= 1;
      }),
    ]);

    expect(peak).toBe(2);
  });

  it("rejects same-session contention when configured", async () => {
    const queue = new LocalSessionQueue({ sameSession: "reject" });
    const first = queue.run("s1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await expect(queue.run("s1", async () => undefined)).rejects.toBeInstanceOf(
      HarnessConcurrencyError,
    );
    await first;
  });
});
