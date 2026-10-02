/**
 * The mechanism that keeps a gate run out of littleDB's trace plane.
 *
 * `agents/librarian/littledb.ts` builds its handle ONLY when `LITTLEDB_URL` is set, and every
 * consumer goes through that one function: `connectors/slack/connector.ts` calls it at module
 * scope (that is where `reactions.sinks` comes from) and `load.ts` calls it in the stream
 * seam (that is where the event reporter comes from). Remove the variables before any agent
 * module loads and the telemetry half of the demo is structurally absent — not disabled by a
 * flag a later edit could forget, and not dependent on remembering to pass an option.
 *
 * It lives in its own module, taking the environment as an argument, so the guarantee is
 * testable without loading the driver, the agent, or a model.
 */

/** Every environment key a gate run must not leave behind. */
export const TELEMETRY_ENV_PREFIX = "LITTLEDB_";

/**
 * `LIBRARIAN_PROMPT_FILE` is not a `LITTLEDB_` variable but exists only to seed a littleDB
 * bootstrap, so a gate run has no business carrying it either.
 */
export const TELEMETRY_ENV_EXTRA = ["LIBRARIAN_PROMPT_FILE"];

export function telemetryEnvKeys(env) {
  return Object.keys(env).filter(
    (key) => key.startsWith(TELEMETRY_ENV_PREFIX) || TELEMETRY_ENV_EXTRA.includes(key),
  );
}

/** Delete them, and report exactly what was removed so the run log can say so. */
export function scrubLittleDbEnv(env = process.env) {
  const removed = telemetryEnvKeys(env);
  for (const key of removed) delete env[key];
  return removed;
}

/**
 * Refuse to continue if any of them came back. Called after the scrub AND after the agent
 * loads: an agent module that set `LITTLEDB_URL` itself would otherwise hand the next session
 * a live handle.
 */
export function assertNoLittleDbEnv(env = process.env, when = "") {
  const leaked = telemetryEnvKeys(env);
  if (leaked.length > 0) {
    throw new Error(
      `gate: ${leaked.join(", ")} present in the environment${when === "" ? "" : ` ${when}`} — a ` +
        "gate run would report outcomes into the trace plane and contaminate the held-out " +
        "set. Aborting.",
    );
  }
}
