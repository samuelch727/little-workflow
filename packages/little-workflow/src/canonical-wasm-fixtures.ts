/** Plan-like JSON fixtures shared by Node and the one-off workerd acceptance witness. */
export const canonicalWasmHashFixtures = [
  {
    name: "tool-plan",
    value: {
      workflowId: "words.count", input: { text: "hello world" },
      steps: [{ id: "count", type: "tool.call", tool: "word_count", input: { text: "hello world" } }],
    },
    sha256Hex: "c0ec4e31f05d6385c20aa07c7c5c9d5039e63e4ca2f7d9924e20529afa4b4baa",
  },
  {
    name: "model-output",
    value: {
      id: "summarize",
      steps: [{
        id: "draft", type: "ai.generate", model: "default",
        output: {
          mode: "object",
          schema: {
            type: "object", properties: { summary: { type: "string" } },
            required: ["summary"], additionalProperties: false,
          },
        },
      }],
      return: "${steps.draft.output}",
    },
    sha256Hex: "17a38da18925efc15b5a194888d83f8275d9bd9e49daecc5131eb5e6e111839f",
  },
  {
    name: "unicode-input",
    value: { input: { text: "中文 😀", empty: "", active: true, limit: 3, extra: null }, models: ["default", "fast"] },
    sha256Hex: "828f8a9ed9625ff42278430879a051d17be2547d936132137cd512f2c68dfa2e",
  },
  {
    name: "kept-receipt",
    value: {
      keptPlan: { steps: [{ id: "first", needs: [], input: [1, 2, 3] }, { id: "next", needs: ["first"], output: { ok: true } }] },
      receipt: { appendIdempotencyKey: "receipt_1", sequence: 7, sha256: "sha256:example" },
    },
    sha256Hex: "b3c1eaebd4bd7c4c9b74068b388a74a583cd55e6c4370351ccc24057b2818bce",
  },
] as const;
