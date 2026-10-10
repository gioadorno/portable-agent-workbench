# Compatibility

| Surface | Support |
| --- | --- |
| Codex CLI | Project MCP config, portable skills, TOML roles; preserve model settings |
| Codex desktop | Project CLI configuration/skills where the desktop host discovers them; host-owned subagent permissions still apply |
| OpenCode | Local MCP, namespaced skills, Markdown subagent roles and manual-invocation metadata |
| Other MCP hosts | State/verification stdio tools; native role installation requires a future adapter |
| Node | Supported LTS 22+; native better-sqlite3 installation required |
| Linux/macOS/Windows | Core CI matrix; Linux local verification, external OS results recorded separately |

Initial local hosts: Codex CLI 0.162.1 and OpenCode 1.18.34. Run `doctor` after installation. Versions, installed plugins, authentication, provider/model availability and host permission settings affect native execution; the toolkit does not silently change them.

Install previews list collisions. Existing valid OpenCode JSON is merged into a generated ownership snapshot. JSONC configurations require manual merging. Existing Codex TOML is preserved with namespaced generated blocks. Updates require owned hashes to remain unchanged. Uninstall preserves the entire installation when user edits require reconciliation.

The host supplies subagents; the MCP does not launch a second orchestrator or run unattended wakeups. When native delegation/isolation is unavailable, use one task at a time and record the limitation. Cross-host resume shares project state, not hidden native chat transcripts.

## Host smoke evidence (2026-10-10)

OpenCode 1.18.34 `mcp list` connected to the installed local stdio configuration. Codex 0.162.1 discovered the project MCP entry from an isolated credential-free trusted configuration when invoked from the project directory. `-C` did not affect MCP-list project discovery in this installed version. After declaring correct read-only MCP annotations, Codex successfully called `list_tasks` and received `[]`. Codex tool invocation remains subject to host MCP approval policy; an `approval=never` session initially refused the unannotated tool. Trust/approvals are host-owned and the installer does not silently change user-level trust settings. See the official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The registered project must be the Git top-level checkout and own its Git metadata within that root. Primary linked worktrees, nested project folders, and externally backed `.git` layouts are rejected. Toolkit-created task worktrees within the registered project are supported. Internal Git commands strip inherited `GIT_*` routing variables.
