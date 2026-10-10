# Portable Agent Workbench Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development and TDD. User explicitly authorized this plan's implementation; no extra planning approval round.

Goal: implement local state, trusted verification, portable native workflows, and a reviewed TwoSparks pilot.
Architecture: shared TypeScript service layer used by CLI and stdio MCP; SQLite transactions for coordination; approved argv runner for evidence; native host delegation outside the MCP.
Tech stack: Node22+, TypeScript, better-sqlite3, YAML, Zod, MCP SDK, node:test + tsx.
Spec: ../specs/2026-10-10-portable-agent-workbench-design.md

## Global constraints
- No hosted state, no new provider API keys, no automatic model upgrades.
- Immutable policy approval, fenced claims, independent reviews, private pilot context.
- Isolated workspaces; preserve user files; no unsupported storage fallback.

## Review focus
Concurrent SQLite clients; stale reviews at merge; symlink/command escape; agents weakening policy; private data entering public release.

### Task 1: State/policy core
Files: src/core.ts, src/types.ts, src/policy.ts, src/security.ts, src/store.ts, tests/core.test.ts.
Interfaces: Workbench and profile/types defined in controller core-brief.md; ready frontier only after integrated verified dependencies.
- [ ] Write and run failing tests for claims, policy, DAG, review/evidence, recovery, import and path boundaries.
- [ ] Implement transactions, state events, schemas, approved snapshots, fenced claims, readiness, checkpoints.
- [ ] Run core tests and review spec + security before interface integration.

### Task 2: Execution, CLI, MCP, Git
Files: src/runner.ts, src/git.ts, src/service.ts, src/cli.ts, src/mcp.ts, tests/runtime.test.ts.
Interfaces: consume Workbench; service captures actual Git snapshots; runner consumes approved commands and writes EvidenceInput; no arbitrary candidate/evidence accepted from MCP.
- [ ] Write failing tests for traversal, shell injection, timeout/output caps, stale candidates, cross-process CLI/MCP.
- [ ] Implement Git snapshot/worktree helpers, approved-command runner, service/CLI/MCP handlers.
- [ ] Verify real MCP initialize/list/tools calls and installed host discovery.

### Task 3: Skills, roles, adapters, installers
Files: src/adapters.ts, scripts/, skills/, upstream/, tests/adapters.test.ts.
Interfaces: CLI install/doctor/update/uninstall uses adapters; host config emits stdio server plus role/skill registrations.
- [ ] Pin upstream commit and preserve LICENSE; adapt invocation/reference/delegation rules with provenance manifest.
- [ ] Test installer collisions, user edits, update/uninstall and serial fallback first.
- [ ] Implement safe generated ownership manifest, backups, role catalog, host capability report.
- [ ] Validate all skills and behavior-pressure-test core workflows.

### Task 4: TwoSparks reconciliation and pilot
Private reports only in workspace work/reports; deliver private pilot in outputs/twosparks-pilot, never public toolkit.
- [ ] Read current repo code/docs without modifying original; map conflicts and launch gates.
- [ ] Clone local current baseline to isolated writable checkout; select one concrete security/safety gap with reproduction.
- [ ] Register task/policy, implement failing regression then fix, independent review, checks, and integration evidence.
- [ ] Produce evidence report and patch; retain external blockers.

### Task 5: Release
Files: README.md, docs/, .github/workflows/, packaged tarball.
- [ ] Complete independent spec/security review and fix blocking findings.
- [ ] Run full tests/typecheck/build/skill validation/package inspection and private-data scan.
- [ ] Run installed-host MCP smoke tests; document CI platform checks as pending until external runners finish.
- [ ] Commit reviewed source, publish public GitHub repo and v0.1.0 release with tarball, or document concrete external blocker.
