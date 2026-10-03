# Changelog

## 0.1.96 — 2026-10-03

- **`lane_pilot_lesson` for the PM.** A correction or a burned approach becomes a rule proposal on the hub — repeats merge, new ones go on trial within the 12-rule cap — instead of a `.agents/LESSONS.md` line. The PM instructions say so; `lane-memory lesson` (Lane Stack 1.64.0) does the same from terminal sessions.

## 0.1.95 — 2026-10-03

One project memory on the hub, wherever the work runs.
- **Session memory API.** `session_memory_project` (which project and section a folder on a machine belongs to), `session_memory_write` (through the same door: no credentials, no instruction overrides), `session_memory_search`, `session_memory_core`. Claude Lane's `lane-memory` uses them through `bb plugin rpc call`, so a PM chat on the Mac mini and a terminal session on OVH read and write the same memory.
- **Lessons are rule proposals, not a file.** `session_lesson` turns a correction into a rule proposal: one close to a live rule counts as its repeat (word overlap ≥ 0.6), a new one goes on trial right away within the 12-rule cap, and at most 30 lessons wait — older ones expire. Before, `.agents/LESSONS.md` grew without bound (≈150 entries in SelfyStudio) and every writer read all of it.

## 0.1.94 — 2026-10-03

- **«Передать в новый тред» keeps Lane Pilot.** BB starts the new thread from the thread composer, where no profile is attached, so a handoff from a PM chat came up as a plain Claude chat. The first message of a handoff starts with «Continue from @thread:<id>» on a thread mention; when that thread has a Lane Pilot profile of the same project, the new chat takes it, with a run of its own. A plain mention of a PM chat, or a handoff from an ordinary chat, stays ordinary.

## 0.1.93 — 2026-10-03

- **Project memory is visible.** «Memory and documents» lists what the project memory holds — facts and rules, newest first, with kind, date and concepts — and a wrong or outdated fact can be removed. A rule's record is removed with the rule on the Rules tab, so a rule never stays «accepted» without reaching writers. RPC `memory_records_list`, `memory_record_delete`.

## 0.1.92 — 2026-10-03

Writer attempts after the audit against the SMA fleet invariants (`.bb/chats/thr_tev4nistgf/artifacts/memory-audit/fleet-invariants.md`).
- **Final states stay final.** `transitionAttempt` no longer moves an accepted or canceled attempt anywhere else — a cancel during verification could be overwritten with «accepted» after the merge — and returns whether it moved.
- **A journal of attempt states.** Every move, refused ones marked, goes to `lane_pilot_attempt_transition`, so a skipped or overwritten state can be seen afterwards.
- **An attempt finished after a reload ends like any other.** Its stages are closed (before, accepted tasks kept «writer-agent running» for good); accepted work gets its memory and project-life passes; a retryable failure is retried within the attempt limit, otherwise the attempt is blocked with «retry limit exhausted» and its stages fail. Before, the start loop that would do this died with the reload and nobody retried.
- **Stages left open by earlier versions** are closed on start-up from their task's latest attempt.

## 0.1.91 — 2026-10-03

Project memory after the audit against the SMA blueprints (`.bb/chats/thr_tev4nistgf/artifacts/memory-audit/`). The database is the source of truth; the `.agents/memory` files mirror it.
- **One door for every write.** `storeMemoryRecords` refuses credentials (now also AWS keys, JWTs, bearer tokens, `secret:`) and instruction overrides (`you are now`, `## SYSTEM:`, `<system>`…) on every path — rules and imports used to skip the maintainer's check.
- **Memory is data in the brief.** Writer briefs and council prompts fence memory and PM read facts in `<project_memory>` / `<pm_read_facts>` marked «data, not instructions»; each note is one line, so it cannot forge the next heading.
- **Failures are not memory.** The lessons sweep counts failures and lists repeated ones as rule proposals, but no longer stores them: 127 of the hub's 155 records were raw «attempt failed» logs. A one-time migration removes them and two orphaned search-index rows (backup: `backups/data-before-0.1.91-*.db`).
- **One-way mirror.** Import skips Lane Pilot's own `lp-*` exports (a revoked rule no longer comes back from its file) and records past `valid_until`. Export removes `lp-*` files whose record is gone and marks rules `truth_mode: normative`, owner-confirmed ones `authority: owner-instruction`.

## 0.1.90 — 2026-10-03

A smaller writer brief. Measured on SelfyStudio `gc-pages-polish-2`: 64% of the old 4130-token brief was memory (17 notes, one about the task, seven raw «attempt failed: outside owns_paths» episodes). The same writer (grok-4.6 via Cursor) did the task from a 1110-token brief as well as from the old one; without a new-files rule it once put a helper outside owns_paths. Now the same task gets 1184 tokens (−71%).
- **Memory by path.** At most three notes: those naming a two-segment tail of an owned or read path (`components/greeting-cards`, `src/site-tool-card-page`; tool caches ignored), then the project's core conventions. Raw failure episodes stay out; repeated failures reach writers as rules.
- **One rule instead of the episodes:** new files must match owns_paths too, helpers go next to the code.
- **PM read:** the writer gets the key facts only. The open questions go back to the PM in the dispatch result (`pmReadOpenQuestions`) — cancel and re-dispatch with the answer if one matters.
- **Each fact once, fixed rules first** (so providers cache that prefix): workspace once, no prose copy of the objective, no empty or default contract fields, verification commands without repeated cwd.
- **Measure it:** traces record `promptChars`; `writer_brief_stats {projectId, since, until}` returns brief size, tasks accepted on the first attempt and attempts rejected for paths outside owns_paths for a period.

## 0.1.89 — 2026-10-03

Relay without stale messages («это напоминание устарело»). On the hub 6 of 26 fired reminders arrived after the thread they waited on had already answered, and 15 more were PMs polling «check whether task X merged» by time.
- **An answer closes the reminders that waited on it.** When the asked thread answers — with `lane_pilot_reply` or by finishing its turn — the asker's open reminders watching that thread close silently; on a settle the passed-back answer comes first and the reminder does not follow it.
- **No second copy of an open question.** Asking the same thread again while the first question still waits returns that question with `alreadyWaiting` instead of queueing a stale copy behind it.
- **Reminders on tasks.** `lane_pilot_remind` takes `taskIds`: the reminder fires the moment every listed task is accepted, blocked or canceled, with their states; `inMinutes` is only the fallback. No polling, nothing stale.

## 0.1.88 — 2026-10-02

From the project-folders PM's report (4 dispatches of one task, each rolled back although the writer's own `npm run typecheck && npm test && npm run build` passed):
- **`bb plugin build` works inside the check sandbox.** The sandbox moves HOME into a temp folder, so `bb` looked for its build toolchain there, tried to download it and failed with «Cannot find module 'npm/package.json'»; every BB plugin whose check builds it failed acceptance. The sandbox now passes the real `BB_DATA_DIR` (seatbelt and bubblewrap); writes stay limited to the workspace and temp.
- **A retry after a reload starts from the run's workspace.** An attempt resumed after a reload is bound to its own worktree; when it failed, the retry inherited that path, the worktree was already removed, and the snapshot failed with «spawnSync /bin/bash ENOENT». New attempts (and the emergency writer) now start from the run's workspace; the resumed attempt itself is still checked in its worktree.

## 0.1.87 — 2026-10-02

- **A docs repair taken into the running turn no longer hangs its unit.** After sending the repair round, the docs unit waited for a `turn/started` that came after the request. Codex sometimes takes the follow-up into the turn it is still finishing (`turn/input/accepted`, no new `turn/started`; 275 of 3267 requests on the hub). The wait has no deadline, so the SelfyStudio unit `apps/worker/docs` of 2026-09-29 waited for three days and blocked the folder's nightly pass. Each plugin reload stopped it and the next one resumed it, which logged «docs resume failed … stale API handle» at every deploy. Now the end of the turn that accepted the follow-up ends the wait. A follow-up nobody takes fails through BB's error events, like a first turn, instead of waiting forever. `turn/input/accepted` counts as a started session.
- **A unit of a night long gone is dropped, not finished.** A unit more than two days past the start of its night is no longer resumed: its list of files dirty before the agent is stale, and what is dirty now would pass for the agent's changes and be reverted. Its pages stay for the next pass.
- A reload that stops a docs unit in this instance is no longer logged as a failure; the next instance resumes it.

## 0.1.86 — 2026-10-02

Self-repair repairs what is still broken and leaves what is already fixed:
- **Only failures under the running version count.** Each occurrence is stamped with the Lane Pilot version that was running; a failure from before the current release waits to happen again. Two of the first three repair threads spent their run proving a fix had already shipped — this stops that.
- **Verdicts.** A repair thread ends with `SELF-REPAIR-VERDICT: fixed | already-fixed | not-lane-pilot | needs-owner`; the watcher reads it. Fixed kinds come back only if they happen again under a newer version (or a day later with the same version); not-ours and owner-decision kinds stay quiet for a week.
- **More detectors:** «writer changed no files» and other failed states; running attempts whose writer is idle, failed, stopped or gone; tasks queued for 2 hours while nothing runs in their run; stages left pending/running after their task ended (live: two accepted SelfyStudio tasks); any unfamiliar reason seen in 3 tasks within a day. `needs_human` and `depends_on` stops are by design and ignored.
- **A watchdog for the watcher.** `scripts/self-repair-watchdog.sh` runs from launchd on the Mac mini every 30 minutes; if Lane Pilot does not answer or its watcher made no pass for 45 minutes, it starts the repair thread itself (once in 6 hours). `self_repair_status` now reports `version`, `lastTickAt` and every known kind with `due` and `verdict`.

