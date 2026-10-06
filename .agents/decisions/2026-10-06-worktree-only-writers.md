---
date: 2026-10-06
status: accepted
decided_by: owner («делай что считаешь нужным» after the PM's proposal)
---

# Writers always work in their own git worktree

The in_place mode («в папке проекта») is removed for every project. A writer works in an isolated worktree and commits its work there. Acceptance reads the attempt's commit diff (`git diff base..attempt`) instead of comparing a shared working tree before and after.

**Why:** ownership/dirt and empty-output failures were ~200 of ~575 failed attempts in 14 days (hub, 2026-10-06). On 2026-10-06 alone there were three new patches for the same cause:
- in-place leftovers;
- a subfolder workspace;
- BB chat files tracked in git.

**Cost:** disk and a few seconds per attempt to prepare a worktree (node_modules is mirrored).

See `.agents/plans/items/lp-core-refactor/PLAN.md`, phase P1.
