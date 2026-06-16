# Security Policy

## Supported versions

Little Workflow is in an early alpha phase. Security fixes are applied to the latest
`0.1.0-alpha.x` release only. There is no long-term-support guarantee during alpha.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues,
discussions, or pull requests.

Instead, report them privately through GitHub's
[private vulnerability reporting](https://github.com/samuelch727/little-workflow/security/advisories/new).
This opens a confidential advisory visible only to the maintainers.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept, if possible.
- Affected version(s) and environment details.

We will acknowledge your report, investigate, and keep you updated on remediation.
Please give us a reasonable window to release a fix before any public disclosure.

## Scope and runtime note

Little Workflow executes model-planned steps and tool calls. The default workflow
harness **fails closed** for arbitrary code execution: running code requires you to
supply your own isolated worker harness. Treat workflow inputs, planner output, and
tool definitions as untrusted, and run untrusted workloads in an appropriately
sandboxed environment.
