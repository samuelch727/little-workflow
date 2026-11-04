import { describe, expect, it } from "vitest";
import { triggerMetadata } from "./turn-trigger.js";

describe("triggerMetadata", () => {
  it("flattens a trigger into string metadata, leaving out fields that are not set", () => {
    expect(triggerMetadata({ kind: "schedule", source: "morning", label: "Work the backlog" })).toEqual({
      triggerKind: "schedule",
      triggerSource: "morning",
      triggerLabel: "Work the backlog",
    });
    expect(triggerMetadata({ kind: "cli", from: "" })).toEqual({ triggerKind: "cli" });
  });

  it("leaves out a trigger without a kind instead of failing the turn", () => {
    expect(triggerMetadata(undefined)).toBeUndefined();
    expect(triggerMetadata({ kind: "" })).toBeUndefined();
    expect(triggerMetadata({ source: "whatsapp" } as never)).toBeUndefined();
  });
});
