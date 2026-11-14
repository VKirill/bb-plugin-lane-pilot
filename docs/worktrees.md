---
title: Worktrees — where they live, who removes them, the cleanup schedule
type: component
created: 2026-11-14
updated: 2026-11-14
status: active
confidence: high
tags: [worktrees, git, cleanup, janitor, schedule]
sources:
  - src/rooms/verification/git-integrate/worktree-layout.ts
  - src/rooms/verification/git-integrate/merge.ts
  - src/rooms/verification/git-integrate/worktree-lifecycle.ts
  - src/rooms/verification/worktree-sweep.ts
  - src/rooms/verification/worktree-janitor.ts
  - src/rooms/verification/integration-gate-host.ts
  - src/rooms/stability/server/worktree-janitor.ts
  - src/rooms/schedule/server/system-schedules.ts
  - src/rooms/writer/server/finish-merge.ts
  - workflows/lp.worktree-cleanup.json
  - tests/worktree-standard.test.ts
---

# Worktrees

The owner's rule (SMA parity spec, section 4г): one place per machine, outside every repository, names a person can read; a copy is
removed right after its work is merged into `main`, by the code that merged it; a periodic cleanup removes what is left; a branch with
commits merged nowhere is never deleted. This page says where each part of that lives in code and how to check a machine by hand.

## 1. One place per machine

`<home>/.lane-pilot/worktrees/<repository>/<id>` (`laneWorktreeRoot`, `laneWorktreeTarget` in
`src/rooms/verification/git-integrate/worktree-layout.ts`; `LANE_PILOT_WORKTREE_ROOT` overrides the root, tests use it).

| Who makes it | `<id>` | Branch |
|---|---|---|
| A writer attempt (both paths: the `lane-pilot-worktree` BB environment and the bare spawn) | `lpattempt_…` | `lane/lpattempt_…` |
| Self-repair, docs, regress, revert/rollback, reverify | `self-repair-…`, `docs-…`, `regress-…`, `rollback…` | `lane/<id>` or detached |
| The integration gate's bisect and baseline (`integration-gate-host.ts`) | `gate-<sha8>-<random>` | detached |

`<repository>` is the folder name of the git top the worktree forks, so a chat folder nested in a larger repository is filed under that
repository (`laneWorktreeTargetFor`). Every creator goes through the host method `gitCreateWorktree`, which builds the path; no creator
names a folder itself. The registry row (`lane_pilot_worktree`) is written in one place, the host-call hook in `core/server/core.ts`.

**Old layout, read for one version.** Until 0.1.561 the path was `<root>/<id>/<repository>` and the gate used `lp-gate-*` folders under the
system tmp. Both layouts are two levels deep, so the hourly sweep, the daily pass and `removeLaneWorktree` find and remove either; an
attempt that started before the deploy finishes and is removed where it stands. The tmp prefixes stay in `JANITOR_TMP_PREFIXES`.

**Not moved yet: phase candidates.** A phase's candidate tree stays at `<base>/.git/lp-phases/<phaseId>` on `phase/<id>`
(`src/rooms/phase/server/candidate.ts`). Its pieces take that tree as their `project_cwd`, and a task's folder must lie inside its run
folder (`tasks/task-base.ts`, `isTaskBase`), so moving it to `<root>/<repo>/phase-<id>` needs the phase pipeline to accept a folder
outside the run first. Until then the daily pass sweeps `.git/lp-phases` as its own class once the phase branch is merged.

## 2. Removed by the code that merged it

`integrateWorktree` (`git-integrate/merge.ts`) with `removeWorktree` removes the worktree and its branch in the same call that merged it,
and answers `worktreeRemoved`. `mergeAcceptedAttempt` (`writer/server/finish-merge.ts`) asks for it for every accepted attempt, also one
that ran in a BB environment (until 0.1.561 only attempts without an environment were cleaned there, so the default path left every
accepted worktree to the hourly janitor). Only `lane/…` and `bb/…` branches are removed this way; a worktree on any other branch (a
chat's own checkout an attempt reused) is never the merge's to remove. An area task keeps its worktree for the area's next task (the
sticky sweep removes it after the window). The registry row is released by the host-call hook when the host says the worktree went.

**Cancel and drop keep unmerged work.** `removeLaneWorktree` (`worktree-lifecycle.ts`) removes the worktree folder (after saving the
uncommitted edits and unique commits as a patch when asked to `release`) and deletes the branch only when its work is in `main`:
by ancestry, by patch (`git cherry`: rebase, cherry-pick) or as a squash (`deleteBranchIfMerged`, `mergedInto`). Otherwise the branch
stays and the answer names it (`branchKept`); the hub logs it and the daily pass reports it. Until 0.1.561 it was `branch -D`.

## 3. The cleanup schedule

Two Lane Pilot schedules on the schedule board, in «every project» (project `*`), made once at start by `ensureSystemSchedules`
(`schedule/server/system-schedules.ts`); a schedule the owner deleted is not made again (pause it, or set `cleanup.worktrees=off`).
Both run the graph `lp.worktree-cleanup` (`workflows/lp.worktree-cleanup.json`), whose one step is `lp.worktree_cleanup`
(`registerWorktreeCleanupActions` in `stability/server/worktree-janitor.ts`). «Запустить сейчас» on the board runs a pass by hand;
`dry_run: true` decides and reports without removing anything.

