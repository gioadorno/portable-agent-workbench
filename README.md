# Portable Agent Workbench

Local project memory, task ownership, and evidence gates for coding agents in **Codex and OpenCode**.

The coding tool leads its native agents. This package supplies portable skills, scoped roles, a SQLite task graph, an approved-command verification runner, and a stdio MCP interface. It requires no hosted coordination service or separate model API key.

## Install from GitHub

Requires Git and a supported Node.js LTS release, version 22 or newer.

```sh
git clone https://github.com/gioadorno/portable-agent-workbench.git
cd portable-agent-workbench
npm ci
npm run build
node dist/cli.js help
```

Packaged tarballs are also available in [GitHub Releases](https://github.com/gioadorno/portable-agent-workbench/releases). Install a downloaded tarball with `npm install -g ./portable-agent-workbench-0.1.0.tgz` to use `agent-workbench` from any project. The CLI still requires a project profile and an approved plan for work execution.

Use the absolute path to `dist/cli.js` in the following commands. For a real project:

```sh
node /path/to/portable-agent-workbench/dist/cli.js --project /path/to/project init
node /path/to/portable-agent-workbench/dist/cli.js --project /path/to/project install --host codex
node /path/to/portable-agent-workbench/dist/cli.js --project /path/to/project install --host codex --apply
node /path/to/portable-agent-workbench/dist/cli.js --project /path/to/project doctor --host codex
```

Replace `codex` with `opencode` for OpenCode. Installation defaults to preview. Review generated files and approve only the configuration changes you want. Existing files and locally modified installed files are preserved.

Edit `.agentkit/project.yaml` to select project context, specialist roles, validation commands and limits. Write an implementation plan in the project. Review both, then approve the exact policy/plan snapshot:

```sh
node /path/to/portable-agent-workbench/dist/cli.js --project /path/to/project approve --plan docs/implementation-plan.md
```

Approval uses an interactive terminal. `--yes` is available for the project owner’s explicitly approved automation; MCP does not expose approval. Commit intended profile/plan/ignore changes before starting isolated code tasks.

## Working loop

1. Reconcile existing implementation, decisions, tests, and historical status claims.
2. Create tasks with stable IDs, dependencies, scope, checks, and explicit acceptance criteria.
3. Claim ready work and use the assigned Git worktree; send only focused context to native workers.
4. Commit a candidate, submit it, and run the profile’s approved checks.
5. Invoke independent native spec/code reviewers. Sensitive changes also need security review. The coordinator issues review grants through the CLI.
6. Accept and integrate only the reviewed candidate on its exact base. Rebase and review again if the integration branch advanced.
7. Checkpoint and resume in either host. External release gates stay unresolved until their evidence exists.

Read [CLI reference](docs/CLI.md), [architecture and trust boundaries](docs/ARCHITECTURE.md), [host compatibility](docs/COMPATIBILITY.md), and [skill provenance](docs/SKILLS.md).

## What evidence means

Implemented, locally verified, staging validated, and release approved are separate dimensions. Unit tests do not establish provider delivery, physical-device behavior, legal approval, backup recovery, or production operational readiness. Imported reports start as unverified claims. There is no estimated production-completion percentage.

Agent/session identities are structural provenance within a trusted local OS account. The host sandbox and permissions remain the boundary for command/file execution. This toolkit cannot stop a process with the same filesystem privileges from bypassing or tampering with its state.

## Development

```sh
npm ci
npm run check
npm test
npm run validate-skills
npm run build
npm pack
```

SQLite native installation failures are errors, with no fallback to a weaker store. Use supported LTS Node/platform binaries; if prebuilt native artifacts are unavailable, install the platform C++ build prerequisites before retrying.

Upstream engineering/productivity skills are pinned, licensed and adapted explicitly. Updates never run automatically. See `upstream/manifest.json` and `THIRD_PARTY_NOTICES.md`.
