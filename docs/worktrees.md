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
  - src/rooms/stability/server/worktree-daily-pass.ts
  - src/rooms/schedule/server/system-schedules.ts
  - src/rooms/writer/server/finish-merge.ts
  - workflows/lp.worktree-cleanup.json
  - tests/worktree-standard.test.ts
  - tests/worktree-schedule-e2e.test.ts
  - tests/worktree-coverage.test.ts
  - src/rooms/host-worker/handlers/git.ts
  - src/rooms/schedule/server/schedule-executors.ts
  - src/rooms/workflow/server/workflow-triggers.ts
  - src/rooms/workflow/server/pm-notice.ts
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

**Nothing writes into an attempt's worktree after the merge.** The folder is gone the moment the merge answers, so every write that
belongs to the attempt (OUTCOME.md, notes, evidence) happens before the merge or goes to the task's own folder in the base checkout.
0.1.561 broke this once: `writeTaskOutcome` wrote OUTCOME.md into the removed folder and self-repair fixed it (commit `91e0790f`, the
write is skipped for a task folder that no longer exists). A new post-merge step must read from the base checkout, never from the attempt's path.

**Cancel and drop keep unmerged work.** `removeLaneWorktree` (`worktree-lifecycle.ts`) removes the worktree folder (after saving the
uncommitted edits and unique commits as a patch when asked to `release`) and deletes the branch only when its work is in `main`:
by ancestry, by patch (`git cherry`: rebase, cherry-pick) or as a squash (`deleteBranchIfMerged`, `mergedInto`). Otherwise the branch
stays and the answer names it (`branchKept`); the hub logs it and the daily pass reports it. Until 0.1.561 it was `branch -D`.

## 3. The cleanup schedule

Two Lane Pilot schedules on the schedule board, in «every project» (project `*`), made once at start by `ensureSystemSchedules`
(`schedule/server/system-schedules.ts`); a schedule the owner deleted is not made again (pause it, or set `cleanup.worktrees=off`).
Both run the graph `lp.worktree-cleanup` (`workflows/lp.worktree-cleanup.json`), whose one step is `lp.worktree_cleanup`
(`registerWorktreeCleanupActions` in `stability/server/worktree-daily-pass.ts`, beside the daily pass; the hourly pass and the registry are in `worktree-janitor.ts`). «Запустить сейчас» on the board (`bb lane-pilot schedule
run-now <id>`) runs a pass by hand.

