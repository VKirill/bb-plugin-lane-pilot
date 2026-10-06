---
title: Task folder for writers + actionable retries
date: 2026-10-06
status: dispatched
tasks: [writer-task-folder, writer-retry-feedback]
---

# Task folder for writers + actionable retries

## Why

Owner question (2026-10-06): the writer brief carries a JSON contract inline; should the spec live in files the writer reads?

Research (Anthropic multi-agent research system, context-engineering post, claude-cookbooks
`research_lead_agent.md`, `CMA_verify_with_outcome_grader`, GitHub Spec Kit):

- The brief itself carries the contract: one objective, output, boundaries, checks.
- Bulky material (long specs, prototypes, logs) lives in files and is passed by path.
- Rejection feedback must say what failed and what to do; repeated identical failures mean the loop does not converge.

Findings in the code (Explore, 2026-10-06):

> [!warning] Bugs
> 1. The writer never receives the PM `plan` (stored in `lane_pilot_task_plan`, read only by plan critique and specialist review; `writerPrompt`/`stickyTurnPrompt` take no plan).
> 2. Mainfix puts the failing check output and the "main already green" escape only into `plan`, so the writer sees neither. A green main ends in `empty_output` ("writer changed no files"), classed as provider, retried, then fallbacks, then "retry limit exhausted".
> 3. `expected_outputs` of the mainfix is prose, not a path.
> 4. No stop when two attempts fail with the same reason.

## Layout

```
.agents/plans/items/<task-id>/
├── PLAN.md      — the PM plan as dispatched
└── logs/        — failing check output, previous attempt records
```

## Tasks

- [ ] `writer-task-folder` — Lane Pilot writes the task folder on dispatch, makes it visible in the writer worktree, and points the brief at it.
- [x] `writer-retry-feedback` (depends on the first) — mainfix pre-check on main, logs into the folder, actionable retry feedback, stop on a repeated failure.
