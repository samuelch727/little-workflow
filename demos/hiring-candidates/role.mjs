/**
 * Role resolution helpers for Phase 1 → Phase 2 hand-off.
 *
 * Pure (no I/O) so the post-vs-candidate discriminator and the defensive
 * fallback are unit-testable. The caller logs when a fallback occurs.
 */

import { buildDeterministicPost } from "./stub.mjs";

/** A post sub-run output is an object (not a candidate array) carrying a role_title. */
export function isPostOutput(output) {
  return (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    typeof output.role_title === "string"
  );
}

/**
 * Normalise a harvested hiring-post output into the role fields Phase 2 needs,
 * filling per-field defaults. Falls back to a deterministic role when the post
 * is missing/malformed (use `isPostOutput` to detect the fallback for logging).
 *
 * @param {unknown} out The harvested post sub-run output.
 * @returns {{ role_title: string, company: string, location: string, seniority_focus: string, role_brief: string, key_skills: string[], hiring_post_markdown: string }}
 */
export function resolveRole(out) {
  if (out && typeof out === "object" && typeof out.role_title === "string" && out.role_title.trim()) {
    return {
      role_title: out.role_title,
      company: typeof out.company === "string" ? out.company : "Unknown Co",
      location: typeof out.location === "string" ? out.location : "Unknown",
      seniority_focus: typeof out.seniority_focus === "string" ? out.seniority_focus : "Unknown",
      role_brief: typeof out.role_brief === "string" ? out.role_brief : out.role_title,
      key_skills: Array.isArray(out.key_skills) && out.key_skills.length ? out.key_skills : ["Communication"],
      hiring_post_markdown: typeof out.hiring_post_markdown === "string" ? out.hiring_post_markdown : "",
    };
  }
  return buildDeterministicPost();
}