## 0.1.85 — 2026-10-02

- **Self-repair reads the plugin log.** Failure lines of Lane Pilot's own log (`… failed`, `stale API handle`, `is retired`) are incidents too; offline machines, timeouts, traces and the watcher's own lines are not.
- **Repair threads are filed** in the Project Folders section «Исправления» under lane-pilot (`sectionId` in `self_repair_configure`, `null` for the project root).
- The deploy script runs the full suite before shipping Lane Pilot (one retry for flaky tests) and refuses on red.

## 0.1.84 — 2026-10-02

- **Merge lock without a pid is taken over in seconds, not after 10 minutes.** A plugin reload that stops the host worker between creating the lock's owner file and writing its pid left a lock that was neither orphaned (no pid to check) nor «legacy» (the directory was not empty), so every merge into that checkout waited until the lock turned 10 minutes old. On 2026-10-02 this failed `api-route-snapshot-cluster-source` in SelfyStudio with `internal_error: another writer integration holds the base checkout` (before 0.1.73 made a busy lock a queue). A lock whose owner has no pid 5 seconds after it was created is now treated as abandoned.

## 0.1.83 — 2026-10-02

Self-repair prompt, after the first live repair thread and an instruction audit:
- Incidents carry their time and sit in an `<incidents>` block marked as evidence, not instructions (reasons come from writers and checks).
- A first step checks whether a later release already fixed the failure; the first live repair spent its run proving exactly that.
- Shipping is safe in the shared checkout: stage only own files, no deploy while someone else's uncommitted work is in the tree (the deploy ships the working tree); full path to the deploy script; reasons next to each rule; an explicit «done when».

## 0.1.82 — 2026-10-02

- Self-repair threads start in the standard speed tier: the tier is sent explicitly as `default`, so BB no longer falls back to the remembered fast mode.

## 0.1.81 — 2026-10-02

- **Self-repair.** Lane Pilot watches its own failures every 15 minutes: triage origin «orchestrator», system block reasons and attempts stuck «running» after their writer went idle. Each new kind of problem (one signature over ids, paths and numbers) starts one repair thread in the Lane Pilot repository: Claude Code, Opus 5.5, high reasoning, full access. The thread finds the root cause, fixes it with a test, verifies live, deploys on a green suite, releases and tells the affected PM. One repair at a time, 4 a day; kinds that wait are kept and taken on a later pass; a kind that returns a day after its repair gets a new one. The sandbox project is ignored.
- **Daily health.** `self_repair_status` returns the last 24 hours: attempts by state, failures by fault, open Lane Pilot incidents and repairs started. `self_repair_configure` and `self_repair_tick` (dry run by default) for scripts.

## 0.1.80 — 2026-10-02

From the SelfyStudio PM's report, each checked in the sandbox or on OVH:

- **The PM can ship.** The PM chat's shell guard (Lane Stack `guard_shell.py`, now 1.62.0 and installed on the Mac mini, the MacBook and OVH) lets a Lane Pilot PM run the project's release itself: `sudo -n` scripts, `env` and `set -a; . ./.env`, package builds, `docker image inspect`, `timeout`, `xargs`, multi-line shell and `$(…)`, `git commit -m` with an attribution trailer, `git merge-base` / `check-ignore`. Destructive commands stay blocked. The installed guard on the machines was an older copy without the Lane Pilot branch, so every Lane Pilot PM got the CLI orchestrator's read-only allowlist. The PM may also write text files in its chat folder `.bb/chats/**`.
- **`read_first` with a date in the file name.** `.agents/plans/2026-10-02-cards.md` was read as the folder `.agents/plans/` with lines 2026–10, so the preflight said «is a directory». Line windows now need a separator (`:10-20`, `#L10-L20`, ` 10-20`).
- **Wildcards inside names in `owns_paths` / `never_touch`.** `*_greeting_cards_core/**`, `src/**greeting-card*` and `packages/*/.vite/**` now match; one matcher serves the whole plugin. Correct work was rejected two or three times.
- **Prisma in a writer's worktree.** `node_modules/.prisma` and `@prisma/client` are copied, not linked to the read-only base, so `prisma generate` in a check no longer fails with EROFS.
- **Workspace `dist/` stays current.** After a merge Lane Pilot rebuilds, in the base checkout, the workspace packages the merge changed that have `dist/` and a build script, so the next writer's worktree copies fresh output (reported per merge as `rebuilt`).
- **`depends_on` holds a task** until every task it names is accepted; a blocked dependency blocks it, a name no one dispatched blocks it after two minutes.
- **`lane_pilot_wait_writer` returns a compact result**: per stage only task, stage, state and reason, long strings cut. About 9 KB for a two-task run instead of over 1 MB for SelfyStudio.
- Plan critique's coverage scan skips `.bb/`, `.claude/` and `.lane-pilot/`: chat history no longer produces false `owns_gap` warnings.

Verified live: a sandbox PM ran the guard commands and wrote to `.bb/chats/…/tmp`; tasks A (`owns_paths: notes/dep/*-a.md`, `read_first` with a dated plan) and B (`depends_on: [dep-a]`) were dispatched together, B waited («writer dep-b waits for depends_on dep-a») and both were accepted in order; `wait_writer` answered with about 9 KB. A PM on OVH ran `sudo -n true`, `sudo -n env FOO=1 true`, `set -a; . /dev/null`, `timeout docker`, `xargs`, `$(hostname)`. On OVH a SelfyStudio worktree got real, writable `.prisma` and `@prisma/client` folders. The post-merge rebuild is covered by a test only.

## 0.1.79 — 2026-10-02

