---
title: Lane Pilot — handoff after 2026-10-06 (finish P1, the queue, release 0.1.167)
date: 2026-10-07
from: dev-orchestrator chat thr_dkdp2sfgxd
repo: /Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-lane-pilot
status: §1 done (0.1.167 deployed); §2–§8 open
---

# Lane Pilot handoff: what is left after 2026-10-06

> [!success] Progress 2026-10-07 (thread continuing thr_dkdp2sfgxd)
> - **§1 done.** Commits `4ed2ece` (+ merge `42372f1`) and release **0.1.167** (`c0212a4`), deployed: `lane-pilot@0.1.167 running`, GitHub release v0.1.167. Full suite 1386 passed / 2 skipped; typecheck clean.
> - The WIP rewrite of spawn/verify from `ffd166e` was undone: it ran `workspaceGitLayout` on the hub (§1.3), so the fixtures and remote projects all fell into a fake "non-git in place" branch. That rewrite caused 28 of the 30 failures.
> - P1 as shipped: a saved `in_place` reads as auto. Lane chat (`cli`) attempts always get their own worktree. A subfolder chat gets a host-made worktree of its repo and works in the same subfolder; merge and removal use the worktree top. No shared-folder serialisation and no hub-side git in start.ts.
> - **Open from §1:**
>   - plugin-page runs (`kind: "bb"`) keep the risk-threshold rule. Moving them to per-attempt worktrees means rewriting ~90 test fixtures;
>   - non-git projects were never supported by the git dirt preflight and still are not;
>   - the settings UI still lists `in_place` (`scripts/generate-ui-catalog.py`, with §6.4).
> - Version note: `0.1.166` was taken by `8316374` (a retry wording fix), so §7's release is now **0.1.168+**. The CHANGELOG entry for the 2026-10-06 work is already in 0.1.167.
> - §8: the live check of §1 on the sandbox project has not been done yet.

