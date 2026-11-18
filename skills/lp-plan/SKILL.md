---
name: lp-plan
description: "Research a task against project architecture and write an executable dependency-ordered Markdown plan in .agents/pilot/plans/<slug>.md for Lane Pilot or clean subthreads. Use when: составить план задачи, спланировать доработку, уточнить план, декомпозировать фичу, /lp-plan. SKIP: writing production code directly (lp-implement, lp-writer) or running post-implementation verification (lp-verify)."
license: MIT
---

# Lane Pilot — Task Discovery & Executable Planning

> Adapted from `lee-to/ai-factory` (`/aif-plan` + `/aif-improve`, MIT) for Lane Pilot task graphs and clean BB subthread execution.

Turn a user goal or bug report into a grounded, dependency-annotated Markdown plan under `.agents/pilot/plans/<slug>.md` where every task has explicit file ownership, dependencies, and verification commands.

## Hard Boundaries

1. **Planning only — do NOT modify production code.** Only create or refine `.agents/pilot/plans/<slug>.md`.
2. **Read project context first.** Read `AGENTS.md`, `.agents/pilot/DESCRIPTION.md`, `.agents/pilot/ARCHITECTURE.md`, and `.agents/pilot/rules/base.md` when present before proposing file paths or commands.
3. **One owner per rule.** Search the repository for existing types, constants, helpers, and routes (`file:line`) before proposing new ones. Never plan duplicate vocabularies or parallel helpers.
4. **Ask only blocking product decisions.** If requirements have a genuine ambiguity that changes behavior or data model, ask a concise question before finalizing; otherwise resolve technical details from the codebase.

## Plan Structure (`.agents/pilot/plans/<slug>.md`)

Write clean Markdown with these exact sections:

1. `# Plan: <Title>` — 1–2 sentences stating the goal, user value, and scope boundary (what is included and excluded).
2. `## Context & Architecture Seams` — Verified `file:line` touchpoints, existing patterns to reuse, module boundary constraints from `.agents/pilot/ARCHITECTURE.md`, and risks.
3. `## Tasks` — Checkbox tasks grouped by phase, with explicit dependency and parallelism annotations so the coordinator (`lp-implement` or Lane Pilot PM) knows which tasks can run concurrently in isolated worktrees and which share files sequentially:
   - Annotate parallel-safe groups with `<!-- parallel: tasks 1, 2 -->` ONLY when `owns_paths` do not overlap.
   - Format each task checkbox on one clear line: `- [ ] Task N: <concise imperative title> (depends on X)` (omit `(depends on ...)` for root tasks).
   - Under each task, list:
     - `Owns`: exact relative file paths (`create` or `modify`)
     - `What`: concrete behavioral change and key function/type signatures (no multi-line implementation code dumps)
     - `Verify`: exact scoped test/typecheck command proving this task works
4. `## Final Verification` — Exact end-to-end commands (`typecheck`, `lint`, `test`, `build`) from `.agents/pilot/DESCRIPTION.md` required before completion.

## Plan Refinement Mode

When asked to refine or improve an existing plan:
1. Preserve `[x]` on already completed tasks — never reset verified work.
2. Check every `[ ]` task against current repository files (`git status`, `file:line`), tightening vague descriptions, missing edge cases, overlapping `owns_paths`, or missing tests.
3. Verify there are no circular `(depends on ...)` links and every task names concrete verification commands.