| Schedule | Cron | What it does |
|---|---|---|
| «Уборка worktree: ежечасно» | `14 * * * *` | `runHourlyWorktreePass`: closes the registry rows whose owner is gone, then sweeps Lane Pilot's root on every connected machine (the hidden `scheduleIsolated` job before 0.1.561) |
| «Уборка worktree: ежедневно» | `40 4 * * *` (owner's zone) | `runDailyWorktreePass`: everything below, on every connected machine |

The hub reaches each machine the way the hourly janitor always did: one host call `worktreeJanitor` per connected host, now with a
`deep` part (`sweepWorktreeClasses`, `src/rooms/verification/worktree-sweep.ts`). A machine whose plugin is older answers without
`deep`; the pass names it in its errors.

**What the hub sends.** The project folders on that machine (BB's project sources and the run folders of the last 90 days); the BB
environment worktrees of Lane Pilot attempts outside the root; the worktrees of abandoned tasks; the paths live work holds (open
attempts, the registry's open rows, the trees of a phase in work); the registry's open paths; `cleanup.worktree_max_age_days`.
«Abandoned» (`dailyPassInputs`): every attempt that used the path has ended without acceptance, at least one of them was cancelled,
was followed by a later attempt of the task, or sits in a closed run, and none moved within the last day.

**What the machine does.** `git worktree prune` in every project repository, then reads every linked worktree of a swept class:

| Class | Where |
|---|---|
| `lane` | Lane Pilot's root, either layout |
| `claude` | `<repo>/.claude/worktrees/*` (Claude Code subagents) |
| `dot-worktrees` | `<repo>/.worktrees/*` |
| `lp-phases` | `<repo>/.git/lp-phases/*` (phase candidates) |
| `bb-env` | a BB environment worktree of a Lane Pilot attempt (named by the hub) |

Any other linked worktree (a release copy, a hand-made checkout, a chat's own BB environment) is not touched.

Removed, with its branch: merged (ancestry, patch or squash; a detached copy whose commit some branch holds) **and** clean **and**
untouched for N days (default 7); or abandoned and clean — then its branch goes only if merged, else it stays and is reported.
Never removed: a copy live work holds; one whose folder, HEAD or branch moved within the last day (other agents work in
`.claude/worktrees` right now); one locked by a live process; one with uncommitted changes (tracked edits or new files, not the
`node_modules` links Lane Pilot puts in); one with commits merged nowhere.

**The report.** One row per machine in `lane_pilot_janitor` with `pass='daily'`, `kept_unmerged` and `report_json` (removed and kept by
class and reason, pruned entries, registry rows closed, branches kept, the removed paths). The registry rows whose folder is gone are
closed (`released_at`). One owner line «Уборка worktree: N копий оставлены» lists the copies a person has to look at (unmerged,
dirty, locked, unreadable), keyed by the list itself (`worktree-cleanup:<hash>`): the same list the next day is the same line, a
changed list replaces it, an empty list closes it. The hourly pass writes a row only when it removed something or its kept list
changed (before 0.1.561: 347 identical rows a fortnight per machine).

## 4. Auditing a machine by hand

```sh
# Lane Pilot's root: one folder per repository, one per attempt inside (old layout: one per attempt, the repository inside)
ls ~/.lane-pilot/worktrees/*/
# Every linked worktree of a repository, with prunable entries and locks
git -C <repo> worktree list --porcelain
# Is a branch's work in main? ancestry, then patch (rebase/cherry-pick: every line starts with "-")
git -C <repo> merge-base --is-ancestor <branch> main && echo merged
git -C <repo> cherry main <branch>
# squash: the branch's whole diff has the same patch id as a commit main got since the merge base
b=$(git -C <repo> merge-base main <branch>)
git -C <repo> diff $b <branch> | git patch-id --stable
git -C <repo> log -p --no-merges --format='commit %H' $b..main | git patch-id --stable | grep <that id>
# Uncommitted work in a copy
git -C <copy> status --porcelain
```

On the hub: `SELECT host, pass, removed, freed_bytes, kept_unmerged, report_json FROM lane_pilot_janitor ORDER BY at DESC LIMIT 10` and
`SELECT host, path, owner_kind, owner_id FROM lane_pilot_worktree WHERE released_at IS NULL`. On the board, the daily schedule's run with
`dry_run: true` prints what a pass would delete without deleting it.

## Tests and drill

`tests/worktree-standard.test.ts` holds every rule above on real temp repositories (the new and the old layout, the merge of a
BB-environment attempt, cancel with unmerged commits, each class of the daily pass, prune, the hub pass with its janitor row, registry
rows and owner line, the system schedules). `tests/worktree-janitor.test.ts` holds the hourly sweep. The drill scene `parallel3`
(`scripts/lp_drill/scenes/writers.py`, `worktree_leftovers`) asserts after three accepted tasks that no worktree entry, `lane/<attempt>`
branch, folder or open registry row of theirs is left.
