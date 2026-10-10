# CLI reference

Global option: `--project <absolute-or-relative-root>`. All file options refer to paths inside that root. Output is JSON except help, interactive approval, and stdio MCP. Fatal errors go to stderr and exit nonzero.

| Command | Options / behavior |
| --- | --- |
| `init` | Optional `--profile <yaml>`; creates project profile and ignored runtime paths without overwriting existing profile |
| `approve` | `--plan <relative-path>`; interactive owner approval, or explicitly authorized `--yes` automation |
| `task-create` | `--file <task.json>` |
| `task-claim` | `--task <id> --host codex\|opencode\|manual --session <native-session-id> --worker <worker-id>` |
| `task-submit` | `--token <claim-token>`; inspects the committed worktree |
| `task-rebase` | `--token <claim-token>`; rebase onto current root HEAD, invalidate prior checks/reviews; resolve conflicts in the native worker |
| `heartbeat` | `--token <claim-token>` |
| `verify` | `--token <claim-token> --check <approved-check-id>` |
| `review-assign` | `--task <id> --host <host> --session <reviewer-session-id> --worker <reviewer-id> --kinds spec,code` (security uses a separate grant) |
| `review-record` | `--token <review-grant> --file <review.json>` |
| `accept` | `--task <id>`; requires current candidate, required checks and independent reviews |
| `integrate` | `--token <claim-token>`; clean checkout and exact reviewed base, serialized and fenced |
| `reconcile-integration` | `--token <claim-token> --worker-stopped`; require matching prepared receipt, clean root and exact integrated HEAD |
| `recover-lock` | `--worker-stopped`; remove only an abandoned integration lock whose PID is proven dead; refuse live or unknown owners |
| `record` | `--kind requirement\|decision\|blocker --file <record.json>`; record reference data |
| `resolve-blocker` | `--id <blocker-id>`; owner operation with current approval |
| `external-gate` | `--file <gate.json>`; owner records inspected staging or release evidence |
| `recover` | `--task <id> --worker-stopped`; inspect and stop native worker first; quarantines old worktree and revokes ownership |
| `context` | Optional `--task <id>`; focused references, hashes, decisions and last checkpoint |
| `status`, `readiness`, `resume` | Inspect durable coordination or release dimensions |
| `checkpoint` | Optional `--label <text>` |
| `export` | `--file <new-file> --format json\|markdown` (default JSON); content-free by default; explicit `--include-content` needs owner inspection |
| `import` | `--file <export.json>`; restores structural tasks as unverified, never imported approval/release completion |
| `install`, `update` | `--host codex\|opencode`; preview by default, `--apply` writes owned generated files |
| `uninstall` | Same host/apply flags; preserves edits and user-owned files |
| `doctor` | `--host codex\|opencode`; capability/config diagnostics |
| `mcp` | Serve JSON-RPC over stdin/stdout; no diagnostics on stdout |

## Task format

```json
{
  "id": "AUTH-001",
  "title": "Reject invalid admission boundary",
  "requirement": "Adults only; no premature admission",
  "acceptance": ["Tomorrow's birthday is rejected", "Today’s birthday is accepted"],
  "dependencies": [],
  "scope": ["src/auth/**", "tests/auth.test.ts"],
  "requiredChecks": ["unit"],
  "risk": "sensitive",
  "code": true,
  "sourceRefs": ["docs/implementation-plan.md"]
}
```

Supported scope patterns: exact file/directory prefixes, `*`, `**`, and `?`. Ambiguous wildcard intersections are treated conservatively as overlapping. Include every intended changed file, including dependencies, migrations and configuration.

## Review format

The coordinator invokes a native independent reviewer, then issues a grant matching its role/session. Use exact tree and diff fingerprints returned by submission:

```json
{
  "kind": "spec",
  "verdict": "pass",
  "treeHash": "<submitted-tree>",
  "diffHash": "<submitted-diff>",
  "criteria": ["Tomorrow's birthday is rejected", "Today’s birthday is accepted"],
  "findings": []
}
```

Each review kind is recorded separately. Open critical/high findings block acceptance; tests and reviews become stale when their candidate changes. Do not fabricate reviewer identity or acceptance coverage. Provider/device/store/counsel approvals require genuine external evidence.

## Process recovery

A lease is permission to submit/integrate, not permission to kill arbitrary processes. Inspect the native session and stop it before confirming recovery. Recovered candidates are quarantined; continue in a fresh worktree with a fresh token. Never reset or clean another worker’s dirty worktree.

A crash between Git integration and SQLite commit must be reconciled against Git HEAD and the prepared checkpoint. Do not re-run a merge blindly. The tool rejects a stale integration base until the owner/coordinator inspects it.

## Memory and external evidence formats

Requirement: `{"id":"R-1","text":"Requirement","sourceRefs":["docs/spec.md"]}`. Decision: `{"id":"D-1","text":"Decision","rationale":"Reason"}`. Blocker: `{"id":"B-1","text":"Missing evidence","taskId":"AUTH-001"}`; omit taskId for a global blocker. IDs cannot change record kind or blocker scope. Worker MCP can record blockers but cannot resolve them. Global blockers prevent acceptance/readiness.

External gate:

```json
{"id":"staging-auth","dimension":"staging","passed":true,"owner":"release-owner","taskIds":["AUTH-001"],"evidenceRef":".agentkit/artifacts/staging-auth.txt","artifactHash":"<SHA-256 of the inspected UTF-8 artifact>"}
```

Use `dimension: "release"` for genuine release approval. Artifacts are local, bounded, checked for common credentials, and bound to approval and covered candidate fingerprints. The owner must record every required external gate; the toolkit cannot discover an omitted provider, device or counsel obligation. Missing, failed, stale or incomplete coverage leaves that dimension unresolved. Current service readiness also requires a clean checkout at the reviewed integrated Git frontier.

Verification runs in the candidate worktree with a stripped environment; approved argv may explicitly configure dedicated test caches (for example via an `env` executable). Checks renew ownership and abort if policy/claim authorization changes. They never receive an arbitrary worker-supplied command.

New or changed requirement/decision records conservatively invalidate existing candidate checks, reviews and readiness. Reclaim completed work for revalidation against current code; do not repeat implementation. Active workers must resubmit and obtain fresh checks/reviews. Markdown is an inspection export; use JSON for import/migration. Neither format transports authorization or verified completion.
