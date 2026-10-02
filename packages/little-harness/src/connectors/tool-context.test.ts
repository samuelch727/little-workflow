import { tool } from "ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import type { HarnessSession, HarnessToolExecutionContext } from "../types.js";
import { chatSdkConnector, webRichConnector } from "./descriptors.js";
import type { ChatSdkConnectorDescriptor, WebRichConnectorDescriptor } from "./descriptors.js";
import {
  loadChatSdkConnector,
  type LoadChatSdkConnectorOptions,
  type LoadedChatSdkConnector,
} from "./chat-sdk.js";
import {
  loadWebRichConnector,
  type LoadWebRichConnectorOptions,
  type LoadedWebRichConnector,
} from "./web-rich.js";
import {
  harnessToolContext,
  tryHarnessToolContext,
  type HarnessToolCallContext,
} from "./tool-context.js";

// A minimal object that structurally satisfies the "spread harness context" check (session + files).
function fakeToolCallOptions(): Record<string, unknown> {
  return {
    toolCallId: "call_1",
    messages: [],
    session: { id: "s1" },
    files: {},
    artifacts: {},
    connector: {
      id: "slack",
      kind: "chat-sdk",
      endpoint: { id: "slack:T1", platform: "slack", threadId: "T1", userId: "u1" },
    },
    extraBody: { userId: "u1" },
  };
}

describe("harnessToolContext", () => {
  it("returns the spread harness context when session and files are present", () => {
    const options = fakeToolCallOptions();
    const ctx = harnessToolContext(options);
    expect(ctx).toBe(options);
    expect(ctx.connector?.endpoint?.threadId).toBe("T1");
  });

  it("throws a HarnessInputError with a hint when executed outside a Little Harness run", () => {
    expect(() => harnessToolContext({ toolCallId: "call_1", messages: [] })).toThrow(
      /outside a Little Harness run/u,
    );
    expect(() => harnessToolContext(undefined)).toThrow(HarnessInputError);
    try {
      harnessToolContext({});
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessInputError);
      expect((error as HarnessInputError).details?.hint).toBeTypeOf("string");
    }
  });
});

describe("tryHarnessToolContext", () => {
  it("returns the context when present and undefined otherwise", () => {
    const options = fakeToolCallOptions();
    expect(tryHarnessToolContext(options)).toBe(options);
    expect(tryHarnessToolContext({ toolCallId: "x", messages: [] })).toBeUndefined();
    expect(tryHarnessToolContext(null)).toBeUndefined();
  });
});

describe("tool-context typing", () => {
  it("typechecks the documented connector-tool authoring pattern with zero casts", () => {
    // Never invoked — this exists purely for `tsc --noEmit` (tsconfig includes test files).
    const build = () =>
      tool({
        description: "Post a reply back to the originating channel.",
        inputSchema: z.object({ channel: z.string() }),
        execute: async ({ channel }, options) => {
          const ctx = harnessToolContext<{ userId: string }>(options);
          expectTypeOf(ctx.connector?.endpoint?.threadId).toEqualTypeOf<string | undefined>();
          expectTypeOf(ctx.extraBody).toEqualTypeOf<{ userId: string } | undefined>();
          expectTypeOf(ctx).toEqualTypeOf<HarnessToolExecutionContext<{ userId: string }>>();
          return { channel };
        },
      });
    void build;
  });

  it("exposes both the AI SDK call options and the harness context on HarnessToolCallContext", () => {
    const check = (ctx: HarnessToolCallContext<{ userId: string }>) => {
      expectTypeOf(ctx.toolCallId).toEqualTypeOf<string>();
      expectTypeOf(ctx.session).toEqualTypeOf<HarnessSession>();
      expectTypeOf(ctx.extraBody).toEqualTypeOf<{ userId: string } | undefined>();
      expectTypeOf(ctx.connector?.endpoint?.threadId).toEqualTypeOf<string | undefined>();
    };
    void check;
  });

  it("infers loader generics from descriptor references and falls back to unknown for strings", () => {
    const check = async () => {
      const typedChat = chatSdkConnector<{ userId: string }>({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
      });
      const loadedChat = await loadChatSdkConnector({ agentDir: "a", connector: typedChat });
      const loadedChatString = await loadChatSdkConnector({ agentDir: "a", connector: "slack" });
      expectTypeOf(loadedChat).toEqualTypeOf<LoadedChatSdkConnector<{ userId: string }>>();
      expectTypeOf(loadedChat.descriptor).toEqualTypeOf<ChatSdkConnectorDescriptor<{ userId: string }>>();
      expectTypeOf(loadedChatString).toEqualTypeOf<LoadedChatSdkConnector<unknown>>();

      const typedWeb = webRichConnector<{ id: string }, { userId: string }>({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
      });
      const loadedWeb = await loadWebRichConnector({ agentDir: "a", connector: typedWeb });
      const loadedWebString = await loadWebRichConnector({ agentDir: "a", connector: "web" });
      expectTypeOf(loadedWeb).toEqualTypeOf<LoadedWebRichConnector<{ id: string }, { userId: string }>>();
      expectTypeOf(loadedWeb.descriptor).toEqualTypeOf<
        WebRichConnectorDescriptor<{ id: string }, { userId: string }>
      >();
      expectTypeOf(loadedWebString).toEqualTypeOf<LoadedWebRichConnector>();
    };
    void check;
  });

  it("keeps previously-compiling loader call shapes valid via the general overload", () => {
    type MyBody = { userId: string };
    const check = async () => {
      // Explicit generic paired with a STRING ref — regressed to a compile error before the final
      // general overload was restored.
      const explicitChatString = await loadChatSdkConnector<MyBody>({ agentDir: "a", connector: "discord" });
      expectTypeOf(explicitChatString).toEqualTypeOf<LoadedChatSdkConnector<MyBody>>();

      // A value typed as the EXPORTED options type (whose `connector` is the string | descriptor
      // union) matched neither narrowed overload before.
      const chatOptions: LoadChatSdkConnectorOptions<MyBody> = { agentDir: "a", connector: "discord" };
      const fromChatOptions = await loadChatSdkConnector(chatOptions);
      expectTypeOf(fromChatOptions).toEqualTypeOf<LoadedChatSdkConnector<MyBody>>();

      // Descriptor-first inference still wins: a descriptor object infers TExtraBody from itself.
      const typedChat = chatSdkConnector<MyBody>({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
      });
      const fromDescriptor = await loadChatSdkConnector({ agentDir: "a", connector: typedChat });
      expectTypeOf(fromDescriptor).toEqualTypeOf<LoadedChatSdkConnector<MyBody>>();

      // web-rich mirrors all three shapes.
      const explicitWebString = await loadWebRichConnector<{ id: string }, MyBody>({
        agentDir: "a",
        connector: "web",
      });
      expectTypeOf(explicitWebString).toEqualTypeOf<LoadedWebRichConnector<{ id: string }, MyBody>>();

      const webOptions: LoadWebRichConnectorOptions<{ id: string }, MyBody> = {
        agentDir: "a",
        connector: "web",
      };
      const fromWebOptions = await loadWebRichConnector(webOptions);
      expectTypeOf(fromWebOptions).toEqualTypeOf<LoadedWebRichConnector<{ id: string }, MyBody>>();

      const typedWeb = webRichConnector<{ id: string }, MyBody>({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
      });
      const fromWebDescriptor = await loadWebRichConnector({ agentDir: "a", connector: typedWeb });
      expectTypeOf(fromWebDescriptor).toEqualTypeOf<LoadedWebRichConnector<{ id: string }, MyBody>>();
    };
    void check;
  });
});
