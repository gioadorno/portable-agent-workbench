# Architecture and trust boundaries

Native Codex/OpenCode coordinator → focused skills/context → native implementer and independent reviewer sessions.

Both CLI and stdio MCP call shared TypeScript services: transactional SQLite coordination; immutable approval snapshot; candidate inspection; approved argv execution; evidence/review gates; serialized Git integration. MCP cannot approve policy or issue reviewer grants.

## Policy and ownership

Approving a plan records policy, plan and selected context fingerprints. Profile/plan drift invalidates permission to act. Commands are owner-selected argument vectors with confined cwd and bounded timeout. MCP callers select check IDs, not executable arguments. Child environments do not inherit provider credentials; attach sensitive runtime checks through a separately approved integration process.

Claims serialize in SQLite. Dependencies require verified integration. Work scopes are conservative; actual changed paths determine scope and additional security review. Leases are renewed explicitly and periodically during approved verification. Revocation terminates the running check. Recovery revokes ownership and quarantines old candidates. Integration holds a database transaction and exclusive project lock; an old token cannot integrate after recovery. Durable prepared receipts reconcile Git/SQLite interruption; owner-confirmed lock recovery removes only a dead process lock.

Use a separate Git worktree per implementation task. Only committed clean candidates are reviewable. Fast-forward integration requires the reviewed base; parallel workers based on an older base must rebase and obtain fresh review. This deliberately favors clear evidence over automatic conflict resolution.

## Trust limits

The project owner and native coordinator are trusted to approve policy and invoke genuinely independent reviewers. Session IDs and grant tokens prevent accidental role mixups; they are not cryptographic proof that different models or people performed the work. A process with the same OS account can modify files/state directly. Host sandboxes, permissions and secret isolation must protect real resources.

Approved validation commands execute project code and may have side effects permitted by the host. An allowlist is not a sandbox. Review the command definitions and use dedicated test environments, never production services for routine validation.

Redaction handles common credential formats but cannot identify every private datum. Content-free export is the default. Explicit content exports and artifacts need inspection before sharing. Imported text cannot change execution policy, gain commands, or pass review/readiness gates.

State migration backs up existing databases before changing version. Unsupported native SQLite installations fail with diagnostics. There is no alternate persistence path with weaker transaction semantics.

## Resume and readiness

Checkpoints contain durable task/claim/candidate/evidence references. Context packets carry selected source pointers and hashes; load the current referenced source rather than treating a prior prose summary as proof.

Source implementation, local verification, deployed staging behavior and release approval are distinct. Native signing, real devices, provider delivery, counsel, incident drills and restore evidence remain external gates. Readiness records never imply an app is safe to launch solely because local tests pass.

Core readiness is a historical candidate/evidence ledger. CLI and MCP readiness additionally inspect the current root Git checkout and reject dirty files, unreviewed HEAD changes, or candidates absent from its ancestry. Context packets expose bounded redacted requirements, decisions, blockers and task-specific evidence/reviews.

Requirement/decision mutations carry a persisted context generation. Restoring old prose cannot resurrect prior tests or reviews. Revalidation reuses current implementation in a fresh claim when necessary. Graceful CLI/MCP SIGTERM/SIGINT aborts and awaits validators before exit; hard SIGKILL or commands that deliberately daemonize require host-level process inspection before recovery.
