/** Assert the fixture completed before accessing completion-only fields. */
export function assertCompletedTurn<T extends { status: string }>(turn: T): asserts turn is Extract<T, { status: "completed" }> {
  if (turn.status !== "completed") throw new Error(`Expected a completed turn; received ${turn.status}`);
}
