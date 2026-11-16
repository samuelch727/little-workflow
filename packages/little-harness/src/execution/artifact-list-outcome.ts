import type { ArtifactRef, HarnessSession, HarnessWarning } from "../types.js";

/** Artifact discovery is best-effort after a model has finished, never a model failure. */
export async function listTerminalArtifacts(
  session: HarnessSession,
  warnings: HarnessWarning[],
): Promise<ArtifactRef[]> {
  try {
    return await session.artifacts.list();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : undefined;
    // Do not expose filesystem paths or error contents through the user-facing warning.
    warnings.push({
      code: "artifact_list_warning",
      message: "The answer completed, but artifacts could not be listed.",
      metadata: { stage: "artifact_list", ...(code === undefined ? {} : { code }) },
    });
    return [];
  }
}