Found by checking 0.1.78 in the real BB page (https://bb.vechkasov.pro, headless Chromium), not in tests:

- **«Back to …» did nothing after using the search.** The suggestion list sat in the page flow; a click on the button blurred the search field, the list closed and the button jumped up from under the pointer, so no request was sent. The list now floats over the page.
- **The wrong skill came first.** Searching «ru-text» offered a skill that only mentions ru-text in its description first. Exact names now come first, then the same name under a plugin prefix (`lane-stack:ru-text`), then names starting with or containing the query, then description matches.
- **Tabs scrolled out of sight.** Nine tabs did not fit the settings column, so «Overview» and «Execution» were scrolled off the left edge. The row now wraps onto a second line; phones keep the menu.

Verified live in the real BB page at 1280 and 390 px: a project change to the writer's skills (picked from suggestions) showed «project» and 3 skills, «Back to role» restored it; a global change showed «global» in the project and was reset the same way; no horizontal overflow on the phone and no page errors.

## 0.1.78 — 2026-10-02

- **Agent access in «Global settings» too.** Role access set there is the default for every project; a project or a section overrides any role. The order is spelled out on the tab: role profile → global → project → section.
- **Where each value comes from.** Cards and rows say «role default», «global», «project» or «section» instead of «changed»; the session-filter mode shows its level as well. «Back to …» names the layer underneath and removes the row, so that layer shows through (saving an empty value used to hide it instead).
- **A summary matrix** at the top of the tab: every helper with its BB plugins, skills, MCP servers, CLI plugins and both instruction switches, the origin under each name; a click opens the role's card. On a phone the table scrolls inside its own box.
- **The main agent (PM) card** explains what the PM loads and why it is not narrowed, and points to Project Folders «Session context» for narrowing a PM chat.
- `reset_project_settings` accepts `helper.access.<role>`; `helper_access_view` reports `origin`/`modeOrigin` and serves the global scope (skill catalog from the first project).

Verified on the hub: a global change to the writer's skills showed up in a project as «global» and disappeared after the reset.

## 0.1.77 — 2026-10-02

- **New settings tab «Agent access» («Доступы агентов»).** For each of the 20 kinds of helpers Lane Pilot spawns — grouped as writing code, reviewing, keeping the project, browser, specialists — a card shows what it loads into its session and where that comes from: BB plugins, skills, MCP servers, CLI plugins, personal and project instructions, each marked «by role» or «changed». Any group can be switched to «Everything BB has» or «Only selected» with a chip editor over the BB plugin and skill catalogs; the mandatory project checkout, Project Folders and `bb-bridge` stay locked in. «Back to role» drops the change. A footer says which providers honour which groups. The session-filter mode moved here from «Execution».
- Changes are stored per role (`helper.access.<role>`) on the project or a section; a section changes only the roles it touches and inherits the rest. A run freezes them with its helper policy.
- New RPC `helper_access_view`.

## 0.1.76 — 2026-10-02

- **Helpers load only what their job needs, by default.** New helper context mode «By role» (now the default): every helper Lane Pilot spawns gets the profile of its role instead of everything BB has — 43 plugins and descriptions of ~500 skills (about 39 thousand tokens). Writers, code repair and night fixes: two coding skills (`writer-practices`, `karpathy-guidelines`). Plan and code critics, specialist review, night review, gate triage, PM read, council seats, the rules analyzer: nothing extra. Docs maintainer: docs skills, no plugins. Onboarding, memory, project life: their own skills. Browser check: the browser-automation plugin and skill. Specialists: the skills from their agent definition. Every profile keeps the mandatory project checkout, Project Folders and `bb-bridge`, and leaves out the user's personal instructions and claude.ai skills; the project's own AGENTS.md/CLAUDE.md stay. The PM itself is not narrowed. «Everything BB has» (explicit inherit), «Only the lists below» and «None» work as before.
- The nightly docs pass and the rules analyzer, which run outside a PM run, follow the same profiles.
- Grok (Cursor) writers get their BB skills narrowed too, on the VK core `0.44.0-vk.15` and later; Cursor's own skill folders on the machine stay as they are. On an older core Lane Pilot leaves skills out of the profile instead of refusing the helper.
- A core without required session policies runs helpers with BB's ordinary context instead of refusing them.

Measured on codex writers in the sandbox: first-turn input 27–35 thousand tokens with everything vs 14.4 thousand with a narrowed context. Verified live on a Grok writer «by role»: its thread carried the role snapshot (mandatory plugins, two coding skills, `bb-bridge`), the task was accepted, and the memory and project-life helpers passed under their profiles. Cursor does not report token counts to BB, so its saving is not measured.

## 0.1.75 — 2026-10-02

- **A helper context of their own for writers, critics and specialists works on the VK core.** The fork now carries required session policies and compiled main agents (`0.44.0-vk.12` and later): settings «Helper context: selected / none» are written with each helper thread at spawn and enforced on every turn. The core keeps them in reserved thread plugin metadata, with no migration or protocol bump, and advertises `markerStorage: "thread-plugin-metadata"` instead of `hostDaemonProtocolVersion: 216`; Lane Pilot accepts both.
- `vk-requires.json` matches the code: only the composer dispatch and plugin lifecycle functions are required; session policy, required session policy and compiled main agent are optional.
- README describes the whole plugin and the experimental core it needs.

Verified live: with «selected» (skill `ru-text`, plugin `lane-pilot`) a codex writer started with the required snapshot and its marker in place and the task was accepted. The first tries found a core bug: a codex child inherited the PM's «claude.ai sync off» from Project Folders and was refused; fixed in `vk.14`.

## 0.1.74 — 2026-10-02

- **Tasks run side by side only when they cannot touch the same files.** Before a writer takes a pool slot, Lane Pilot checks the open tasks started earlier on the same checkout (any run of the project); if their `owns_paths` may overlap (one pattern's literal folder contains the other's), the task waits for them instead of conflicting at the merge. Disjoint tasks still run in parallel up to `ops.pool_size`. The wait shows on the `writer-agent` stage («waiting for <task> … owns_paths overlap») and in the plugin log.
- **Overlapping tasks are no longer refused at dispatch.** The structural plan check reported `owns_overlap` as an error and blocked the second task; it is now a warning, and the tasks run one after another.
- **Tool caches inside monorepo packages are not the writer's change.** Vitest wrote `packages/contracts/.vite/vitest/…` during a check, and SelfyStudio's `baseline-green-arch` was rejected as «changed paths outside owns_paths». Cache folders (`.vite`, `.vitest`, `.turbo`, `.cache`, `.parcel-cache`, `node_modules`, Python caches) are ignored at any depth, and a writer's worktree excludes them from git so they never reach main.
- **The relay no longer wakes a waiter while the watched thread still runs a background command** started before the watch began: it reads the thread's background command count from BB's thread list of its environment, not only from events.
- Deploy script (`bb-plugin-push`, outside this repo): a reload no longer waits for writers, which keep working in their BB threads; it waits only for attempts in acceptance (writer thread idle, attempt updated in the last 30 minutes: checks and the merge into main), up to `LP_DEPLOY_WAIT_MIN` (10) minutes; `LP_DEPLOY_FORCE=1` overrides. Recovery reruns an interrupted acceptance anyway; this avoids cutting a merge in half.

Verified live: three tasks dispatched at once in the sandbox, A owning `notes/par2/**`, B `notes/par2/b.md`, C `notes/solo2/c.md`: B waited for A (log «writer par2-b waits for par2-a»), C ran alongside, all three merged into main without conflicts. A PM watching a thread whose `sleep 180` was already running in the background was woken only after it ended. A deploy went out while two SelfyStudio writers worked; both carried on.

## 0.1.73 — 2026-10-02

Agents no longer wait for the owner when another thread or time will resolve a block.

- **Merges queue instead of failing.** When another task holds the base checkout, the integration answers «busy» with the holder (the lock now records what it merges) and the accepted attempt waits up to 15 minutes, trying every 20 seconds, instead of failing after 2 minutes. The writer's work stays committed in its worktree throughout.
- **A blocked receipt says who holds it.** `lane_pilot_wait_writer` returns `blockedBy`: the kind of block, the holder's task, thread and attempt, since when, and when to look again.
- **Relay: questions, answers and reminders between threads.** New tools for the PM: `lane_pilot_ask` queues a question into another thread without interrupting it; `lane_pilot_reply` sends an answer back; `lane_pilot_remind` wakes this chat after N minutes, or earlier when a watched thread finishes its turn; `lane_pilot_relay_list` lists and cancels. The plugin server does the waking: a BB `thread:changed` subscription reacts at once, and a 30-second sweep service catches what events miss. A thread that finishes without answering has its last message passed back. Limits: 6 questions an hour between two threads, 10 open and 30 daily reminders per thread.
- **«Settled» means really free:** not running a turn, nothing queued for it (a queued question still waits for its turn), and no background command or agent at work. A turn that ends while `sleep` or a build runs on in the background no longer wakes the waiters.
- **A merge that waited 15 minutes in vain sets the PM a reminder** that watches the holder, so the PM resends the task as soon as the checkout is free.
- **The PM's instructions have a block ladder:** retry what is yours, ask the holder and set a reminder, back off 5/10/20 minutes, and only after three reminders without progress, or for a decision that is the owner's, write to the owner.

Verified live in the sandbox: a PM asked a thread that ran `sleep 120` in the background, set a 15-minute reminder watching it and ended its turn; the BB event woke it once, 2 min 19 s later, when the holder really freed the checkout, with the holder's answer passed back.

## 0.1.72 — 2026-10-02

- **A browser check reaches a dev server on another machine over the private VPN, not getbb.app.** The machine the check runs on reports its WireGuard address (new host call `vpnAddress`: the first private IPv4 on a `wg*`, `utun*`, `tun*` or `tailscale*` interface), and the check opens a localhost target there (`http://10.8.0.4:<port>/`) with the server listening on all interfaces. `bb connect expose` is used only when the machine has no VPN address.
- **A blocked browser check can run again,** whatever stopped it (no QA machine, offline, unreachable port); only a verdict on the product, passed or failed, is final.

Verified live: a PM on OVH, a writer merged into main, then the check's agent started the dev server on OVH and the BB browser on the Mac mini opened `http://10.8.0.4:8765/` at 375 px: passed, with a screenshot. OVH's firewall now admits TCP 3000–9999 from 10.8.0.0/24 on wg0 only.

## 0.1.71 — 2026-10-02

Browser checks, tried end to end from OVH with a dev server:

- **A dev server for the check.** `lane_pilot_browser_qa` takes `devServer`, the command that serves the target. The check's thread starts it in a BB terminal of its own thread, waits until the URL answers, shares the port with `bb connect expose` when the browser is on another machine, and closes the terminal at the end.
- **A check that never ran can run again for the same task.** One blocked before it started (no Browser QA machine yet, machine offline, disabled) used to keep that receipt for good («already has a receipt; create a new task»); a restart also tripped «illegal stage transition blocked -> pending», and a restarted stage in `pending` answered «browser_qa_already_dispatched» without running. A check that actually ran still keeps its verdict.
- **The BB-browser check needs no project copy on the QA machine.** `browser_qa_workspace_required_for_cross_host` now applies only to the script backends; the check's thread runs in the PM's environment and drives the browser on the Mac mini remotely.

Live on OVH: the check's agent started `python3 -m http.server 8765` in its terminal and got 200. Sharing the port failed in BB connect for OVH («machine label assignment failed: HTTP 404»): OVH is enrolled through https://bb.vechkasov.pro, which has no connect gate.

## 0.1.70 — 2026-10-02

Two failures behind SelfyStudio's API and bot tasks not reaching main, both from a host restart in the middle of a merge (a plugin deploy restarts Lane Pilot on every machine):

- **A merge lock left by a killed process no longer blocks the next merge.** The lock folder `.git/lane-pilot-integrate.lock` now names its process; when that process is gone the next merge takes it over at once. Before, a lock was stale only after 10 minutes while a merge waited 2, so the API task failed with «another writer integration holds the base checkout». An ownerless lock left by an older Lane Pilot is taken over too.
- **Work already committed in an attempt's own worktree counts.** Lane Pilot commits the writer's work before merging; cut off between the two, the re-check after the restart saw a clean worktree and marked the finished bot task «writer changed no files». Validation now also counts the worktree's commits since it left main (against main's current HEAD), so such an attempt is accepted and merged.

