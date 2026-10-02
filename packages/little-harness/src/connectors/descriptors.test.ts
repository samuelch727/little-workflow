import { describe, expect, expectTypeOf, it } from "vitest";
import {
  chatSdkConnector,
  isChatSdkConnector,
  isWebRichConnector,
  webRichConnector,
  type ConnectorDeliveryOptions,
  type ConnectorHistoryPolicy,
} from "./descriptors.js";

// @ts-expect-error Chat SDK connectors do not receive raw web request messages; use webRichConnector for request history.
const chatSdkRequestHistory: ConnectorHistoryPolicy = { source: "request" };
void chatSdkRequestHistory;

// Mirror stickiness policy is threaded through loader delivery options.
const mirrorDelivery: ConnectorDeliveryOptions = { previousActive: "mirror" };
void mirrorDelivery;

describe("connector descriptors", () => {
  it("brands Chat SDK connector descriptors", () => {
    const descriptor = chatSdkConnector({
      userName: "support",
      adapter: { name: "slack", create: () => ({ name: "slack" }) },
      state: () => ({ connect: async () => {} }),
    });

    expect(descriptor.kind).toBe("chat-sdk");
    expect(isChatSdkConnector(descriptor)).toBe(true);
    expect(isWebRichConnector(descriptor)).toBe(false);
  });

  it("preserves typed extraBody inside Chat SDK history callbacks", () => {
    chatSdkConnector<{ userId: string }>({
      userName: "support",
      adapter: { name: "slack", create: () => ({ name: "slack" }) },
      state: () => ({}),
      history: async (ctx) => {
        expectTypeOf(ctx.extraBody).toEqualTypeOf<{ userId: string } | undefined>();
        return [];
      },
    });
  });

  it("rejects the removed transport option on Chat SDK connectors", () => {
    const descriptor = chatSdkConnector({
      userName: "support",
      adapter: { name: "slack", create: () => ({ name: "slack" }) },
      state: () => ({}),
      // @ts-expect-error transport was removed from Chat SDK connector options.
      transport: { mode: "webhook" },
    });
    expect(descriptor.kind).toBe("chat-sdk");
  });

  it("accepts a descriptor-owned deliverer on both connector kinds", () => {
    const chat = chatSdkConnector<{ userId: string }>({
      userName: "support",
      adapter: { name: "slack", create: () => ({ name: "slack" }) },
      state: () => ({}),
      deliver: async (ctx) => {
        expectTypeOf(ctx.text).toEqualTypeOf<string>();
        // `deliver` is invoked with the ACTIVE surface's extraBody, not this connector's own
        // `TExtraBody`, so `ctx.extraBody` is intentionally `unknown` (see the descriptor caveat).
        expectTypeOf(ctx.extraBody).toEqualTypeOf<unknown>();
      },
    });
    const web = webRichConnector({
      authenticate: async () => ({ id: "u1" }),
      session: ({ body }) => body.id,
      deliver: async () => {},
    });

    expect(typeof chat.deliver).toBe("function");
    expect(typeof web.deliver).toBe("function");
  });

  it("brands web-rich connector descriptors", () => {
    const descriptor = webRichConnector({
      authenticate: async () => ({ id: "user_1" }),
      session: ({ body, user }) => `web:${user.id}:${body.id}`,
    });

    expect(descriptor.kind).toBe("web-rich");
    expect(isWebRichConnector(descriptor)).toBe(true);
    expect(isChatSdkConnector(descriptor)).toBe(false);
  });
});
