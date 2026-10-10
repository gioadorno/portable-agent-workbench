# Skill provenance and adaptations

The engineering and productivity collections contain 27 upstream skills at revision `49dd158d1076134a641b33efb035946536778336`. Experimental, deprecated, and Claude-specific miscellaneous collections are intentionally excluded from portable installation.

Original trees and MIT notices are preserved under `upstream/mattpocock`. Portable copies use the `mp-` namespace, including cross-skill command names, to avoid collisions with existing tools. The manifest records each adapted file's original/adapted hash. Per-host compilation preserves manual-only invocation: Codex uses `disable-model-invocation`; OpenCode receives string-valued `opencode/slash` and `opencode/autoinvoke` metadata. Tool names become host-neutral, and unavailable delegation uses sequential fallback.

The Workbench skill is a reference to the coordination API and does not replace the upstream engineering disciplines. Skills load on demand; native agent roles and the local MCP provide the execution context.

## Explicit updates

Review the upstream Git revision first. From a development checkout, run:

```sh
node scripts/vendor-upstream.mjs /path/to/reviewed/upstream-checkout
npm run validate-skills
npm test
```

Inspect manifest/source differences and run core behavioral evaluations before accepting updates. No startup updater or remote fetched instruction executes automatically. Existing installed files with owner edits stop updates.

Schema/reference validation establishes packaging correctness. Core behavioral scenarios exercise planning/task dependency, actual implementation, missing acceptance review, interruption/resume, and handoff. They do not certify every upstream workflow or guarantee a model will always follow prose. Release evidence records which evaluations actually ran.