## 0.1.69 — 2026-10-02

- **Writers' checks see the project's machine variables.** Every variable BB keeps for the project (Settings → machine environment: the global ones and the project's own) now reaches a check in the sandbox, so tests that need `DATABASE_URL` or an API key can pass. Only names travel through Lane Pilot: the terminal's shell, which BB started with the values, hands them in as `${NAME+"NAME=$NAME"}`, so values never reach Lane Pilot or its logs. The sandbox's own `PATH`, `HOME` and temp folders always win. Variables can be imported from Env Catalog into the machine environment.
- **Jev's key comes from Env Catalog.** The server reads `TYPESAFE_API_KEY` from Env Catalog (cached 10 minutes) and sends it with each Jev call (plan effort, council judge, the docs stages); a machine falls back to its own env or `~/secrets/typesafe.env` only when the catalog has no key. The plugin log says once which source is in use, never the key.

Verified live in a sandbox PM run: the writer's check `test "$LP_SMOKE_VAR" = "lp-ok"` passed in a BB terminal with the variable set on the project, and the log showed «jev key: from Env Catalog».

## 0.1.68 — 2026-10-02

- **Writers' checks have network access.** The verification sandbox now keeps the host network (bubblewrap `--share-net`, no `deny network*` in seatbelt) while writes stay limited to the task's folder and a temp folder. Before, every `curl` check, and every test that reached an API or a dev server, failed by construction.
- **A writer's checks run in a BB terminal of the writer's thread,** inside the same sandbox, titled «Lane Pilot check: …». Open the writer's thread to watch a check live; BB reports its output and exit code. Where BB terminals are unavailable, Lane Pilot falls back to running the check on the host as before. New host calls `sandboxCommandLine` and `sandboxRelease`.
- A check without its own time limit was waited for only 30 s while the sandbox allowed 120 s; both now use 120 s.
- The plugin log records where each check ran: «verification in terminal term_… of thread …» and its exit code, or why it fell back to the host.

Verified live: a sandbox PM run's writer passed `test -f`, `grep -q` and `curl -fsS https://example.com` in three BB terminals of its thread, exit code 0 each.

## 0.1.67 — 2026-10-02

Checked against SelfyStudio on OVH, in the same sandbox Lane Pilot uses: both blocked tasks' checks now pass in a fresh writer worktree (marketing vitest 38/38; bot tests and typecheck, exit 0).

- **A writer's worktree gets the Nuxt app's generated `.nuxt/`,** copied like the packages' `dist/`. Without it vitest stopped at «Failed to load tsconfig '.nuxt/tsconfig.json'».
- **A folder written with a trailing slash in owns_paths or never_touch now covers everything under it** (`apps/bot-thin/src/handlers/__tests__/`, `docs/`). The acceptance check only understood `/**`: the bot task's own test was rejected as «outside owns_paths», and never_touch folders such as `apps/api/` guarded nothing. It now follows the same rule as the rest of Lane Pilot: a plain path is that file or everything under it.

## 0.1.66 — 2026-10-02

Two failures behind SelfyStudio's blocked blog and bot tasks, both in Lane Pilot:

- **Checks in a writer's worktree could not write vite's cache.** The worktree's `node_modules` mirrored every entry of the base checkout's as a link, `.vite-temp` included, so vitest wrote its bundled config into the base checkout, which the verification sandbox mounts read-only: `EROFS` on every marketing test. Tool caches (`.vite-temp`, `.vite`, `.vitest`, `.cache`) now get their own empty folder in the worktree.
- **A writer resumed after a plugin reload failed with «ownership run scope invalid».** For Lane Pilot's own worktrees the task's folder was always set back to the base checkout, which is right once the attempt has finished but wrong for one still at work, whose diff then did not match. An attempt in flight now keeps its worktree.

## 0.1.65 — 2026-10-02

- **Working helpers show as squares next to the agent badge** above the message box of a Lane Pilot chat: one per writer, specialist, browser check, council seat or critic that is still working, with its role's icon and a pulse. Hovering names the role and the task. A click opens that thread in the chat's right-hand side panel (BB's own thread view), so you can watch it without leaving the chat; where the surface has no side panel it goes to the thread. New RPC `list_helper_threads`, new side-panel tab «Помощники Lane Pilot».
- The agent badge tests had been failing since 0.1.50 (the badge stopped copying the box's radius); they now match the badge, and the whole suite is green.

## 0.1.64 — 2026-10-02

Third step onto BB rails: writers work in BB's own worktree environments.

- **A writer's isolated copy is a BB «Рабочее дерево» environment** whenever the run works in the project's own checkout on that machine (SelfyStudio on OVH, for one). BB creates it, it shows in BB as an environment, and its threads, diff and cleanup are BB's. Lane Pilot still links the dependencies and package builds before the writer starts, and still merges the accepted work into main of the project folder. A chat in a section with its own repository keeps Lane Pilot's git worktree in `~/.lane-pilot/worktrees/`, because BB's worktree always forks the project root.
- **Worktrees are cleaned up when the run closes** (finish or the sweep): their threads are archived and BB retires the environment about five minutes later. While the run is open the writers' threads stay readable.
- Checked live in «LP sandbox rules», twice: the writer ran in `…/environment-git-worktree/…`, was accepted at the first try and merged into main; after the run closed BB destroyed the environment on its own.

## 0.1.63 — 2026-10-02

- **Writers in their own worktree could not start.** Lane Pilot made each attempt's worktree inside the plugin's data dir, which sits in BB's storage on the host; BB now refuses a thread there unless it is one of its own environments (`HTTP 409: Workspace path is inside bb-managed storage but is not a workspace of this project`). Every SelfyStudio writer on OVH failed this way. Worktrees now live in `~/.lane-pilot/worktrees/` on the host. The PM chat's «Project checkout» was right all along.

## 0.1.62 — 2026-10-02

Second step onto BB rails: the browser check runs in the BB browser, in a thread you can open.

- **`lane_pilot_browser_qa` starts a child thread that drives the BB browser** through the Browser Automation plugin on the project's Browser QA machine (the Mac mini): a BB Desktop tab when one is open there, otherwise a headless session whose live view shows in the thread. It goes through every case on every viewport, looks at a screenshot for each, and ends with a JSON verdict that Lane Pilot stores in the stage receipt; the PM gets the `@thread` link. A «passed» without every case passed on record counts as blocked.
- **Works wherever the chat runs.** The thread runs in the PM's environment (OVH, say) and opens the browser on the QA machine; a localhost target is shared with `bb connect expose` first. Checked live: an agent on OVH drove headless Chrome on the Mac mini, at 375 and 1280 px, with screenshots, and its verdict parsed.
- New default `browser_qa.backend = bb-browser` («Браузер BB в треде проверки»). The old runner scripts stay available as `chrome-qa`, `live-chrome` and `headless`.
- **The browser check failed on every native project.** It read the old prototype config, which only 5 projects have, and stopped with «task does not belong to this PM run». It now uses `configForRun`.

## 0.1.61 — 2026-10-02

First step of putting Lane Pilot on BB rails: every agent a PM hands work to is a thread you can open.

- **Specialists are child BB threads.** `lane_pilot_specialist {role, task}` starts design-lead, copy-lead, seo-specialist or tavily as a child thread of the PM chat, in the PM's environment, with that role's Lane Pilot profile; `lane_pilot_wait_specialist` returns the answer, and the PM shows the owner the `@thread` link. Before, they were Claude Code subagents: BB showed only «a background agent is running», with nothing to open. The PM profile keeps `Agent(Explore, Plan)` only, for quick read-only lookups.
- A specialist works inside its PM's run: its profile selection carries `parentRunId`, so the dispatch hook binds the profile without opening a run of its own.
- The profile selection behind «Enable Lane Pilot» and behind specialist threads is built in one place (`storeNativeSelection`).
- Checked live in «LP sandbox rules»: the PM called tavily, which ran in its own thread with its own rules and answered; one run, the PM's.

## 0.1.60 — 2026-10-02

Runs that hung in «выполняется» for days.

- **Runs close when nobody can return to them.** A run opens per Lane Pilot chat and stayed «running» forever after the chat was deleted or archived, and runs that never got a PM chat stayed «pending». A sweep at start and every 15 minutes closes those (`closed_by = sweep`); live and idle chats, runs with an open attempt and chats that could not be read are left alone. On the hub it closed 19 runs; 10 more with long-idle chats were finished by hand at the owner's request.
- **Recovery after a reload works for native runs.** Resuming an orphaned writer read the old prototype config, which only 5 projects have, so on SelfyStudio and the rest a finished writer was never picked up and its attempt stayed «running». Recovery now uses `configForRun`, like the rest of the native pipeline.
- **Startup recovery runs after the plugin has loaded,** as a background service. Run inside the factory, it reached the host while that was not callable yet and failed two old SelfyStudio attempts with «host plugin calls are unavailable during factory registration»; that is the reason recorded on onboarding-s1-backend and onboarding-s1-cabinet, not their writers' work.
- **«Прогоны» name the PM chat** of an open run and say whether it is working, waiting or deleted, instead of a bare run id.

## 0.1.58 — 2026-10-02

- **The project's main agent now drives its chats.** With a main agent chosen in a project, every new chat there starts with Lane Pilot on and that agent picked; turning it off in the chat keeps it off for that chat. With «Без специального агента» Lane Pilot stays off until you turn it on. `activation_context` reports the project's `mainAgent`.
- The «this hub cannot start a custom main agent» note is gone: it was about the old compiled launch, which chats do not use.

## 0.1.57 — 2026-10-02

- **One radius scale.** Selected menu rows were 10px on 32px rows and read as pills; rows, buttons and inputs are now all 8px, segments 6px in a 9px track, inner cards 12px, panels 16px. The scale is written into `app.css` and the pokecut-theme skill.

## 0.1.56 — 2026-10-02

- The left menu starts on the same line as BB's page header strip, so the grid is even.

## 0.1.55 — 2026-10-02

«Обслуживание» shows what is on the machine and offers only the action that is needed.

- **Lane Pilot on the project machine comes first,** read live when the tab opens: «Установлен и работает», «Устанавливается…» (re-read every 5 s), «Ещё не установлен» with the reason it installs itself on first use, «Машина недоступна», and the last install error. «Установить сейчас» / «Повторить установку» appears only when the machine answers and Lane Pilot is missing there. New RPC `native_install_status`.
- **The old Lane Stack buttons only where they work.** Detect, install, OpenCode and rollback need the CLI-mode setup that 5 projects have; on SelfyStudio and the rest they failed with «prototype is not configured». They now sit, folded, under «Lane Stack для CLI-прогонов» only on those projects (`get_screen` reports `legacyStack`). Before a check there is only «Обнаружить»; «Установить» (or «Обновить») appears when the check finds Lane Stack missing or off target, «Подключить OpenCode» when OpenCode is there without the plugin, and «Откатить» only when a pre-install snapshot exists, in its own «Если после установки что-то сломалось» block.
- The Overview row says Lane Pilot installs itself on first use and points to Maintenance for its state.

## 0.1.54 — 2026-10-02

- **No settings search.** With the settings split into tabs it only squeezed the Basic/Advanced switch on a phone; the switch now has the row to itself.
- **The «?» sits like an exponent:** a small circle raised to the top of the line right after the title's last word, as in x². Tapping it opens the help; the touch area is larger than the circle. Settings rows, block titles and the Agents screen all use it.
- **Council seats show their model picker straight away,** with «из настроек стадий» or «своя модель» next to the seat name; «Вернуть наследование» appears only for a seat with its own model. Only a choice made by hand is saved: a picker that normalizes its value on opening no longer writes seven seats.
- **Council sessions are a compact list:** at most two lines of the question, a coloured status pill and the round, the five latest first and «Показать все» for the rest. On iPhone the question was shown in full, because WebKit ignores line clamping on a button.

## 0.1.53 — 2026-10-02

Lane Pilot now looks like the Pokecut theme BB already wears (after https://pokecut.rakibulism.space).

- **Nested cards.** Every block is a gray well with a hairline: the title sits in the well, the content in a white card with a soft drop. The project title sits in a quiet header strip.
- **Segmented controls.** The tabs, «Основные / Расширенные» and the language switch are gray tracks with the chosen option raised in white.
- **Buttons.** Primary actions wear the pink-violet gradient; secondary buttons are white with an outline and a soft shadow; «Откатить» is a soft red button.
- **Navigation.** Project and section rows are quiet until chosen; the chosen one is a raised white pill.
- **Statuses.** Run and attempt states are soft tinted pills: green when accepted, blue while running, red when failed. The Overview checklist marks sit in small tiles.
- **Switches** are gradient when on. Inputs and selects are white with an outline.
- The Council page, rules from lessons and the Agents screen use the same cards and pills.
- One stylesheet, `app.css`, holds these tokens. It reads the Pokecut theme's colours and falls back to BB's own, so the plugin stays tidy under any theme, light or dark.

## 0.1.52 — 2026-10-02

The settings screen, reorganised so that someone opening Lane Pilot for the first time can find their way around, on a phone as well as a desktop.

- **Eight tabs instead of five long ones.** A project or section opens on «Обзор», then «Исполнение», «Проверки», «Совет», «Память и документы», «Правила», «Прогоны» and «Обслуживание». Each tab holds one topic: «Правила из уроков» moved out of «Память и документы», and the council settings and sessions moved out of «Проверки» and the run monitor. A section has no «Прогоны» or «Обслуживание», because runs and installs belong to the project and its machine. «Общие настройки» keep the four settings tabs.
- **«Обзор» says what to do first:** whether a writer model is chosen, where to check Lane Stack, how to start a run from a chat, and how many runs are going on. The project's machine and folder and its main agent moved here from the top of every tab.
- **One «Расширенные» switch instead of a dozen grey bars.** The advanced rows under each setting appear when the switch is on or while searching. «Контекст помощников», which the current BB cannot use, is shown only in advanced mode. A search shows matches from all settings tabs at once.
- **«Прогоны» is one card per run with its attempts inside.** Runs in progress come first, then the newest. The history opens 20 at a time, so SelfyStudio's monitor is no longer 190 000 px tall. Stage receipts are folded.
- **«Обслуживание» explains its buttons.** Each install action says what it does. «Откатить» is no longer a red button next to «Установить». Diagnostics are folded under «Технические подробности».
- **On a phone, the menu lists a project's sections,** indented as in the tree, and the tabs become a select. The language switch moved into «Общие настройки».
- **The machine shows by name,** for example «MAC Mini» instead of `host_7sea4qaad8`.
- **«Что говорят прогоны» counted first-try acceptance wrongly.** Attempts are numbered from 1, but the count expected 0, so every pair showed 0%. A pair is also no longer called «the best on record» when it is the only one. The lines are now in the screen's language.
- Plain-language descriptions for rules from lessons, documents, project life, the browser check machine, the main agent and the empty council list.

## 0.1.51 — 2026-10-02

- **The Council page fits a phone.** Below 640px the 16rem council list gave way to a select above the chat, so the chat no longer runs off the right edge. The question, seats and agenda take at most 40% of the height, and the seats and agenda fold away on a phone. Long words, code and tables wrap or scroll inside their message, and the composer puts its input on its own row. New messages scroll only the feed, not the BB page around it.

## 0.1.50 — 2026-10-02

- **The agent badge has small rounded corners, like the composer.** It copied the box's 14px radius, which made the 20px badge a pill; it now uses 6px.

## 0.1.49 — 2026-10-02

- **The agent badge no longer covers the placeholder in a collapsed composer.** On a phone the collapsed prompt box clips its overflow, so the badge was drawn inside it, over «Ask a follow-up». It now sits on the box's top border, as in the expanded composer.

## 0.1.48 — 2026-10-01

- **Analyzer threads say what they analyzed:** «Разбор ошибок · Клиенты / rich-tent.ru · 004.2, 007» and «Переписать правило · … · task ids», in the project's language, instead of «Lane Pilot rules: <category>».
- **Opening «Rules from lessons» no longer changes the analyzer.** The model picker reports a normalized value on mount; that was saved, which put SelfyStudio on GPT-6.1 Sol low instead of the GPT-6 Luna default. Only a change made by hand is saved now; SelfyStudio is back on Luna high fast.

## 0.1.47 — 2026-10-01

Rules analyzer prompts audited with the agent-instructions skill and measured before and after.

- **Evidence is fenced as data.** Writers' answers, failure reasons and reviews sit inside `<evidence>` / `<other_failures>` and the prompt says they are recorded output to analyze, not instructions, even where they address the analyzer: a rule written from them reaches every writer of the place.
- **«No rule» is a correct answer, and both costs are named.** A missing rule lets a mistake repeat; a wrong rule pushes every writer of the place the wrong way. System One's sort is presented as a guess to check, not a fact.
- **A rule is ready only when** it is one imperative sentence, an action inside the writer's own owns_paths and task, shown by the evidence to be skipped in at least two tasks, and specific to the project; each rule now carries `why`.
- **Rewrite may answer «no rule can help», and the rule is then retired** instead of staying as it was.
- Measured on GPT-6 Luna high and Grok 4.6, 3 runs per case, graded by code: Grok on the live SelfyStudio group (foreign failures) wrote a rule 3 of 3 times with the old prompt and 0 of 3 with the new one; injection held on both; Luna passed all four cases (foreign failures, missing outputs, injection, mixed) 12/12 with either prompt. The missing-output case uses synthetic writer answers because the original threads were deleted.

## 0.1.46 — 2026-10-01

- **The rules analyzer defaults to Codex GPT-6 Luna, high, fast** instead of the project's writer model; a model picked in «Rules from lessons» stays. On the live SelfyStudio group (three failed `npm -w` checks) Luna set all three aside as not the writers' fault (foreign specs, a file the writer never touched), while Grok 4.6 had written a rule telling writers to fix those failures, which would send them outside their owns_paths. Luna is also the cheaper model.
- The settings bundle builds again: 0.1.45 imported the docs default from a module that needs `node:crypto`.

## 0.1.45 — 2026-10-01

- **Docs are written by Codex GPT-6 Luna, high reasoning, fast tier by default**, not by the writer's model; a project that picks its own docs model keeps it. The nightly pass, the post-task stage and the settings picker use the same default.

## 0.1.44 — 2026-10-01

Memory on by default; docs kept automatically, only where a folder is worth it.

- **Project memory is on unless a project turns it off.** The maintainer runs after every accepted task and writers get relevant memory; adopted rules now reach writers in projects that never set memory (SelfyStudio among them). Projects that set it explicitly keep their choice.
- **Docs have three modes: Auto (default), Always, Never.** Projects that had docs switched on keep Always; unset ones are Auto. The settings switch is a select.
- **Auto judges every folder on every machine on its own.** The same section can be an advertiser's artifacts on one machine and working code on another. A host call reads what the folder is made of: code, test and content files, languages, package manifests, deploy files, the folder's own commits in 30 days, docs pages. Code settles the clear cases: not a git repository, no code, no commits and no docs yet → no docs; code with a package manifest, or 50+ code files → docs. System One judges the rest (scripts beside content without a manifest). The verdict is stored per machine and folder and asked again when the deciding facts move or after 30 days.
- **Docs nobody reads go quiet.** A task «reads» a folder's docs when its read_first or execution packet names a docs page. After 60 days without a read the folder's pass runs weekly (Mondays of its machine), after 120 days it pauses; a read brings it back to nightly.
- **One folder's docs pass at a time** across all projects: passes queue instead of running side by side.
- The post-task docs stage skips a folder Auto judged not worth docs. «Docs» lists every folder per machine with its verdict, reason, facts, cadence and last read, with «Re-evaluate».
- Calibrated on the owner's 65 folders on Mac mini and OVH: plugins, ohmy-seo, telegram-ads-assistant, SelfyStudio and treba keep docs; client, ads, SEO and paperwork folders are not repositories; muse and the landing templates have no code; treba-sites goes to System One (needed, 0.82).

## 0.1.43 — 2026-10-01

Rules learn on their own, inside the section they come from.

- **The system adopts the analyzer's rules on trial.** No button: a rule the analyzer writes goes into force at once, marked «on trial» (12 rules in force per project at most; over the cap it waits and the journal says why). Proposals the analyzer wrote earlier join on the next scan. Owner decisions are never touched by the trial.
- **A trial is judged by what happened to the writers who got the rule.** Counts come from what is already recorded, the attempt trace's picked rules and the triage's match of a failure to a rule, so nothing is counted twice: 5 attempts given the rule without the mistake confirm it; 2 writers given it repeating the mistake send it to the analyzer with those failures for a new wording (2 per scan at most); the same after the second wording retires it; a rule no task needed for 60 days leaves. A failure of a writer that was not given the rule does not count against it.
- **Every night.** At 03:30 each project with runs in the last 30 days rescans, adopts and judges, in the language of its last manual scan.
- **Rules stay in their section.** A writer mistake climbs the project's sections only as far as needed to reach three tasks: three in «Clients / rich-tent.ru» make a rule for rich-tent.ru alone, one each in three clients make a «Clients» rule, scattered ones a project rule. A writer gets only the rules of its own section and the sections above it, so one client's rule never reaches another client's writer; System One picks among those. Runs that did not record their sections are placed by their writer folder; failures match only rules of their own sections.
- Its migrations come after the triage migrations: the first build put them before and shifted a statement the hub had already applied, so the hub refused the reload and kept 0.1.42. A lineage test now pins the 62 statements the hub applied.
- **The block shows the trial.** Each rule says its section, who adopted it, on trial or confirmed, the wording number, how many writers got it and how many repeated the mistake anyway; a journal lists every adoption, confirmation, rewrite and retirement with its reason. The owner can still revoke any rule.

## 0.1.42 — 2026-10-01

- **Lane Pilot can be enabled from a chat again.** BB 0.5 rejects `sourceThreadId` on a spawn that is not a fork («sourceThreadId requires an originKind»), and the PM was spawned with it, so «Enable Lane Pilot» from an ordinary chat and `bb lane-pilot activate` failed. The PM is now the chat's child without a source; writer placement takes the PM's parent as its source when BB stores none (helpers already dropped the field). Found by the live sandbox check of 0.1.41.

## 0.1.41 — 2026-10-01

- **A writer reads only the rules its task needs.** Before a writer starts, System One gets the task contract (objective, paths, acceptance, interfaces, invariants, verification commands) and one yes/no question per accepted rule; a rule goes into the prompt from p(yes) 0.3 up. Without an answer every rule goes in, as before: a missing rule costs more than an extra one. Calibrated on 60 SelfyStudio contracts with the analyzer's live rule and a deploy rule: 2 of 59 needed rules missed, 4 of 61 unneeded added; without interfaces and invariants terse release tasks («Ship 6ce641636b») were missed. The attempt trace records which rules were picked out of how many (`dispatchContext.rulesPicked`).

## 0.1.40 — 2026-10-01

- **Text-grouping drafts leave once Jev answers.** A scan that reached System One deletes the fallback's undecided `sweep` proposals; decided ones stay, and the fallback recreates drafts only when Jev is unavailable. On the hub the two 0.1.37 drafts (bookkeeping noise in 40 and 11 SelfyStudio tasks) were still waiting for the owner next to the analyzer's rule.

## 0.1.39 — 2026-10-01

Fixes from the first live scan on the hub (SelfyStudio, 45 failures).

- **Code decides ownership rejections it can judge.** Jev called 26 SelfyStudio failures the writer's fault; 20 of them were ownership rejections of paths the task itself owns, the sibling never_touch union fixed in 0.1.24. Rejected paths are now split into owned, bookkeeping and outside the task's scope with Lane Pilot's own glob rules: a gate that rejected owned or only bookkeeping paths is Lane Pilot's fault without asking Jev, and Jev sees only the paths really outside the task. Over all 103 hub failures of 30 days: 56 decided in code, 12 writer mistakes left (missing expected files, broken project tests, an unowned test file), each checked by hand.
- **Stored answers are versioned.** Changing facts, questions or code verdicts re-asks every stored answer once.
- **A scan cut off by a restart is reported as interrupted** instead of staying «running» with the button locked (the hub's BB server restarted 23 s into the first scan).

## 0.1.38 — 2026-10-01

Rules from lessons now come from sorting by meaning instead of masked failure text. The 0.1.37 grouping proposed Lane Pilot's own old bug (bookkeeping files counted against writers) as a writer rule.

- **System One sorts every failed writer attempt.** One Jev call per attempt through the project's machine (`councilJudge`) answers whose fault it is (writer, Lane Pilot, environment, task contract, unclear), what kind of writer mistake it is, and whether an existing rule already covers it. Code computes the facts Jev needs (bookkeeping-only paths, internal error codes, prose expected outputs). Answers are stored per attempt and reused until the failure text changes; new failures of active projects are sorted every 15 minutes.
- **Calibrated before use.** On 35 labelled hub failures writer-or-not came out 35/35 in two runs and the category 7/7; the five-way origin is about 74 % and is shown as information only.
- **The analyzer model writes the rules.** «Rescan» in «Rules from lessons» sorts the last 30 days, then for every category with writer mistakes in at least three tasks a hidden thread on the chosen analyzer model reads the task contracts, failure reasons, critiques and the tail of each writer's answer and writes up to three rules citing task ids. It also lists where else the same mistake happened and drops failures that are not the writer's. The analyzer model has its own picker in the block, the project's writer by default.
- **Evidence on every proposal.** A proposal shows the tasks it stands on; tasks already cited, matched to a rule or set aside by the analyzer are not proposed again, so a second scan costs nothing when nothing new failed.
- Without Jev on the project's machine the scan falls back to the 0.1.37 text grouping, which now also leaves out rejections that name only `.agents/`, `.bb/`, `.claude/` or `PROGRESS.md`.

## 0.1.37 — 2026-10-01

Two ideas from the «Harness and Loop Engineering» write-up (thread thr_58hvcw4qtg): a loop needs a hard exit when a task cannot be done, and lessons should turn into rules a human confirms.

- **A writer can stop and ask.** When the contract contradicts itself or the code, or a file, access or product decision it needs is missing, the writer answers `NEEDS_HUMAN: <question>` and changes nothing. The attempt ends `blocked` with `needs_human: <question>` at once: no second attempt, no emergency writer, and the PM is told to put the question to the owner. Before, such a task burned two attempts and ended as «retry limit 2 exhausted».
- **Repeated lessons become rule proposals.** A writer failure with the same shape in at least three tasks over 30 days (paths, numbers and hosts masked; one task counts once however many stages recorded it) becomes a proposal. Failures of the run machinery (`internal_error`, worktree provisioning, execution packets, merge conflicts) and plan critiques are left out: no writer rule can prevent them. The PM can reword a proposal with `lane_pilot_rule_propose`; `lane_pilot_lessons_sweep` lists the waiting ones.
- **The owner decides in settings.** «Memory and docs» gets «Rules from lessons»: edit the wording, accept or reject; accepted rules can be revoked. An accepted rule is a `core` project memory record for writers (CLI export marks it `always`), and every writer prompt carries the rules in force in their own block, repair prompts included. Revoking removes the record.
- **Lessons see validation failures.** `collectLessonSources` read only `failed`, `blocked` and `rejected` attempts, while most real rejections end in `validation_failed` and `blocked` carries «retry limit exhausted», which is filtered as noise. On the hub that left 50+ ownership rejections out of lessons.
- Not done on purpose: running checks only for changed modules. On the hub 11 of about 130 failed attempts in 10 days failed a verification command, and nearly all of those were the environment (no network in the sandbox, `bb` missing, `false`).

## 0.1.36 — 2026-10-01

- **One broken machine no longer takes Lane Pilot down.** With core lifecycle support back on the hub (0.44.0-vk.3), every load runs `enable` on each registered machine to repair Claude Lane. The MacBook's Codex CLI was broken (missing `@openai/codex-darwin-arm64`), its `nativeInstall` failed, and the whole plugin failed to load on every machine. Enable and disable now carry on past a failing machine and keep its error under `native-install:error:<host>`, cleared by the next success; removal stays strict so files are never left orphaned.
- Tests: the page-mounting UI file gets a 20 s budget (each test mounts the settings page, 1–3 s alone); the hourly docs test holds the docs child explicitly instead of relying on being the first to poll it. Three full runs green in a row.

## 0.1.35 — 2026-10-01

The suite is green for the first time since the server split: 915 passed, 0 failed (27 failed on 0.1.34), `tsc` clean (6 errors before). Two production bugs surfaced while fixing it.

- **A PM started without a source thread can dispatch writers again.** Every helper spawn (writer, critic, council turn) needs the parent's source and lifecycle owner; a root `bb` PM — Enable without a source chat — has neither, so each writer spawn failed with `helper_parent_relation_missing` (hub log, 2026-09-27, 8 rejected attempts). A root PM thread is now its own source and owner, as a native CLI root chat already was.
- **A repaired revision is re-critiqued.** After a repair the new code-critique row inherited the repair ledger's `spawnAttempted`, so `claimStageSpawn` refused, the old critic thread was adopted and its previous `changes_requested` re-read: the repair was never reviewed and the task ended blocked.
- **The real spawn error survives reconcile.** A rejected spawn used to read only «reconcile completed on a short page without a matching thread», which hid the cause above for days; the original error now leads the reason.
- **Git arguments are parsed, not grepped.** The guard reads `git commit/push/merge` arguments with shlex, so a commit message that mentions forced pushes or the hook-skip flag is text; `git push -uf` and `git push origin +main` are now caught.
- **Tests no longer depend on another chat's temp folder or on machine state.** Upstream comparisons use a pinned Claude Lane Stack v1.38.0 (`tests/upstream-fixture.ts`: env, legacy snapshot, cached `git archive` of the pinned commit from the sibling checkout, or a clear skip). The npm-isolation test checks that a run leaves the host's global npm unchanged instead of requiring it to be empty. Stale tests follow the current contracts: worktree merge via `gitIntegrate`, execution packets that name files and line windows, background memory after acceptance, the native installer, current error texts. A page-mounting UI test runs one scenario per test instead of five mounts in one 5 s budget.
- Type fixes: `collectAgentInventory` lists skills only with a project id; managed-workspace binding falls back to the configured host explicitly.

## 0.1.34 — 2026-10-01

Instructions audit against Anthropic's «Prompting playbook» (thread thr_syz25bgrhk).

- **The PM ships the way the project runs.** «Ship» no longer hinges on `scripts/deploy.sh`: after every task is accepted the PM pushes main to origin (never force), brings the project up by its own deploy or start command (PROJECT.md, README, package scripts, deploy script, docker compose, systemd) and proves it is live with a healthcheck or a request; with no way to run the project it says so after the push. The PM prompt now ends with a done criterion.
- **A denied PM edit points to `lane_pilot_dispatch_writer`.** In a Lane Pilot chat the guard used to answer «delegate mutations to the run supervisor», an agent the PM prompt forbids and Lane Pilot strips. The terminal orchestrator keeps the old route.
- **`wt-merge-main` and `run-init` are blocked by the guard in a Lane Pilot chat**, not only by the prompt: Lane Pilot merges accepted work itself. Read-only `run-validate` stays allowed and the prompt no longer forbids it.
- **Project git hooks run on writer commits.** `integrateWorktree` committed the writer's worktree with the hook-skip flag, while the merge into main ran hooks and the guard forbids that flag to agents. A rejecting hook now fails the attempt with the hook's output, and the retry has to satisfy it.
- **The guard reads commands, not report text.** Destructive checks (hook skip, force push, DROP/TRUNCATE, DELETE without WHERE, recursive force delete) skip heredoc bodies handed to a non-shell program; a heredoc piped or fed to a shell is still checked. Force-push flags are read inside the `git push` command and case-sensitively: `git commit -F msg && git push` was denied as a force push; `+refspec` now counts as forced.
- **Rules carry their reasons.** One docs rule with its reason («Lane Pilot writes docs nightly and reverts other edits») for every session; reasons for the PM's autonomy, the shell-edit ban and the specialists' former bare prohibitions; the list of agents the PM may not spawn is gone because code already strips them.
- **Handoff recipients are described.** The registry showed only each agent's «You are **x**» header; every agent now has a one-line summary of what it does and leaves to others, used for listing and for picking a recipient by request.
- **Night review blocks only on real defects**: a concrete unmet requirement, broken behavior, a security or data-loss risk; style is a warning at most.

## 0.1.33 — 2026-09-30

- The chair's decision no longer fails on an over-long field: strings are clipped to the schema ceilings with an ellipsis. A live session had failed on a 300-character metric.
- A council interrupted by a plugin reload is marked failed with the reason instead of staying «in session» forever; `bb lane-pilot council-seats <project>` shows the pair every seat would get and the pairs the stage selections offer.

## 0.1.32 — 2026-09-30

- **Council seats no longer save a model by themselves.** The settings panel shows which pair each seat would take from the stage selections; a picker appears only after «Задать свою модель», and «Вернуть наследование» drops the seat back. The earlier version let the picker report the catalog's first model as a choice for every empty seat.

## 0.1.31 — 2026-09-30

- **The judge is visible and weighed.** Every time a seat gets the floor the feed records why and by whom (Jev or the rule) with every seat's impulse score. Jev's confidence now weighs the impulse: a hesitant «evidence» stays below the floor threshold, a sure «addressed» passes. Verified against System One from the OVH host with real council states.

## 0.1.30 — 2026-09-30

- **Directors read the code.** Every seat and the chair already ran inside the project checkout with tools; now their prompt says so: read files, grep, run read-only commands and cite path:line before claiming anything, and never modify, install, commit or start anything. Each role has a lens, where it looks first (product: screens and flows; demand: request data and analytics; audience: copy and onboarding; skeptic: validation, billing, tests; growth: funnel and payments; ux: components and states).

## 0.1.29 — 2026-09-30

- **Council seats in settings.** The «Совет директоров» group on the project settings panel has one provider/model/reasoning picker per seat (product, demand, audience, skeptic, growth, ux) and for the chair, drawn from the live BB catalog, so an OpenRouter model, a local one or any other configured provider can sit at the table. Empty seats keep taking distinct pairs from the stage selections. The group also holds «Jev судит совет» and the number of laps.
- **The council page renders Markdown** (statements come with headings, code and lists) and shows session states in plain words.

## 0.1.28 — 2026-09-30

- **The boardroom.** A council now runs as a room by default: after every seat's opening position, seats speak when they have something to add, not in turn. After each message every seat's impulse is judged (Jev through the host's `councilJudge`, or the built-in rule: an addressed seat must answer, the owner's words wake everyone, a seat silent for a full lap gets the floor, the last speaker waits), one seat gets the floor, and a moderator verdict ends the discussion when the room repeats itself. The owner joins at any time with `lane_pilot_council_say` (or the RPC behind the page), names a seat to make it answer next, and asks for the decision with `decide`. `mode: "rounds"` keeps the fixed-round debate.
- **A council page in the sidebar.** «Совет» shows every council of a project as a chat: seats with their models, the agenda, the live feed with who is writing, the owner's composer, «Решать» and «Стоп».
- **Jev is the judge.** The host handler `councilJudge` asks System One several choice questions over a JSON state; the council uses it for the moderator and the seats' impulse, and falls back to the rule when the key is missing or the call fails.
- **Run budgets on the settings panel.** `run.max_attempts`, `run.max_wall_minutes`, `run.max_tokens`, `run.max_children` are catalog rows in the ops section with EN/RU labels; empty means no limit.

## 0.1.27 — 2026-09-30

- **Council of directors.** `lane_pilot_council_start` convenes role-bound seats (product, demand, audience, skeptic; growth and ux on request) on distinct configured models as hidden threads. The chair turns the question into an agenda and criteria, seats give positions and reply only where they disagree or add evidence (PASS otherwise), a moderator rule ends the discussion on the round cap, on repetition or when most seats pass (an outside judge can override), and the chair writes a decision record: options ranked by the criteria, recommendation, dissent, experiments, next tasks. The record lands in `docs/decisions/` and each next task becomes a handoff card. `lane_pilot_council_status` and the run monitor show the feed; `lane_pilot_council_stop` ends a session. Package `@lane-pilot/council` holds the protocol.

## 0.1.26 — 2026-09-30

- **Packages.** An npm workspace under `packages/` holds code reusable beyond this plugin: `@lane-pilot/thread-observe` (when a child thread is done or failed), `@lane-pilot/memory-core` (guarded project memory over SQLite), `@lane-pilot/handoff` (typed task cards between agents with states, leases and receipts), `@lane-pilot/resilience` (provider circuit breaker, run budgets), `@lane-pilot/run-insights` (writer acceptance per model and risk, lessons from receipts, golden retrieval checks). The map and the rules are in [docs/architecture.md](docs/architecture.md).
- **Handoffs.** PM tools `lane_pilot_handoff_create`, `lane_pilot_handoff_receipt`, `lane_pilot_handoff_list`: a task given to another agent is a card with objective, acceptance, inputs, budget and deadline; it is delivered into a named BB thread or carried to the caller's own subagent, and its receipt closes it. Overdue cards expire every five minutes.
- **Learning loop.** `lane_pilot_lessons_sweep` and a quarter-hourly schedule turn night review findings, rejected acceptances and failed attempts into `subagent` memory notes that the next writer in the same area reads; `lane_pilot_memory_golden` scores retrieval against a golden set; `lane_pilot_routing_stats` shows which provider and model gets tasks accepted at the first try per risk and hints against the configured writer.
- **Writers fail over and stay within budget.** A provider/model that fails repeatedly opens a breaker; the next writer is rejected as unavailable and the existing emergency fallback takes over. A run budget over attempts, wall minutes, tokens and child threads (`bb lane-pilot budget <project> run.max_tokens=...`) blocks new attempts with the exact reason. `lane_pilot_run_health` and `bb lane-pilot health` show both.
- **One memory.** `lane_pilot_memory_import` brings a project's `.agents/memory` records (claude-lane schema 2) into the hub corpus with the audience taken from sensitivity; `lane_pilot_memory_export` writes hub records back as files, so terminal sessions and BB runs read the same memory. The hub corpus is the source of truth.
- **Routing hint in settings.** Under the writer picker the project shows which provider and model got tasks accepted at the first try per risk, against the configured pair.
- **server.ts is an entry point again.** Its 7 000 lines became modules under `src/server/`: a shared core (SDK, storage, host client, settings and section helpers), one factory per area (reconcile, activation, writer run, stages, nightly docs, probes, writer host) and three registration modules (RPC, tools, CLI). Modules call each other through one `Services` interface, so the call graph is explicit and each file can be read on its own. Every move is verbatim; the failing test set is identical to main.
## 0.1.25 — 2026-09-30

- **Parallel lanes never share a checkout.** «В папке проекта» (`adoc.040=in_place`) now runs writers one at a time in that folder, whatever the pool size says; `auto` and `worktree` give every attempt its own git worktree, so 5 or 10 lanes work at once without seeing each other's half-done edits.
- **Checks inside a worktree see the writer's own edits.** `node_modules` is mirrored entry by entry: third-party packages link to the base copy, monorepo workspace packages point back into the worktree, nested `<workspace>/node_modules` are mirrored too, and each workspace package's ignored `dist/` is copied so `exports → dist` resolves. Before, one symlink sent every `@scope/*` import to the base checkout.
- **A merge blocked by uncommitted edits in main is named as such**, with the files, instead of a bare merge failure.

## 0.1.24 — 2026-09-30

- **Ownership is checked per task of a run, not against the union of every task's never_touch.** In a shared in-place checkout a sibling's changes appear in every attempt's diff; a path now passes when some task of the run owns it and does not never_touch it. Before, a sibling listing `apps/**` as never_touch rejected the owner's own files, and the whole run ended blocked.
- **Bookkeeping in the working tree is not the writer's change.** `.agents/**` (memory episodes, PROGRESS.md, design probes, run locks), `.bb/**` chat exports and cache folders that hooks and sibling agents write during an attempt are left out of the ownership check unless the task owns them.
- **A missing read_first path no longer blocks the task.** The packet names the path as absent and the writer is still dispatched; a line window outside a file still fails closed.
- «retry limit 2 exhausted» keeps the reason of the last failed attempt after the colon.

## 0.1.13 — 2026-09-26

- **Every native Lane chat is its own run.** A project needs no Lane Pilot setup, and several Lane chats can run in one project; only the legacy PM pipeline keeps one PM per project.
- **Claude Lane is installed once, the standard way.** A machine with Claude Lane (`~/.agents/install.json` plus the `lane-stack` Claude plugin) is used as is and never removed with Lane Pilot. A machine without it gets `claude-lane-stack` cloned to `~/.local/share/claude-lane-stack-installed` at the tested revision and its own `install.sh` run in the real home, with `flock` (Homebrew) and PyYAML/jsonschema added when missing. The staged, ownership-tracked install is gone; existing manifests still disable and remove as before.
- **Lane Pilot repairs Claude Lane itself** on install and whenever it is enabled: it refreshes a Claude plugin cache left behind by a same-version update, trusts the Codex Lane hooks, and registers the OpenCode Lane plugin also in `opencode.jsonc`.
- **Installation starts when Lane Pilot is enabled** in the composer, on the machine the chat will use; a send waits up to 5 s for a running install and reports a failed install with its reason.
- **Settings inherit: Общие настройки → project → section.** «Общие настройки» is the full settings panel at a level every project and section inherits live; a value set in a project or section overrides it there, and «Вернуть унаследованное» drops back to the level above. Sections from project-folders appear under their project. The global model catalog comes from any connected machine.
- The model picker no longer replaces a saved selection with the catalog's first model (it showed «6-Astra Low») while the settings screen loads.
- Switches for true/false settings (Документы, Память проекта) save again.
- Checked skills, tools and MCP servers of an agent profile are listed first.
- Bundle Claude Lane agents from `a43826b` (Designer prototype/mockup modes, `cocoon-chainsmith` for the SEO specialist) and pin installs to that revision. `scripts/bundle-lane-agents.py` regenerates the bundle and reproduces the previous one exactly.

## 0.1.12 — 2026-09-24 (predeploy candidate; not installed)

- Add native plan critique, run policy, workspace routing, writer/verification receipts, cancellation and restart reconciliation.
- Add night review/fix, specialist/onboarding, project-scoped memory, living docs, controlled Browser QA and fail-closed sandbox stages with native EN/RU settings.
- Expand the source-backed catalog to 366 rows (355 original tuples plus 11 native controls); keep inventory classification distinct from installed acceptance.
- Integrate the reviewed Lane Stack coexistence and guarded install/rollback adapters. Hub delivery and installed acceptance remain pending exact combined review.

## 0.1.11 — 2026-09-23

- Render Diagnostics CLI preview as scrollable JSON after a live SourceCode renderer failure on the hub.
- Keep the missing-credential Jev test independent of a permanently installed host credential file.
- Allow unrelated CAS settings saves through both single and batch RPCs after a native writer selection, while preserving validation of legacy writer groups and other enumerated settings.
- Reject cancellation of terminal or closed attempts before stopping a thread; show only legal Monitor actions in mobile and desktop layouts.

## 0.1.0 — 2026-09-23

First public release of Lane Pilot for BB.

- Isolated PM activation (Mode 2) and native BB writer dispatch
- Host worker: detect / install / snapshot / rollback / OpenCode connect / one-shot import
- Settings UI (EN/RU) from the adoc coverage matrix, CAS storage, run monitor
- CLI and BB writer pipelines with task-v2 and acceptance-v2
- Public GitHub, GitNexus index, hub install via the standard path-plugin delivery
- Catalog hygiene: excluded LANE_STACK_ROOT default quotes `~/tools/claude-lane-stack`, not an absolute host path

Based on [VKirill/claude-lane-stack](https://github.com/VKirill/claude-lane-stack) v1.38.0 (`747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`), MIT.

## 0.0.1-stage0

Internal executable prototype (stations A–C). Not a public GitHub release.