> [!important] Read first
> - `main` = `8316374` (version **0.1.166**, self-repair commits 0.1.164–0.1.166 on top of today's work). The hub still runs **0.1.163**. Nothing from 2026-10-06 is deployed yet.
> - `npm run typecheck` is clean. The full suite is **red: 30 failed / 1358 passed in 5 files** (list in §1). All 30 come from the unfinished P1 «worktree-only» change in commit `ffd166e`.
> - `bb-plugin-push` runs the full suite and refuses a red one. Do not use `LP_DEPLOY_SKIP_TESTS=1`.
> - Every Lane Pilot task in run `lprun_fb512041df3b4442a7753ed83a53f99d` is stopped: accepted, blocked or canceled. Nothing is queued and no reminders are pending.

## How to run this plan

The tasks are ordered. §1 blocks the rest, because a red main breaks every later check.

**Recommended: do §1 directly in a strong-model session (Opus).** A writer (acp-opencode) worked on it for 4 hours, stalled twice, and left a worse state. Its abandoned worktree is described in §1.4. §2 to §7 are ordinary tasks; a Lane Pilot PM can dispatch them in parallel once §1 is green.

Rules that cost a day on 2026-10-06:
- **Verification per task = typecheck + the task's own test files.** The full suite runs once per batch: by you, or by the integration gate once it is deployed (§9).
- **Folder filters need a trailing slash:** `tests/server/`, not `tests/server`. Vitest filters are substrings, so `tests/server` also ran `tests/server-reconcile.test.ts`.
- **These tests cannot pass inside Lane Pilot's verification sandbox** (real git, sandbox in sandbox). Exclude them from writer verification and run them yourself outside it: `tests/verification/**`, `tests/sandbox*`, `tests/scenarios*`, `tests/pipeline*`, `tests/acceptance-v2*`, `tests/stability-drill.test.ts`.
- **Never commit work that Lane Pilot blocked while its tests are red.** That is how `ffd166e` put 30 red tests on main.
- **A contract must own every file its change needs.** Example: a new stage id lives in `src/stages/contract.ts` (`STAGE_IDS`).

## 1. Make main green: finish P1 «writers always in their own worktree»

> [!note] Decision
> `.agents/decisions/2026-10-06-worktree-only-writers.md`: in_place mode is removed. A writer always works in its own git worktree, and acceptance reads the attempt's commit diff. Phase plan: `.agents/plans/items/lp-core-refactor/PLAN.md` (P1).

### 1.1 Failing tests on main (`ab9bb64`)

Run them: `npx vitest run tests/stages/server-stage.test.ts tests/writer-validate.test.ts tests/subfolder-in-place.test.ts tests/git-worktree-subfolder.test.ts tests/server-reconcile.test.ts`

<details><summary>All 30</summary>

- `tests/git-worktree-subfolder.test.ts` › refuses a writer worktree when the chat folder is a subfolder of a git repo
- `tests/server-reconcile.test.ts` › reconciles by metadata after the spawn response is lost and continues with the found thread
- `tests/stages/server-stage.test.ts` (19):
  - binds a worktree when spawn omits environmentId but threads.get has it
  - blocks worktree provision before a holder spawn when git-worktree is not listed
  - cancels a queued provider-pool attempt and never spawns it after the slot opens
  - fails closed when the provisioned worktree is dirty before writer spawn
  - fails closed without a writer when worktree provision is destroyed before ready
  - moves a task whose writer's provider answers with a plan notice to the next writer, uncharged, and opens the breaker
  - persists the critical TaskV2 risk adapter in the actual verification and writer receipts
  - pre-provisions and CAS-binds a clean risk-routed worktree before the writer
  - queues distinct task-owned outputs at provider pool size one and records both writer receipts
  - records a rejected owns-paths gate without exposing the offending path in its audit event
  - recovers a holder spawned before holder_thread_id was persisted
  - restarts the plugin and recovers queued provider work under the persisted pool limit
  - resumes the same holder after reload before the worktree is ready
  - runs a real native critic before the writer and returns persisted stage receipts
  - runs configured PM read before critique and passes its real output to critique and writer
  - runs configured specialist review on a high-risk task before spawning the writer
  - runs one emergency provider after primary provider failures and records provenance in the accepted receipt
  - runs the writer's fallbacks in turn: one that cannot start hands over to the next, before the PM's model
  - waits for a creating worktree to become ready before stopping the holder
- `tests/subfolder-in-place.test.ts` (3): does not retry the worktree on resume of an in-place fallback; runs in place when gitCreateWorktree refuses a nested chat folder; still rejects other gitCreateWorktree failures
- `tests/writer-validate.test.ts` (6): accepts a resumed attempt whose worktree holds Lane Pilot's own receipt; does not spawn when the dirt snapshot fails; escalates a retry from the first effort; fails closed when a resumed attempt has a pre-dirty path without a content hash; records automatic low when Jev overrides a saved high; returns dispatch immediately and exposes the persisted receipt through bounded wait

</details>

### 1.2 What each failure probably is

- **Real regressions, fix in `src/`:**
  - a resumed attempt with Lane Pilot's own receipt in its worktree now ends «missing expected_outputs: hello.txt»;
  - provider_error followed by an escalated retry ends blocked instead of accepted;
  - a Jev override of a saved high records `high` instead of `medium`/automatic;
  - «returns dispatch immediately»: a second attempt id appears;
  - in `server-stage`, find the shared cause first. One fixture or one changed function in `src/server/writer/{start,spawn,finish}.ts` or `src/workspace/routing.ts` probably breaks most of the 19.
- **Obsolete in_place behaviour, rewrite the test to the worktree-only rule** with a one-line comment why:
  - «fails closed when a resumed attempt has a pre-dirty path without a content hash»;
  - «does not spawn when the dirt snapshot fails». Keep the intent «no spawn on a failed workspace preparation»; the state name may change.
  - `subfolder-in-place` (3) and `git-worktree-subfolder` (1). The new rule: a chat folder that is a subfolder of a git repo gets a worktree of the repo, and the writer works in the same subfolder inside it. Never in place.
- **`server-reconcile`:** keep it worktree-based. Writer `suite-green-pm-helpers` once rewrote it to assert the base folder (`workspace_path = writerWorkspacePath`, `environment_id: null`). That is wrong; the edit was not committed.
- Do not weaken an assertion just to pass.

### 1.3 Related bug to fix in the same pass (from self-repair `thr_3bvb3743sf`)

`src/server/writer/spawn.ts` (~line 119) decides `isGitProject` with `workspaceGitLayout(project_cwd)`, which runs git **on the hub**. For a project on OVH or Mac mini the hub cannot see the folder. The result is «not git», and `dirtBefore` comes from `snapshotDirectoryHashes` on a hub path, which is empty.

Fix: decide git or non-git from the host's answer, using the `workspaceDirt` host call (see `src/workspace-dirt.ts` after `3434492`, which runs `git status -- .` on the host and strips the subfolder prefix). Never run git on the hub for a remote folder. Real non-git projects keep content-hash dirt, also computed on the host.

Tests: a new `tests/remote-git-detect.test.ts`, plus `tests/verification/subfolder-workspace.test.ts` (run it outside the sandbox).

### 1.3a `src/ui-catalog.ts` rows lost by update-queued-task.2 (self-repair `thr_a6cwfk3vmq`, fixed in 0.1.166 `8316374`)

The writer of `update-queued-task.2` reset `src/ui-catalog.ts` to git HEAD. That erased two uncommitted rows:
- **s040 `workspace.mode` without `in_place`.** This was P1 work: drop `in_place` from its values and options; `src/workspace/routing.ts` already maps in_place to auto. Restore it as part of §1.
- **s413 `verification.sandbox_unsafe`.** This is the setting row for the update-queued-task feature (the code is in `ffd166e`). Restore the row so the setting shows in the UI, and check that the dispatch check rejecting a bare `npx vitest run` reads this setting.

### 1.4 The abandoned attempt (read for ideas, do not merge)

`/Users/vechkasov/.lane-pilot/worktrees/lpattempt_a75bbee0e5484151a223d3851a5021eb/bb-plugin-lane-pilot`, writer thread `thr_n3batsrx9h`.
- 14 files changed.
- **Typecheck is broken:** `start.ts:385` `failedClass` is undefined, and `finish.ts:545` uses `.holder` on the wrong union member.
- 78 failing tests there (71 of them in server-stage).
- Its test rewrites in `writer-validate` / `subfolder-in-place` may still be useful.
- Remove the worktree afterwards with `git worktree remove` from the repo.

### 1.5 Done when

`npm run typecheck` and the **whole** suite are green on the Mac, including the sandbox-hostile files from the rules above.

## 2. P5: one writer session per task (refactor phase)

Plan: `.agents/plans/items/lp-refactor-p5-one-session.2/PLAN.md`. The last contract was `lp-refactor-p5-one-session.5`.

Why: in 14 days, 162 of 502 tasks were redispatched as `.2`/`.3`, about two thirds of them for mechanism faults.

Change:
1. When checks fail, a feedback turn goes into **the same writer thread**: «Result … / what failed → what to do / full log path». Cap: 5 turns or 120 min. Stop early only when the failure output **and** the diff are both unchanged between two turns. A new writer (next model in the chain) takes over only on a provider or limit failure.
2. A missing `expected_outputs` entry with green checks is a warning in the receipt, not a rejection.
3. Harness and infra faults park the task and restart the same task id.
4. Redispatching a family member (`<id>.N`) while one runs or is parked returns `task_in_progress` with the running id and the hint «use lane_pilot_update_task / lane_pilot_answer_writer».
5. A dependent whose dependency's family member got blocked waits up to 6 h for the next accepted member of that family.
6. One short paragraph in the PM overlay (`src/native-agent-overlay.ts`); `tests/pm-tool-mentions.test.ts` stays green.

Tests: `tests/one-session.test.ts`, plus the existing `failure-class`, `repeated-failure`, `stability`, `writer-validate` and `server-stage` tests.

## 3. Writer silence watchdog

Live case: writer `thr_n3batsrx9h` stayed `status: active` with its turn open and no events for 40 minutes, twice: 19:51→20:31 and 21:07→21:30 UTC. Its last item was a pending `read`, and nothing ran in its worktree. A `bb thread tell` («steered») woke it. The self-repair «stuck» kind only sees writers that are idle.

1. A sweep every 5 min finds running writer attempts whose thread is active but whose last event is older than `writer.silence_nudge_min` (default 20). Use the bounded thread-events helper; never scan all project threads.
2. First time: steer message «Lane Pilot: no activity for N min. Continue; if a command hangs, stop it and go on; finish with your summary.» Record it in KV `writer-nudge:<attemptId>`.
3. Second time: interrupt the turn if the SDK can, then nudge again. Third time: end the attempt `writer_silent_after_nudge`, class provider, not charged, and move down the writer chain.
4. Log one line per nudge. The wait receipt shows `nudged: n`. The sweep checks `pluginStopped` / `isDisposed`.

Tests: `tests/writer-silence.test.ts` with a fake clock.

## 4. PM instructions after the new tools

Plan: `.agents/plans/items/instructions-pm-after-tools/PLAN.md`. Do it after §2, because it describes the final loop.

1. PM overlay (`src/native-agent-overlay.ts`):
   - answer a writer's `NEEDS_HUMAN` with `lane_pilot_answer_writer` in the same thread, never a `.2`;
   - correct a not-started task with `lane_pilot_update_task` (same id);
   - verification per task = its own tests, and the batch integration gate runs the full suite and sends a failure to its culprit;
   - redispatch only to change a finished task's contract.
2. Wait receipts carry `next` from `failureClass`:
   - task → wait;
   - question → answer_writer;
   - harness/infra → parked, restarts by itself;
   - contract → update_task or redispatch;
   - limit → moves down the chain.
3. `WRITER_SETUP_LINES`: «If you need a decision, end with NEEDS_HUMAN: <one question>; the PM answers in this thread and you continue.»
4. Tests: `tests/wait-next-hint.test.ts`, `pm-tool-mentions`, `writer-brief`, `native-agent-overlay`.

## 5. Stop ripgrep «JSON record exceeded 65536 bytes» for writers

1. Add a root `.ignore` listing `dist/`, `*.map`, `.agents/runs/`, `.bb/`, `.gitnexus/`, `coverage/`, `node_modules/`, each with a short comment.
2. `src/native-hook-sources.ts` is one 61 KB line. Emit each hook as lines joined with `\n` (no line over 1000 chars). Keep it byte-identical to `lane-stack/hooks/*`; the equality test in `tests/native-session-hooks.test.ts` must stay green. Add or adjust a generator in `scripts/`.
3. Write receipts (`.agents/runs/**/lane-pilot-receipt.json`, `acceptance.json`) with `JSON.stringify(x, null, 2)`.
4. Tests: `tests/no-huge-lines.test.ts`.

## 6. Lane Pilot bugs seen on 2026-10-06

1. **Dispatch answers `terminated` but creates the task later.** Three `lane_pilot_dispatch_writer` calls for `suite-green-pm-helpers.2` returned `{error: terminated}` at about 20:20 UTC. The PM saw nothing in the DB right after. Minutes later three tasks appeared: `suite-green-pm-helpers.2`, `.2.2` and `.2.3`. Two were accepted and one blocked. Find where the bridge or tool call times out while the dispatch keeps running (pm-read / plan stages). Either make the dispatch idempotent (same id + same contract within N min returns the existing attempt) or answer before the long stages.
2. **A blocked dependency froze its dependents.** The work of `suite-green-pm-helpers` was correct and committed by the PM, but its dependents waited for a new accepted family member. A `lane_pilot_update_task` / «mark satisfied» path for a PM-verified blocked dependency would avoid the dummy follow-up task. Check this against §2.5.
3. **The workspace decision follows a setting change in the middle of a batch.** `suite-green-pm-helpers` started `in_place` («explicit_in_place») seconds before the owner's setting change took effect. With worktree-only (§1) this goes away; check that no `in_place` route is left in `src/workspace/routing.ts`.
4. **`update-queued-task.2` was blocked on `src/ui-catalog.ts` (owns_paths).** Its feature (`lane_pilot_update_task`, `src/server/writer/update-task.ts`) is in main and its tests pass. Check whether `src/ui-catalog.ts` / `ui-catalog.summary.json` need regenerating (`npm run build` may do it), and commit if so.

## 7. Release 0.1.167

1. Bump to **0.1.167** in `package.json`. CHANGELOG: 0.1.164–0.1.166 (self-repair) are there already; add a 0.1.167 section for all work since 0.1.163 that has no entry:
   - task folder + PLAN.md for writers;
   - clean retry output;
   - subfolder dirt;
   - Linux clean-clone tests;
   - PM guard (no paste, no errand edits, unscoped SQL deletion rule);
   - acceptance metrics card (P0);
   - answer_writer and update_task tools;
   - reminders follow redispatch;
   - badge phases + queue chip;
   - integration gate per batch;
   - bookkeeping files never block a merge;
   - helpers read-only on the repo;
   - authorization follows the agreed goal;
   - GitNexus/MetaMCP for code roles;
   - worktree-only (§1), plus §2–§5 if done.
2. Run the full suite on the Mac (must be green) **and on a clean clone on OVH**:
   ```bash
   ssh ovh-main
   git clone <origin> /tmp/lp-ovh-check && cd /tmp/lp-ovh-check
   npm ci && npm run typecheck && npx vitest run
   ```
   Then trash `/tmp/lp-ovh-check` with `agent-trash`.
3. `npm run build`, then `bash /Users/vechkasov/Documents/BB-сервис/infrastructure/plugin-deploy/bb-plugin-push lane-pilot` (no skip flag). Check `bb plugin list` shows `lane-pilot@0.1.167 running`.
4. Commit, then `git push origin main`, then `gh release create v0.1.167` with the CHANGELOG sections 0.1.164–0.1.167 as notes.
5. **Guard:** `lane-stack/hooks/guard_shell.py` changed (commits `26e6f53`, `5666392`, `10fc699`).
   - Copy it to `~/Documents/BB-сервис/plugins/claude-lane-stack/hooks/guard_shell.py` and commit there.
   - Install it as `~/.agents/hooks/guard_shell.py` on the Mac mini, the MacBook (`bb file write --host host_p7jhrgsapq --stdin`, then chmod 755 via `bb terminal create --host …`) and OVH. Back up as `guard_shell.py.bak-2026-10-07` first.
   - Test: `AGENT_HOOK_CLIENT=claude LANE_PILOT_AGENT_TYPE=dev-orchestrator python3 ~/.agents/hooks/guard_shell.py` with a sample payload.
6. **OVH cleanup:**
   - Trash the stray `/home/ubuntu/sites/treba-sites/templates/blog/.git` with `~/.agents/bin/agent-trash`. Version 0.1.162 created it; it holds only `info/exclude`.
   - Tell the treba-sites PM `thr_z5p24nemfu` that subfolder workspaces are fixed (0.1.164 + §1.3) and its blocked tasks can be redispatched.
7. Set `integration.gate_command` for this project: the full suite command with the sandbox-hostile files excluded.

## 8. Live checks after deploy (the owner wants them on the real system)

Use https://bb.vechkasov.pro over WireGuard, Playwright at 1280 and 390 px, and the sandbox project `proj_3tb652jpsi`. Undo every change afterwards.

- [ ] A task in this project runs in its own worktree and merges into main.
- [ ] A remote project (OVH) is detected as git and gets a worktree (§1.3).
- [ ] The PM chat badge shows a writer under verification with its phase, and the «в очереди N» chip.
- [ ] A writer thread calls gitnexus tools (count tool names in `bb thread messages <writer> --json --all`).
- [ ] A sandbox task ending `NEEDS_HUMAN` answered with `lane_pilot_answer_writer` continues in the same thread and is accepted.
- [ ] `lane_pilot_update_task` on a queued sandbox task keeps the id.
- [ ] Integration gate: after a batch drains it runs the full suite once and, on a failure, messages the culprit writer's thread.
- [ ] The acceptance-stats card shows on the Checks tab.
- [ ] A dispatch with a bare `npx vitest run` is rejected and names the exclusions.
- [ ] If §3 is done: a silent writer gets nudged.

## 9. Open decisions for the owner

- **`plan_critique.enabled = false` is set globally** (project `*`) since 2026-10-06 16:10 UTC. Every task since then skipped plan critique. The PM did not set it. Ask the owner whether that was intended.
- The section `481b8b80-9d9d-48c5-894f-ec3a79a7f2b3` (lane-pilot plugin folder) has its workspace isolation override removed, so it falls back to the default «Выбирать автоматически». After §1 the setting should no longer have an in_place option.

## 10. Later phases (not started)

From `.agents/plans/items/lp-core-refactor/PLAN.md`:
- **P2:** failure codes set where a failure happens, not regex over text. Example: git on Linux says «Unable to write index» without «index.lock».
- **P3:** the PM guard by paths and capabilities instead of command text.
- **P4:** delete dead in_place / dirt-baseline code after P1.

Measure with the acceptance-stats card (P0). The target is first-try acceptance ≥ 60% (34% on 2026-10-06) and a redispatch rate < 5% (32%).
