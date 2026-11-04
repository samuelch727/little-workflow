/** Match native filesystem error codes without changing an existing error contract. */
export function filesystemError(error: unknown): unknown {
  if (!(error instanceof Error) || ("code" in error && error.code !== undefined)) return error;
  const code = /^(E[A-Z0-9_]+):/u.exec(error.message)?.[1];
  if (code === undefined) return error;
  try {
    return Object.assign(error, { code });
  } catch {
    return Object.assign(new Error(error.message, { cause: error }), { code });
  }
}
