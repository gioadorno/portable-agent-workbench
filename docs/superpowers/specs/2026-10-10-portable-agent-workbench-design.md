# Portable Agent Workbench — approved design

Approved by the user on 2026-10-10. Build a public portable toolkit: native Codex/OpenCode host-led agents, TypeScript CLI plus local stdio MCP, project-local SQLite memory, pinned Matt Pocock skills with attribution and explicit adaptations. TwoSparks is the private/local pilot.

## Binding requirements
- Portable skills and role manifests with capability detection, preserved existing user configuration, on-demand context, and explicit upstream updates.
- Stable task DAG, transactional claims, worktree isolation, conflict prevention, fencing at submission and integration, quarantined abandoned work, restart checkpoints.
- Immutable approved policy and plan snapshot; approved argv validation commands only; root/symlink confinement; bounded output/runtime; no MCP policy approval endpoint.
- Actual changed files determine scope and sensitivity. Independent spec/code review for code changes; sensitive changes require specialist security review. Review and validation bound to candidate fingerprint; integration resolutions require fresh review.
- Separate implemented, locally verified, staging validated, and release approved. Preserve external provider/device/counsel/store/operations blockers.
- Existing model choices configurable; serial fallback; local shared OS account is a trust boundary, not tamper-proof agent identity or a sandbox substitute.
- Explicit export/import with sensitive data excluded by default; no imported readiness, approval, or executable commands trusted.
- Install/update/uninstall preserve user edits and naming collisions. Node22+ supported LTS, better-sqlite3 explicit native install diagnostics, versioned schema with backup.
- Public package contains only generic source, skills, fixtures, docs, CI. Keep TwoSparks source/context outside public repo.

## Acceptance
Test interrupt/resume, concurrent and overlapping claims, revoked submission/integration, cross-host handoff, stale evidence/policy/review, missing acceptance criteria, injection/traversal/symlinks/imported content, preserving dirty user files, and unresolved external readiness.
Run live CLI and MCP smoke tests with installed Codex/OpenCode; test Linux locally and Linux/macOS/Windows core in CI. Pilot reconciles code/docs and completes one bounded approved launch-critical task in an isolated checkout. Package GitHub release after independent review; retain exact evidence and release limitations.
