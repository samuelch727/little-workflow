# Changelog — little-harness

`@little-stack/harness` and `@little-stack/workflow` are released together. Release notes for both
live in the repository changelog: [`CHANGELOG.md`](../../CHANGELOG.md).

## [0.2.0-alpha.4] - 2026-11-16

- **Breaking:** restore the previous default tool list with `taskTools: true, workflowTools: true` on a host with durable services.
- Add per-instance folder context, opt-in context compaction, virtual `/tmp`,
  trace value redaction, private spill storage and release-matched packaged skills.

### Changed — Little Harness tool budgets

- Enforce defaults of 100 tool execution attempts per turn (including nested bridge
  calls) and 10 concurrent execution chains. Tool deadlines abort/discard the result
  but cannot terminate arbitrary JavaScript or undo side effects; non-cooperative
  calls retain their slot until settled. Emit at most one warning per policy per turn.
- Apply the model-step cap even with caller `stopWhen`: explicit `turnLimits.maxSteps`
  takes precedence over `workflowBudgets.maxModelSteps` (default 20), preserving
  `StepLimitExceeded`. Preserve SDK/step and turn abort signals when gating tools.
- **Breaking:** remove unused public budget fields `maxAutonomousTurns`,
  `workflowDeadlineMs`, `maxDynamicWorkflowTokens`, and `maxDynamicWorkflowOutputBytes`.
