---
name: mp-research
description: Investigate a question against high-trust primary sources and
  capture the findings as a Markdown file in the repo. Use when the user wants a
  topic researched, docs or API facts gathered, or reading legwork delegated to
  a background agent.
metadata:
  workbench/source: mattpocock/skills
  workbench/revision: 49dd158d1076134a641b33efb035946536778336
---

## Host adaptation
Use the host's native skill loading, questioning and delegation tools. Resolve original skill names in this document to installed mp- names (for example tdd means mp-tdd); keep issue labels and filenames unchanged. Preserve manual invocation restrictions. If parallel delegation or isolated worktrees are unavailable, use sequential execution and report the capability limit. When using Workbench, its approved plan, ownership and verification gates govern this workflow; do not close work from prose claims alone.


Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
