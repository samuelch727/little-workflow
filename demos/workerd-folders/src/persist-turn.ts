/** Save partial progress once, retaining both causes if execution and persistence fail. */
export async function persistTurn<T>(run: () => Promise<T>, save: () => Promise<void>): Promise<T> {
  let result: T;
  try { result = await run(); }
  catch (turnError) {
    try { await save(); }
    catch (saveError) { throw new AggregateError([turnError, saveError], "Turn execution and file persistence both failed"); }
    throw turnError;
  }
  await save();
  return result;
}
