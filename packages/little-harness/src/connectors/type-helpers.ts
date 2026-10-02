import type { InferToolInput, InferToolOutput, Tool, ToolUIPart } from "ai";

export type ToolInput<TTool extends Tool<any, any>> = InferToolInput<TTool>;
export type ToolOutput<TTool extends Tool<any, any>> = InferToolOutput<TTool>;

export type ToolUI<TTool extends Tool<any, any>> = {
  input: ToolInput<TTool>;
  output: ToolOutput<TTool>;
};

export type ToolPart<
  TName extends string,
  TTool extends Tool<any, any>,
> = ToolUIPart<Record<TName, ToolUI<TTool>>>;

export type ToolOutputPart<
  TName extends string,
  TTool extends Tool<any, any>,
> = Extract<ToolPart<TName, TTool>, { state: "output-available" }>;
