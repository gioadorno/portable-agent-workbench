---
name: mp-handoff
description: Compact the current conversation into a handoff document for
  another agent to pick up.
argument-hint: What will the next session be used for?
disable-model-invocation: true
metadata:
  workbench/source: mattpocock/skills
  workbench/revision: 49dd158d1076134a641b33efb035946536778336
---

## Host adaptation
Use the host's native skill loading, questioning and delegation tools. Resolve original skill names in this document to installed mp- names (for example tdd means mp-tdd); keep issue labels and filenames unchanged. Preserve manual invocation restrictions. If parallel delegation or isolated worktrees are unavailable, use sequential execution and report the capability limit. When using Workbench, its approved plan, ownership and verification gates govern this workflow; do not close work from prose claims alone.


Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the native skill-loading mechanism for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
