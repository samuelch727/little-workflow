const SUPPORTED_VARIANTS = new Set([
  "single",
  "supervisor",
  "stub",
  "stub-supervisor",
]);

export function parseVariant(rawVariant) {
  const variant = typeof rawVariant === "string" && rawVariant.length > 0
    ? rawVariant
    : "single";
  if (!SUPPORTED_VARIANTS.has(variant)) {
    throw new Error(
      `Unknown variant: ${variant}. Use 'single', 'supervisor', 'stub', or 'stub-supervisor'.`,
    );
  }

  const useStubPlanner = variant === "stub" || variant === "stub-supervisor";
  const useSupervisorLoop = variant === "supervisor" || variant === "stub-supervisor";

  return {
    variant,
    useStubPlanner,
    useSupervisorLoop,
    workflowId: useSupervisorLoop
      ? "candidate.review.supervised"
      : "candidate.review.single-cycle",
    maxCycles: useSupervisorLoop ? 3 : 1,
  };
}