**Who may start the graph.** `lp.worktree-cleanup` is a starter graph (`startedBy: "worktree-cleanup"`): never offered to the PM or the
router, refused by `lane_pilot_run_workflow` and by `bb lane-pilot workflow-trigger`. The one exception is its own system schedule: the
schedule executor reads the row's `created_by` (`system:worktree-cleanup-hourly|daily`, written by the server at insert, kept by every
update, so no chat can claim it), finds its `starter` in `SYSTEM_SCHEDULES` (`systemStarterOf`) and passes it to `workflowTriggers.start`,
which lets a starter graph through only when its `startedBy` equals that starter. The run is detached: no PM chat, no run link. A schedule
the owner or a chat makes naming the same graph fails `start_failed` (0.1.562 shipped without this exception: both schedules ended
`start_failed` and no pass ran). The graph is an upkeep graph for the end-of-run notice (`UPKEEP_WORKFLOWS` in `workflow/server/pm-notice.ts`):
a successful pass messages no one (its output's `report` would otherwise be delivered as an owner line every hour); the daily pass posts its
own line below, and a failed run is the schedule board's line.

**By hand, with a report.** `bb lane-pilot worktree-cleanup` runs the hourly sweep, `--daily` the daily pass, `--dry-run` the daily pass
deciding only (nothing removed, no janitor row, no owner line; a dry run is always the daily pass's, it covers Lane Pilot's root too),
`--json` the graph's output shape. It calls the same `runWorktreeCleanupPass` as the graph's step; the schedules are not touched.

| Schedule | Cron | What it does |
|---|---|---|
| «Уборка worktree: ежечасно» | `14 * * * *` | `runHourlyWorktreePass`: closes the registry rows whose owner is gone, then sweeps Lane Pilot's root on every connected machine (the hidden `scheduleIsolated` job before 0.1.561) |
| «Уборка worktree: ежедневно» | `40 4 * * *` (owner's zone) | `runDailyWorktreePass`: everything below, on every connected machine |

The hub reaches each machine the way the hourly janitor always did: one host call `worktreeJanitor` per connected host, now with a
`deep` part (`sweepWorktreeClasses`, `src/rooms/verification/worktree-sweep.ts`). A machine whose plugin is older checks the input
against its own strict contract and refuses the unknown `deep` key: the call fails there, nothing is removed on it, and the pass's errors
say «this machine's Lane Pilot host is older and has no daily pass (update the plugin there)»; when every machine is older the run ends
`error` and the board shows it. Its hourly sweep keeps running (that call has the old shape). A dry run sends an endless `graceMs`, so
even a host that ignored `deep.dryRun` would remove no worktree.

**What the hub sends.** The project folders on that machine (BB's project sources and the run folders of the last 90 days); the BB
environment worktrees of Lane Pilot attempts outside the root; every BB environment of that machine with a folder (`bbEnvironmentsByHost`:
`environments.list`, and `threads.list({ archived: false })` for which of them a live thread is in; `managed` = BB's provider made it as
a worktree); the bounded home search (`WORKTREE_SEARCH`); the worktrees of abandoned tasks; the paths live work holds (open attempts,
the registry's open rows, the trees of a phase in work); the registry's open paths; `cleanup.worktree_max_age_days`.
«Abandoned» (`dailyPassInputs`): every attempt that used the path has ended without acceptance, at least one of them was cancelled,
was followed by a later attempt of the task, or sits in a closed run, and none moved within the last day. A BB that refuses the
environment list is an error line of the pass (no environment is then removed through BB, none is known to be live), not a failed run.

**Which repositories the machine looks at.** The folders the hub names (two levels down), the repositories of Lane Pilot's root and of
the BB environments, and since 0.1.565 a bounded search under the machine's home (`searchRepos`): 5 levels down, never into a dot
folder (`.git`, `.cache`, `.bb-machines`, `.claude`…), a symbolic link, `node_modules`, `dist`, `build`, `vendor`, `target`, `venv`,
caches or media folders; a folder with a `.git/HEAD` is a repository (nested ones are still found), a folder with a `.git` file is a
linked worktree and is not entered (its repository lists it). It stops at 2000 repositories or 3 minutes and says so (`truncated`).
Measured on OVH (2026-11-14): 30 903 folders read, 88 repositories, 3.4–5.3 s; 7 levels read 132 955 folders in 23.6 s and found the
same 88, so 5 is the bound. (The audit's 388 «repositories» also counted ones inside dot folders and dependencies; every place its
table names on OVH except `/tmp`, which is outside home, is reached.) `~/tools/claude-lane-stack`, which no project names, is found this way.

**What the machine does.** `git worktree prune` in every repository it looks at, then reads every linked worktree and decides:

| Class | Where |
|---|---|
| `lane` | Lane Pilot's root, either layout |
| `claude` | `<repo>/.claude/worktrees/*` (Claude Code subagents) |
| `dot-worktrees` | `<repo>/.worktrees/*` |
| `lp-phases` | `<repo>/.git/lp-phases/*` (phase candidates) |
| `bb-env` | a BB environment its provider made as a worktree (`managed`), wherever it is |
| `outside` | any other linked worktree: a release copy, a hand-made checkout, a deploy copy, a BB environment folder BB no longer lists |

Removed, with its branch: merged (ancestry, patch or squash; a detached copy whose commit some branch holds) **and** clean **and**
untouched for N days (default 7); or abandoned and clean — then its branch goes only if merged, else it stays and is reported.
Never removed: a copy live work holds; one a thread that is not archived works in (a BB environment of a live thread, also an unmanaged
one pointing into `.claude/worktrees`); one whose folder, HEAD or branch moved within the last day (other agents work in
`.claude/worktrees` right now); one locked by a live process; one with uncommitted changes (tracked edits or new files, not the
`node_modules` links Lane Pilot puts in); one with commits merged nowhere.

**Outside the managed classes: listed, never removed.** A detached deploy copy can be merged, old and still the one a site runs from,
so «merged and old» is never enough there. Each such copy is a `skip` decision with whether it is merged (or how many commits are
merged nowhere), its age, its uncommitted changes and its size, and one owner line «Worktree вне классов Lane Pilot: N копий» lists them
(`worktree-outside:<hash>`, one line per distinct list, like the kept list).

**BB environments: BB removes them.** A managed environment with no live thread (every thread in it archived or deleted), merged,
clean and older than the limit is a `remove` decision `via: "bb"`: the machine does not touch it, the hub calls
`bb.sdk.environments.delete({ environmentId })` and BB's provider runs `git worktree remove` (BB itself refuses while a live thread is
in it; that answer keeps the copy with reason `error`). An environment of a thread that is not archived is kept (`live-thread`) with
its facts, so the owner sees what archiving the thread would free. A BB environment named without BB's id (an older hub) is kept
(`no-environment-id`); a folder under BB's environment root that BB no longer lists is only listed (`bb-env-unlisted`). No folder is
ever removed behind BB's back.

**The report.** Every linked worktree looked at is one decision (`decisions`: machine, path, repository, class, `remove`/`keep`/`skip`,
reason — `merged`, `abandoned`, `protected`, `live-thread`, `young`, `recent`, `locked`, `dirty`, `unmerged`, `no-environment-id`,
`error`, `outside`, `bb-env-unlisted` — with merged how, age, uncommitted and unmerged counts, size). `bb lane-pilot worktree-cleanup
--dry-run --json` prints them with the search per machine; the text report names the first 30 removals («удалилось бы: …» in a dry
run) before the kept and outside lists. One row per machine in `lane_pilot_janitor` with `pass='daily'`, `kept_unmerged` and
`report_json` (removed, kept and skipped by class and reason, pruned entries, registry rows closed, branches kept, the removed paths,
the search, the first 1000 decisions). The registry rows whose folder is gone are closed (`released_at`). One owner line «Уборка
worktree: N копий оставлены» lists the copies a person has to look at (unmerged, dirty, locked, unreadable), keyed by the list itself
(`worktree-cleanup:<hash>`): the same list the next day is the same line, a changed list replaces it, an empty list closes it. The
hourly pass writes a row only when it removed something or its kept list changed (before 0.1.561: 347 identical rows a fortnight per machine).

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
`SELECT host, path, owner_kind, owner_id FROM lane_pilot_worktree WHERE released_at IS NULL`. `bb lane-pilot worktree-cleanup --dry-run`
prints what a daily pass would delete without deleting it (no need to edit the system schedule's inputs).

## Tests and drill

`tests/worktree-standard.test.ts` holds every rule above on real temp repositories (the new and the old layout, the merge of a
BB-environment attempt, cancel with unmerged commits, each class of the daily pass, prune, the hub pass with its janitor row, registry
rows and owner line, the system schedules). `tests/worktree-coverage.test.ts` holds the decision list (one per worktree, each class and
reason, a real pass removing exactly the `remove` ones), the bounded search (a `.worktrees` copy of a repository no project names is
found; `node_modules`, a folder below the depth and a `.git` folder without HEAD are not), the `outside` skip of a detached merged
copy, the BB environment rule on the machine and from the hub (`environments.delete` on a real pass, none on a dry run, BB's refusal kept). `tests/worktree-schedule-e2e.test.ts` runs both schedules the way the hub does: rows made by
`ensureSystemSchedules` through the real schedule service, fired by the real scheduler (cron tick and run-now), started by the real
executor and `workflowTriggers.start` on the real library (`loadStore("*")`), run by the real engine, judged by the real end-of-run notice;
only the host call is a stub, checked against the current or an older strict contract. `tests/worktree-janitor.test.ts` holds the hourly
sweep. The drill scene `parallel3` (`scripts/lp_drill/scenes/writers.py`) asserts after three accepted tasks that no worktree entry,
`lane/<attempt>` branch, folder or open registry row of theirs is left (`worktree_leftovers`), and that both cleanup system schedules are
on the board and their last finished run did not fail (`cleanup_schedule_problems`).
