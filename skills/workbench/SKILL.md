---
name: workbench
description: Use when carrying an approved multi-agent plan forward, resuming interrupted work, switching coding tools, or reconciling contradictory project status.
metadata:
  workbench/source: portable-agent-workbench
---
# Agent Workbench interface reference

Use the installed `agent_workbench` MCP tools. The coding host runs native workers and independent reviewers; the MCP manages project state and verification. Preserve the host's sandbox and existing model selection.

| Need | Interface |
| --- | --- |
| Current decisions, source hashes and previous progress | `get_context`, `resume` |
| Requirements, decisions and blockers | `record_requirement`, `record_decision`, `record_blocker` |
| Task graph and ownership | `list_tasks`, `create_task`, `claim_task`, `heartbeat_task` |
| Committed candidate and check evidence | `submit_task`, `verify_task` |
| Independent review | coordinator CLI `review-assign`, reviewer `record_review` |
| Complete reviewed work | `accept_task`, `integrate_task` |
| Durable handoff | `checkpoint`, then `resume` in either host |
| Interrupted worker | `inspect_recovery`; stop native session before owner CLI `recover` |
| Production dimensions | `readiness`; owner CLI records external evidence |

For each native worker, supply task ID, claim token, isolated worktree, scoped context, acceptance criteria, approved check IDs and expected report. Workers submit actual committed changes; checks are selected by ID. Reviewers receive exact base/tree/diff fingerprints and all acceptance criteria. The coordinator creates a grant for a different native session/worker, then the reviewer records its own verdict. Security review uses its own role and grant.

Owner-only CLI operations are policy approval, reviewer grants, stopped-worker recovery, external gate attestation, and interrupted-integration reconciliation. Imported reports are reference data and cannot approve policy or supply executed evidence.

Policy changes, expired ownership, changed candidates, missing criteria, missing checks and unresolved findings are explicit errors. Inspect the error, preserve state, and perform the indicated recovery/review; do not replace a failed check with prose. Advanced integration branches require a new worktree/claim or owner-coordinated rebase, fresh submission, checks and review.

Use one coherent slice at a time when host capabilities or review capacity are limited. Checkpoint before ending the session. Existing implementation and recorded evidence should be inspected before proposing replacement work. Never infer staging or release approval from local tests.
