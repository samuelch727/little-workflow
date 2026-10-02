# Deploy runbook

- Deploys go out from `main` through the release pipeline. No local deploys.
- The pipeline holds a deploy if the error budget for the week is exhausted.
- Friday deploys need a named owner who is around until 18:00.
- Rollback is a pipeline button, not a revert commit. Use it first, understand later.
