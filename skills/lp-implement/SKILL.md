---
name: lp-implement
description: "Execute a Markdown plan (.agents/pilot/plans/<slug>.md) as coordinator: dispatch tasks to clean BB subthreads or Lane Pilot writer lanes, verify diffs and checks, and update plan checkboxes. Use when: выполнить план, продолжить план, запустить делегирование задач субагентам, /lp-implement. SKIP: initial project setup (lp-project-setup), plan authoring without execution (lp-plan), or standalone audit-only checks (lp-verify)."
license: MIT
---

# Lane Pilot — Plan Coordinator & Clean Subthread Delegation

> Adapted from `lee-to/ai-factory` (`/aif-implement`, `implement-coordinator`, `implement-worker`, and `bb-plugin-aif-helper` native delegation, MIT) for Lane Pilot and BB clean subthreads.

Execute tasks from `.agents/pilot/plans/<slug>.md` (or an explicitly named `@<plan.md>`) layer by layer while keeping subagent sessions clean, deterministic, and verified by the coordinator.

## Coordinator Ownership Rules

1. **You remain the single owner of the plan.** Workers never edit the plan file or its checkboxes (`[ ]` / `[~]` / `[x]` / `[!]`), never spawn nested child agents, and never create commits or push branches.
2. **Read configuration before each layer.** Read `AGENTS.md`, `.agents/pilot/config.json` (`delegation`), `.agents/pilot/DESCRIPTION.md`, `.agents/pilot/ARCHITECTURE.md`, `.agents/pilot/rules/base.md`, and `.agents/pilot/skill-context/delegation.md` when present.
3. **Standard service tier only.** Never request `--service-tier fast` for Lane Pilot subthreads; always keep `--service-tier 'default'` (or omit when default).
4. **Preserve unrelated changes.** Check `git status` before starting; never stage, revert, or overwrite files outside the active task's `Owns` list.

## Execution Modes (`delegation.mode` in `.agents/pilot/config.json`)

- **`pilot-lanes` (when running as a Lane Pilot PM with `lane_pilot_dispatch_task`):** Dispatch independent ready tasks with non-overlapping `owns_paths` into isolated worktree writer lanes, let critique/verification gates run, and integrate accepted commits.
- **`bb-subthreads` (native clean BB subthreads on the chosen provider/model):** Delegate each task to a clean BB worker thread (`bb thread spawn --parent-self ...` — BB automatically applies the clean `subthreads` session context without extraneous plugins or skills).
- **`self` (inline single-agent execution):** Implement ready tasks directly in the current thread, running scoped verification after each task. If multiple independent tasks are ready and subthreads are desired, ask or use `bb-subthreads`.

## Native Clean Subthread Handoff Protocol (`bb-subthreads`)

For each ready task (`[ ]` whose `depends on` prerequisites are `[x]`):

1. **Mark in-progress:** Change `- [ ] Task N:` to `- [~] Task N:` in the plan file before dispatch.
2. **Write a self-contained task brief** to `.bb/chats/$BB_THREAD_ID/tmp/task-<N>-brief.md` starting with these mandatory worker rules:
   - Role: isolated implementation worker delegated by coordinator `$BB_THREAD_ID` for **exactly one task** (`Task N`).
   - Hard limits: do NOT edit the plan file or checkboxes; do NOT commit, push, or switch branches; do NOT spawn child agents or run unrelated skills.
   - Context to read first from disk: `AGENTS.md`, `.agents/pilot/ARCHITECTURE.md`, `.agents/pilot/rules/base.md`, `.bb/skills/lp-writer/SKILL.md` (if present), plus the task's `Owns` / `Read-first` files.
   - Local quality pass: run the task's verification commands; review changed code for bugs, security, and duplication; fix material issues (max 2 local refinement rounds; do not loop on cosmetic nits). If requirements conflict with repository contracts, stop without guessing and report `handoff_outcome: blocked_external`.
   - Required worker output: `files_modified`, exact verification commands with exit codes, `docs_recommended: yes/no`, `commit_recommended: yes/no`, and any open warnings/blockers.
3. **Deduplicate before spawning:** Run `bb thread list --parent-thread "$BB_THREAD_ID" --json`. Reuse an existing non-archived thread titled `LP · <plan-slug> · Task <N>` if present.
4. **Spawn clean worker subthread:**
   `bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off --service-tier 'default' <provider/model flags from config> --title 'LP · <plan-slug> · Task <N>' --prompt-file <brief-file> --json`
   *(Note: when workers share one unmanaged checkout, run one writing worker at a time; run parallel workers only with `--new-environment worktree` and non-overlapping `Owns` paths, then merge sequentially).*
5. **Wait & inspect:** Poll `bb thread wait <id> --status idle --timeout 8m` until terminal, read `bb thread output <id>`, inspect `git diff`, and **run the task's verification command yourself**.
6. **Advance or refine:** If a small gap remains, send `bb thread tell <id> '<exact fix>'` (max 2 rounds). Only when verification passes, mark `- [x] Task N:` in the plan and proceed to the next ready layer. On `blocked_external`, restore `[ ]` and report the blocker to the owner.
