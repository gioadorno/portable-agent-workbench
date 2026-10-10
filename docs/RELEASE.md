# v0.1.0 release evidence

## Implemented and locally checked

TypeScript CLI and local stdio MCP share transactional SQLite task ownership, scoped Git worktrees, approval snapshots, persistent memory generations, bounded argv checks, independent review gates, checkpoint/recovery, current-checkout readiness, JSON/Markdown inspection exports, and non-destructive Codex/OpenCode installation.

- 74 local tests pass on Linux/Node 22.22.2, including actual concurrent-process claim racing, CLI SIGTERM descendant cleanup, MCP client-disconnect cancellation, restored-policy/decision fencing, stale evidence, independent review, traversal/symlinks/argv injection, and installation preservation.
- TypeScript check and build pass.
- All 28 bundled skills validate: 27 upstream engineering/productivity skills at `49dd158d1076134a641b33efb035946536778336`, plus the workbench skill. Originals, upstream MIT license, attribution, adaptation patches and integrity hashes are retained.
- npm production dependency audit reports zero known vulnerabilities.
- Independent source/specification/security review passed after regression-backed corrections. One bounded private pilot additionally exercised planning/implementation/review/handoff instructions; this does not behavior-certify every bundled skill.
- OpenCode 1.18.34 connected through its installed local MCP configuration. Codex 0.162.1 discovered the trusted project config and successfully invoked the read-only task-list tool. Project trust, model availability, native reviewer capacity and permissions remain host-owned.

## Platform and production limits

GitHub Actions runs Node 22/24 on Linux, macOS and Windows. The workflow/run results are the authoritative cross-platform evidence, not local Linux tests. A real Unix signal regression is skipped on Windows, where forced process termination has different semantics; programmatic service cancellation is tested across the matrix.

This is a local trusted-account coordinator. It is not a security sandbox or cryptographic agent identity system. Owner review remains required for meaningful validation commands, genuine independent reviewers, upstream changes and external gate selection. Hard kills and deliberately daemonized commands require host-level process inspection.

No hosted service or separate model API key is needed. Native model access and native agent sessions remain managed by the host. Third-party JSONC configuration needs explicit manual reconciliation. Updates do not replace user-modified files.

Private pilot context, app source, credentials, state databases, artifacts and project-specific reviews are excluded from this repository and package. No app production readiness is claimed.
