# Contributor workflow

Read the approved design in docs/superpowers/specs before changing coordination or security behavior. Preserve the host-led architecture and the documented shared-OS-account trust boundary.

CLI and MCP must use the same services. Owner policy approval, review grants, blocker resolution, lock recovery and external attestation must remain absent from worker MCP tools. Preserve generation-based invalidation, transactional ownership, actual Git fingerprints, independent review and explicit external readiness.

Use narrow Git worktrees for code tasks. Preserve user-owned host configuration and dirty changes. Keep upstream originals, license notices and adaptation hashes pinned; upstream updates are explicit, reviewed changes.

Run npm run check, npm test, npm run validate-skills and npm run build for behavior changes. Add meaningful regressions for ownership, recovery, authorization and evidence failures. Cross-platform support requires the Linux/macOS/Windows Node22/24 matrix; report pending or skipped evidence accurately.

Keep private project context, credentials, databases and runtime artifacts outside this generic repository. Export defaults remain content-free. Do not claim cryptographic identities, tamper-proof state or sandbox isolation from local token checks.
