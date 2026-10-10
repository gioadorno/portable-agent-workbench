---
name: mp-implement
description: Implement a piece of work based on a spec or set of tickets.
disable-model-invocation: true
metadata:
  workbench/source: mattpocock/skills
  workbench/revision: 49dd158d1076134a641b33efb035946536778336
---

## Host adaptation
Use the host's native skill loading, questioning and delegation tools. Resolve original skill names in this document to installed mp- names (for example tdd means mp-tdd); keep issue labels and filenames unchanged. Preserve manual invocation restrictions. If parallel delegation or isolated worktrees are unavailable, use sequential execution and report the capability limit. When using Workbench, its approved plan, ownership and verification gates govern this workflow; do not close work from prose claims alone.


Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the native skill-loading mechanism with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the native skill-loading mechanism with "code-review" to review the work.

Commit your work to the current branch.
