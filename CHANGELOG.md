# Changelog

## Unreleased

- **K8, knowledge: a full memory budget no longer stops memory.** Before, one over-budget batch was refused whole and a full corpus silently took no new notes. Now the notes that served briefs least (fewest accepted attempts, then fewest uses, then oldest) are hidden to make room and the stage result lists them (`evictedIds`); core records and rules are never hidden, and an entry that would not fit even on an empty shelf changes nothing. A core corpus already over a lowered core budget no longer blocks notes.
- **K8: an imported record follows its file.** `lane_pilot_memory_import` now hides the record of a file that is no longer `active` (`superseded` or `expired`) or whose `valid_until` passed, and replaces the record of an edited claim (the old one is `superseded`, kept, pointing at the new one). The result has a `hidden` count. Hidden records stay in the table, out of every index.
- **K8: a note from a CLI session reaches writers only after a second source states it or a day has passed.** `session_memory_write` records `trust=observed`, `origin=session`; the same note from another source says `corroborated` and is confirmed at once. The session itself finds its own note (`session_memory_search`, `session_memory_core`) immediately. Writer briefs, the council and the PM context skip an observed note in quarantine.
- Migration (append only): `lane_pilot_memory` gets `status`, `superseded_by`, `valid_until`, `last_used_at`, `use_count`, `accepted_count`, `trust`, `origin`, `source_file_id`.

## 0.1.180

- **A folder without git: only what the writer did counts as its touch.** Edited paths, command text and tool arguments; a command's output does not. A plain `ls` listed the PM's `index.md` and the writer was blamed for it, so the 0.1.179 fix never applied (drill 2026-10-07).

## 0.1.179

- **One whole-suite run per batch, everywhere, with no setup.** When `integration.gate_command` is empty, Lane Pilot detects it on the project's machine: an `npm test` script, else vitest or jest, else pytest; `off` turns the gate off. The gate runs once when the last task of a batch lands and sends a red result to the writer whose merge broke it. Before, with the default `gate_when=queue_drained` the gate never ran at all: nothing called it on a drained queue.
- **A task's own check never runs the whole suite where a gate is active.** The contract lint answers with the fix: check only this task's files, the gate runs the rest once per batch. The PM instructions say the same.
- **A folder without git: a file someone else changed meanwhile is not the writer's.** A change outside owns_paths counts against the writer only when its own thread touched the file (a file edit or a command naming it). The drill's PM edited the folder during a writer's attempt, and the task was blocked for it.
- The run-card test imports the whole app and gets 30 s per test.

## 0.1.178

Wave 2 of the stabilization plan: native BB integration (events, lifecycle, native reminders, authorship, hidden writer brief, tool labels, run card, realtime screens, owner questions as forms, Lane Pilot's own worktree provider), official plugins (usage-aware writer choice, provider-retry, Tasks mirror, concurrency-limit), canary and error budget, Env Catalog secrets. New behaviour is on by default with an automatic fallback to the old path.

- **H8: questions to the owner are a BB form, not text in a chat.** `bb.ui.requestInput` opens a pending interaction (renderer `lane-pilot-ask`, registered with `app.slots.pendingInteraction`): the question and its context, up to six tappable answers, a field for the owner's own words, "Not now". It sits in the chat's composer and BB's push-notifications plugin delivers `interaction.pending` to the phone (the push text is the form's title, which is the question). A plugin's form holds no turn and never blocks a send to the thread. Used from: the new PM tool `lane_pilot_ask_owner` (called from a tool, BB answers the call at once with a waiting notice and the owner's answer reaches the PM as a message; the PM prompt now sends a `needs_human` question it cannot settle there instead of "put it to the owner"); the integration gate when it is red and no culprit can be named, or red from the machine (the form opens in the PM chat, the PM's message says so, the answer arrives in the PM chat as «Lane Pilot: the owner answered …»); self-repair when a repair ends `needs-owner` (the form opens in the repair thread with the report, the answer goes into that thread; the repair worktree is released as before, so the answer is a decision for a new repair); a council room that waits for the owner (the form opens in the PM chat: a typed word goes into the feed as the owner's, "Let the chair decide" asks for the decision; the form is withdrawn when the wait ends another way). One form per chat at a time; a BB without `bb.ui.requestInput`, or a chat that already has a form open, falls back to the old text message. Answers lost to a plugin reload or a stopped chat are not reported; a dismissal and a timeout are.

- **H6: the screens follow the server instead of polling.** The server publishes `bb.realtime.publish("lp:<project>", {kind, threadId?})` and the screens re-read on `useRealtime`: `kind` is `helpers` (a child thread of a PM chat was created, went active or idle, failed, was archived or deleted, or an attempt was created or changed state; `threadId` is the PM chat), `council` (every council message, state, agenda and floor change) or `rules` (every scan step, a PM proposal or lesson, an owner decision). Bursts are coalesced into one signal per 250 ms. The 2 s council poll, the 3 s rules-scan poll and the 4 s helper-squares poll are now a 30 s fallback while the live connection is up (4 s while it is connecting or reconnecting), and every screen re-reads once when the connection comes back after a drop. A BB without `bb.realtime` keeps the fast poll. `onAttemptChanged` in `src/database.ts` is the one additive hook in `createAttempt`/`transitionAttempt` (a listener never fails the write).

H5: reminders live in BB's own message queue.
- **`lane_pilot_remind` queues the reminder in BB** with `bb.sdk.threads.send({ mode:"queue-if-active", sendAt:dueAt })`. It shows as a queued card in the PM chat with its time, BB's clock sends it, and it survives a reload of the plugin (the old list in plugin KV and a 30 s sweep did the same, invisibly). The reminder keeps the id of its row (`queuedMessageId`).
- **The early wake stays.** A watched thread that finishes its turn (`watchThreadId`) or tasks that all finish (`taskIds`) delete the row first (`bb.sdk.threads.queuedMessages.delete`) and then send the reminder at once. If the row is already gone (BB sent it a moment ago) no second one is sent. A cancelled reminder (`lane_pilot_relay_list` with `cancelReminderId`), a reminder closed because the thread it waited on answered, and a reminder left with no tasks delete their row too. A failed delete still sends the early reminder (a repeat is better than a lost one).
- **The sweep only looks at a queued reminder.** Past its time, a row that BB no longer has counts as sent (`firedBy: time`); a row still waiting (the PM chat is busy) is left to BB. The events `message.dispatched` and `message.cancelled` close the reminder at once (`time`, or `canceled` when the owner deleted the card).
- **Fallback.** A reminder that cannot be queued (BB refused, an older host) has no `queuedMessageId` and the sweep sends it when due, as before; `LANE_PILOT_NATIVE_REMINDERS=0` switches the queue off. Asks and watched-thread settling are unchanged.

H2: Lane Pilot reacts to BB's lifecycle events when they happen (`src/server/lifecycle-events.ts`); the sweeps stay as the net for a lost event. Same switch as H1 (`LANE_PILOT_THREAD_SIGNALS=0` turns the handlers off); each listener is registered on its own, so a BB that does not know an event only loses that listener.
- **`thread.archived` / `thread.deleted` of a PM chat** closes its run at once (the 15-minute run sweep did it before). Same rule as the sweep: a run with an open attempt is left alone. `closeAbandonedRuns` takes an optional PM thread id for this.
- **`interaction.pending` on a running writer** (a question or an approval nobody sees): the PM gets one message naming the task, the writer thread and what it asks, and the attempt's `blockedBy` gets a `human` row with the interaction id, so if the attempt later ends blocked, `lane_pilot_wait_writer` says why. Repeats of the same interaction are not sent again.
- **`message.cancelled`**: the owner deleted a follow-up turn Lane Pilot had queued for a writer (a continued thread). Its attempt stopped waiting for ever and held a writer slot; now the wait ends and the attempt is blocked `follow_up_deleted` (`waitThreadIdle` takes an optional `shouldStop`). Rows of other plugins, other threads and older turns are ignored.
- **`experimental_host.deleted`** (BB core with the event; not in the pinned SDK types 0.4.104, so it is registered defensively): the machine's native-install registry row and error, and its background host-job keys, are dropped, so enable/disable/remove no longer try a machine that is gone. A log line names runs with open attempts that still point at it.

H1 of the next plan: BB's thread events instead of polling.
- **Watchers sleep until BB says a thread changed.** The factory subscribes once (`bb.events.on`) to `thread.idle`, `thread.failed`, `thread.archived`, `thread.deleted` and `experimental_thread.events` (the last one only while the thread is not `active`, so a running turn does not wake anyone) and keeps a per-thread signal hub (`packages/thread-observe/src/signals.ts`). `waitThreadIdle` and `observeStageChild` (the wait of every helper, stage child, critic, council seat and errand), the writer's finish loop (without a wall or token budget), the compaction wait of sticky writers and the docs thread start wait read the thread when the hub signals, and otherwise every 20 s. `decideThreadCompletion` and `threadFailure` stay the judge: an event only says «look now». A mark taken before the read keeps a change that arrives during the read from being lost; a reload wakes every sleeper at once.
- **Measured** (tests/thread-signals.test.ts, a writer that works 45 s, fake clock): 47 `threads.get` + 47 `events.list` calls with the old 1 s poll, 4 + 4 with events (about 67 → 4 reads a minute), and the end is seen in the same tick, not up to a second later.
- **Fallbacks.** No `bb.events` (an older host, a test host) or `LANE_PILOT_THREAD_SIGNALS=0`: the old poll, unchanged. A lost event costs at most one 20 s interval. A run with a wall or token budget keeps its 2 s loop, because the budget is checked there. The tests switch the events off (`tests/setup-jsdom.ts`): fake threads change state without them.
- Not changed: the 500 ms wait for a worktree holder thread (it goes away with H9) and the sweeps (5 to 15 minutes).

H9: a writer attempt's worktree is a BB environment of Lane Pilot's own provider, not a holder thread's.
- **Environment provider `lane-pilot-worktree`** (`src/server/environment-provider.ts`, `bb.experimental_environments.register`, modelled on the official environment-git-worktree plugin). Inputs `{basePath, name, path?}`; `pathKeys: "per-attempt"`, `retireGraceMs` 5 min (as BB's own worktree: a worktree is ~2 GB). `create` takes the worktree Lane Pilot already made, or makes it with the existing host functions (`gitCreateWorktree`, which knows the subfolder prefix and nested layouts, then `gitPrepareWorktree`); `remove` saves what the writer left (`gitWorktreeSnapshot`) and calls `gitRemoveWorktree`, and leaves a worktree an attempt went on with without an environment (the fallback). Registers nothing on a BB without the API.
- **No holder thread, no model turn.** Lane Pilot makes the worktree first (the packet, task folder and dirt baseline are read from it before the thread exists), then spawns the writer with `environment: {type: "provider", environmentProviderId: "lane-pilot-worktree", inputs, machine: {type: "existing", hostId}}`, waits for the environment to be ready and records its id on the attempt, so the existing sweeps (snapshot, archive threads, delete) find it. Used for a project root, a section with its own repository and a subfolder of a larger repo; a folder without git stays in place and never sees the provider.
- **On by default; `workspace.provider` (`auto` | `off`) is only the emergency switch** (settings, Workspace, advanced).
- **Silent fallback per attempt.** A BB without the API, a provider BB does not list, a worktree that could not be made, BB refusing the provider at the spawn, an environment that goes to error or is not ready in 2 minutes: the attempt starts again on the old path over the same worktree (the failed provider thread is stopped and archived), is not failed and not charged, one log line.
- **Per-machine self-disable.** Three provider errors in a row on one machine switch the provider off there until the plugin version changes (KV `workspace-provider:host:<id>`); the warning `Lane Pilot workspace provider failed 3 times in a row on host <id> ...` is a plugin-log failure line, so self-repair sees it as an incident. A success clears the count.
- **Drill:** scenario `provider` (one task: accepted, the attempt has an environment and no holder thread) and the same check in `parallel3`, so the pre-deploy `--quick` run fails on a provider that silently falls back. `LP_DRILL_REQUIRE_PROVIDER=0` skips it for the first build that has the provider.
- Tests: `tests/workspace-provider.test.ts` (provider create/remove, gate, wait, spawn on a subfolder repo, a section repo, a project root, a nested OVH-like path, no-git, resume, every fallback, self-disable).

Integration with the official BB plugins (I1-I4, I6, I7) and the canary (G7). Every integration is feature-tested and does nothing when its plugin is absent, disabled or failing; two project settings (`usage.skip_percent`, `tasks.mirror`, default off) are new.
- **Provider usage (I1).** Before a writer starts, its provider/model's usage windows are read through the usage-source contract (`provider-usage.v1.listResources` / `getResource`, found with `plugins.experimental_discoverRpc`: provider-claude-code, provider-codex, provider-acp, account-pool; the display plugin is not needed). A pair at or above `usage.skip_percent` (default 90, 0 = off) whose window has not reset is skipped: the next model of the chain takes the task at once (`writer_provider_unavailable:usage_window:...`, failure class limit: uncharged, no breaker). Spent fallbacks are skipped too; when every pair is spent the writer starts as before.
- **provider-retry (I2).** The retry the plugin queues in a failed writer's thread is deleted when the task moves down the chain or ends (and any queued afterwards, via `message.queued`), so the abandoned thread is not woken later and the work is not done twice. A writer's question keeps its thread.
- **BB Tasks mirror (I3), setting `tasks.mirror`, default off.** Each task is copied into the Tasks project linked to the BB project: status, the writer's thread (`taskThreadsAttach`) and milestone comments that notify nobody. Writes only.
- **concurrency-limit (I4).** A host's effective limit caps the writers started there (a second pool slot per host); a turn held in a plugin's queue is no longer failed by the 180 s «provider never started» limit (writer finish, `waitThreadIdle`, `observeStageChild`).
- **Canary and error budget (G7).** `canary_status` RPC, a 10-minute check that tells the PMs once per version when 3+ of the first 20 attempts (above 5%) failed on Lane Pilot's own fault, a 7-day budget, `scripts/lp-canary.sh` (exit 1 when tripped or spent) and `--rollback <version>` that prints the steps from the deploy log.
- README: the «Official BB plugins» table with notes for plugin-api-docs, plugin-api-tester (enable on a development machine only), agent-annotations and push-notifications (I6, I7).

### Env Catalog (phase J)

Secrets for checks, browser logins and deploy steps, from BB's Env Catalog, with least privilege. Needs the `env-catalog` plugin for any of it; without it a task that declares nothing is unaffected.
- **J1, roles.** Env Catalog tools go to the roles that use them: errands and the four specialists (design-lead, copy-lead, seo-specialist, tavily). A writer has none, and its brief no longer promises `env_get` (it says its checks get declared secrets as environment variables and it never sees a value). The browser-check thread gets Env Catalog only for a case that names a login (J5).
- **J2, secrets in checks.** `verification[].secrets: [NAME]` per check (Env Catalog kind secret or login). The contract lint checks the names: a typo of a saved name, an ssh/ftp kind, a sandbox variable name, a name the owner has not allowed and an absent Env Catalog send the task back; a name that is simply not saved yet is a warning (the task waits, J6). The server reads the values through `env_get_value` only for the check that declares them and passes them as the sandbox's environment (`runSandboxedCommand` takes `env`; bwrap gets them in its own environment, never in its arguments). A check with secrets runs through the host call, not a BB terminal and not a stored background job, and is left out of the host's replay before a merge (the post-merge check on main still runs it). A login expands to `NAME_USERNAME`, `NAME_PASSWORD`, `NAME_URL`.
- **J3, masking.** `src/redact.ts` masks every value handed out (plain, JSON-escaped, URL-encoded, base64, each line of a multi-line key) as `***`: on the host in the check's output, again on the server, in `cleanCheckOutput` (retry briefs, task-folder logs, failure reasons), in the plugin log, in a browser check's verdict and in an errand's report.
- **J4, least privilege.** Project setting `secrets.allow` (owner-only, empty means none): only names listed there are handed to a check, a browser login or an errand, and only when the step declares them. The PM cannot change it.
- **J5, browser logins.** A case starts with `login: NAME` (kind login). Nothing starts unless the login exists and is allowed (the answer says what to do and no stage is recorded); the check thread's profile adds Env Catalog for that run only, and its prompt names that one account.
- **J6, waiting for access.** A task whose checks need a missing or not-yet-allowed name waits before any writer starts (stage reason `waiting_secret:NAME`, class contract, no attempt spent); the PM is told once to call `env_request`; the wait ends by itself when the access is in place (polled every 20 s: BB's `env-catalog:changed` signal reaches the app only, not a plugin's server) and gives up after 12 hours. A secret lost mid-task parks the task (the 5-minute sweep restarts it, a day at most).
- **J7, deploy access.** `lane_pilot_errand` takes `accounts: [NAME]` (any kind, allowed names only): the helper is told to read them from Env Catalog, to keep an SSH key in a temporary folder outside every repository and delete it, and its report is masked.

## 0.1.177

From the review of 2026-10-07 (bugs 1 and 7, D3/D4). Needs the core drain-fixes build (`bb.vk.instanceId`) for bug 1 in full; on an older core the oldest bound instance is drained, which is the one being replaced.
- **A reload no longer switches the new instance off.** The deploy drain used one module-level binding. A reload with the same build does not evaluate the module again, and BB runs the new factory before it drains the old instance, so the new instance took over the binding and the old instance's drain turned the NEW one off for 20 minutes (checkout writes and acceptance checks held) while the old one's work was cut. Each instance now registers its drain under `bb.vk.instanceId`, the lifecycle handler drains exactly the instance BB names in `ctx.instanceId`, and an instance unbinds when it is disposed. Tests cover both orders (new binds before old drains, old drains before new binds), an older core without ids, and a disposed instance.
- **A hung schedule run no longer blocks every later tick.** BB passed a `signal` to isolated schedules but the jobs ignored it, and BB keeps the run's slot until the job returns: one stuck await held its schedule until the next reload, and eight of them held every isolated schedule. Now (1) the whole body is raced against the signal, so the slot is free the moment BB aborts the run; (2) self-repair, parked-task sweep, writer-silence sweep, worktree sweeps, run sweep, lessons sweep, rules triage and nightly, the docs passes and the fire drill check `signal.aborted` between steps (an aborted self-repair tick starts no repair thread; an aborted parked sweep keeps the rows it did not reach); (3) every host call made inside a run carries the run's signal, a call held by a deploy drain gives up, and a host-job poll stops (the job itself goes on at the host and is found again by its key); (4) a docs pass stuck on one await no longer keeps the serial docs queue and its place busy.
- **The remaining ordinary schedules are isolated:** stability-drill, rules-triage, runs-sweep, lessons-sweep, handoff-expiry, token-usage-sync, with limits of 2 to 30 minutes. BB starts at most 8 isolated runs at once and skips the tick of a ninth, and seven isolated schedules already start on minute 0, so the new ones moved off it: runs-sweep 2,17,32,47; lessons-sweep 4,19,34,49; rules-triage 6,21,36,51; handoff-expiry 1-59/5; token-usage-sync 7 and 37; stability-drill Mondays 05:10.
- **A start after a clean drain skips three scans.** After a reload whose previous instance finished its drain in time and saved a snapshot with nothing in flight (`bb.vk.afterDrain` plus the snapshot's `clean`), startup recovery leaves the run sweep, the worktree sweep and the parked-task sweep to their own schedules (5 to 15 minutes), instead of hitting the host right after the reload. Resuming helpers and writers, the parking of blocked tasks, rules adoption, stage cleanup and browser-check recovery still run. Any other start (boot, enable, a drain that hit its deadline, no snapshot) scans at once.

From the stability review of 2026-10-07 (bugs 2, 3, 9, 10; B2, B6, B7):
- **The integration gate, its bisect and the helper checks run on the project's own machine.** The gate command, `git rev-parse`, the bisect and the file reads that name a culprit ran on the hub at the project's path, so a project on OVH failed on a path that does not exist there and the last merged task was blamed. New host job kinds `gateRun` and `gateBisect`; file reads go through `readBoundedFile`. The bisect runs in a scratch worktree there, so the project's checkout is never moved while writers merge. `git status` of errands and specialists (the «helper edited the repo» check) goes through `runCommand` on the checkout's host; `tests/remote-git-detect.test.ts` proves nothing starts a process or opens a file at a project path on the hub, and guards the imports of `src/server`. A host that cannot run the gate leaves the merges counted; it blames nobody.
- **A bookkeeping file the task owns is merged.** The merge reset every bookkeeping path (`.agents/reports/**`, `.agents/PROGRESS.md`, …) to main's version, so a task with expected output `.agents/reports/audit.md` was accepted and lost the file. `gitIntegrate` takes the task's `ownsPaths` (additive): a bookkeeping path they name keeps the attempt's version, and such a file hidden by `info/exclude` is added by force before the commit. Machine-written paths (`.agents/runs/`, `.bb/chats/`, `notes/lock/`, episodes) are never the task's. Hook-written bookkeeping is still settled to main.
- **A permission string in a failing test is no longer an environment fault.** `EACCES|EPERM|EEXIST|permission denied` anywhere in a check's output made a real red test «environment»: no mainfix after the merge, free retries for the writer. Now a check is environmental only when an error line names a path or system call (`EACCES: permission denied, rmSync '/x/.output'`, `npm error code EACCES`, `sh: vitest: Permission denied`) and the output reports no failing tests (`N failed`, `fail N`, `not ok`, `FAIL`, assertion and `error TS` lines). The writer's failure reason carries `environment: ` for such a check, and only that reads as infra; `PermissionError` of the snapshot and non-check reasons keep their class. The integration gate follows the same rule: red from the environment sends the PM one message and no fix turn, no bisect.
- **A finished post-merge check is taken only by the call that started it.** The host-job key was the input's hash, so a second merge's check with the same commands could take the first one's green result for up to 10 minutes. The post-merge check now names its job by attempt and merge commit; a finished sandbox check without such a key is never reused.
- **After a rebase onto a moved main the task's checks run before the merge.** When the replay changed the attempt, the host runs the task's verification commands in its worktree (sandbox, under the integration lock) and merges only if they are green. Red twice: nothing merges and the same writer gets a free redo (`merge_conflict: … checks red after the replay on main`) with the check's output; before, the clash merged and was repaired afterwards by a mainfix. A check the machine broke or that cannot run does not hold the merge.

From the stabilization review of 2026-10-07 (§3, practices of competitors and orchestration systems), plus two owner items.

- **One ordered task reconcile.** Start-up recovery used to run its steps one by one, and the stage cleanup (which ends a failed attempt waiting for a retry that died with its loop) came after the parking of blocked tasks, so such a task was parked only on the next start. Now `reconcileTasks` (src/server/task-reconcile.ts) runs merge intents, the resume of attempts in flight (with the run and worktree sweeps), the stage cleanup, the parking and the parked-task sweep in that order, and the same pass (minus the resume) runs every 5 minutes as the isolated schedule `task-reconcile` (it replaces `parked-task-sweep`). The periodic pass leaves an attempt that moved in the last 3 minutes alone.
- **Merge intent.** Before `gitIntegrate`, finish writes `merge-intent:<attemptId>` {base head, attempt head, branch, message} to the plugin's KV and clears it once the attempt's state has caught up. On recovery, an attempt that is not final whose work is already in main (the attempt's commit, a clean worktree's tip, or the merge commit carrying the attempt's `Lane-Pilot-Attempt:` trailer, asked of the project's machine through `runCommand`) is accepted with a receipt and its stages closed, instead of redone. The merge commit message now ends with that trailer, because two attempts of one task share a title.
- **The breaker and the retry budget survive a reload.** The breaker is read back from KV at start (a breaker of another version is dropped: a fix shipped). Each task has one persisted budget of 12 fresh writers (primary and fallback chain, across starts, reloads and parked redrives; feedback turns and resumed attempts do not spend it). When it is spent the task ends `retry_budget_exhausted: ...` (class `budget`: never parked, never redriven; the PM is told to send it again as a new task).
- **`harness_version` on the attempt** (new column of the plugin's own table, set when the attempt is created). A task parked at start-up for a Lane Pilot fault restarts when another build runs, not at once under the build that failed it.
- **The transition table is enforced.** `transitionAttempt` accepts only the rows of `TRANSITION_TABLE` and a short list of documented operational moves (`OPERATIONAL_MOVES`, each with its reason); anything else is logged, journaled as refused and thrown as `IllegalTransitionError`, which the writer loop ends as `internal_error`. The full suite found these real illegal moves, fixed here and not allowed by the table: recovery put a `cancel_requested` attempt back to `running` (a stop was lost after a reload); a failure after the writer thread was bound moved a running attempt to `spawn_unknown`; the ambiguous-reconcile probe skipped `spawn_requested`; native CLI runs jumped from `queued` to their outcome (now recorded through their steps). Test fixtures that skipped `spawn_requested` were fixed.
- **Seeded fault-injection simulation** (tests/simulation): a random schedule of writer failures, host outages, lost merge replies and plugin reloads drives the real writer loop, stability, task reconcile and merge-intent recovery against a model of main; after the faults stop it checks that no task is stuck, none is accepted twice, none lands in main twice and no landed merge is left unaccepted. Failing seeds are kept in tests/simulation/regression-seeds.json. It found, and this version fixes: an attempt left `spawn_rejected` for good when the thread scan after it failed (now blocked `reconcile_error` and parked), and the merge-subject collision above. `LP_SIM_SEEDS=400` runs more seeds.
- **BB-managed worktrees are rebased too.** Before the merge, an attempt on a `bb/*` branch is replayed on the current main like a `lane/*` one (both are per attempt); the docs worktree is unchanged.
- **A folder without git stays locked while a writer's question is unanswered.** A task blocked on `needs_human` keeps its folder: other tasks for it queue (`waiting for T1: its writer's question is unanswered ...`) until the question is answered or the task is sent again. The PM message about the question and the wait receipt say so.

From the 2026-10-07 stabilization review:
- **Contract lint (bugs 5, 11).** With `verification.sandbox_unsafe` set, `npx vitest run tests/server/` (a folder with a trailing slash) counts as a focused check; any positional filter does. `--pool forks`, `--retry 2`, `--maxWorkers 4` and the like are no longer read as filters. A `read_first` symlink that points at a file (`AGENTS.md` → `CLAUDE.md`) is accepted: `snapshotDryRun` reports `targetKind` for a symlink and the lint treats it as that target; a dangling one is still refused.
- **Stable spawn keys (D2, bugs 8, 12).** Specialists, council seats, browser checks, errands, repair threads, rules analyzers and nightly docs passes name their spawn (`spawnId` in the thread metadata), so a spawn repeated after a lost answer returns the thread that call made. A thread adopted through reconcile (critic, stage children) clears its key marker: the next critique round gets a fresh thread, never the previous round's. A self-repair spawn that throws keeps its worktree and repeats under the same key on the next pass (30 minutes at most, then the worktree is released); a live repair thread no longer loses its worktree to a lost answer.
- **vk-requires.json** lists `experimental_vkFindByKey`, `experimental_vkFindByPluginMetadata` and `experimental_vkLifecycle` (the export the drain runs through) as optional; `vkLifecycleDrain` was not a function name.
- **UI catalog.** `verification.sandbox_unsafe` is back as row s418 (s413 belongs to `writer.silence_nudge_min`). `scripts/generate-ui-catalog.py` reads `scripts/ui-catalog-hand.json` (edits to generated rows, rows s366-s418, their labels, the section order), so a regeneration reproduces `src/ui-catalog.ts` and `src/i18n-fields.ts` byte for byte; `docs/adoc-applicability.md` and the summary are regenerated from it.
- **Drill (E3).** `scripts/lp-drill.sh` runs more than 3 parallel tasks: same-line conflict, main moved during an attempt, a bad `writer.model` (the next writer takes the task; the setting is restored), `bb plugin reload` mid-attempt (skipped while a non-sandbox project has open attempts) and a project folder without git. Each scenario's verdict is in the receipt; `--quick` is the 3-parallel scenario alone. `bb-plugin-push` runs `--quick` before a deploy (not with `LP_DEPLOY_INCIDENT`) and writes the receipt path into `deploys.log`.

## 0.1.176

- **A section with its own repo inside a non-git project gets Lane Pilot's own worktree in every run kind.** BB's managed worktree forked the project root, which has no git, and the spawn failed with «HTTP 409: This project checkout has no usable git branch» (live sandbox, 2026-10-07). Native Lane chats already did this.
- **A folder without git works.** The owner can run the orchestrator in a plain folder (no git, no GitHub) and writers edit its live files. Before, a task there ended `blocked: attempt_workspace_snapshot_failed: cannot read writer-workspace git diff: fatal: not a git repository`.
  - **Detection** on the folder's own machine: `git rev-parse --is-inside-work-tree` fails there (exit 128 «not a git repository», or 127 with no git installed). The answer is kept per run in kv, so a `git init` in the middle of a run cannot change the baseline kind. An unclear answer (a host error, «dubious ownership») counts as git.
  - **Snapshot** in place of `git status`: a python3 script on the machine hashes every regular file and symlink of the folder (skipping `.git node_modules .bb .agents/runs .agents/memory .cache .vite .vitest .turbo .next .nuxt dist coverage __pycache__ .venv venv`; a file over 20 MB is fingerprinted by size and mtime). The produced files are the ones added, changed or removed between the snapshots before and after the attempt, in the existing `{path, sha256}` shape, so owns_paths, never_touch, run scope and the bookkeeping filter work unchanged. Over 50 000 files the task is blocked as a contract failure: «folder too large for no-git mode: N files; put it under git».
  - **In place, one writer at a time.** No worktree, no `gitIntegrate`, no post-merge check, no git ownership base, no rebase, no ship step, no project-life commit. Accepting an attempt means the files are already there; the receipt says `workspace: "live-folder"`. Tasks of one folder queue (writer pool of 1 per folder), also when their owns_paths are disjoint.
  - **Rollback.** Before each attempt the files matching the task's owns_paths are copied to `~/.lane-pilot/live-backups/<attemptId>/` on the machine (7 days, older ones pruned when a new one is made). An attempt that ends unaccepted (rejected, blocked, canceled) gets them put back, and the files the writer created inside owns_paths go to `agent-trash` (or into the backup folder; never rm). Feedback turns in the same thread keep working on the live files; a writer's question is a pause, not a rollback. Files outside owns_paths are not rolled back, so such a file an earlier attempt left keeps counting as changed until the writer undoes it.
  - **Failure classes.** «not a git repository» and the no-git limits are the contract's: never harness or infra, never parked.
  - **Instructions.** The writer brief says «This folder has no git: you edit the live files directly; Lane Pilot does not commit; do not run git commands.»; the PM's prompt and the dispatch answer name the mode.

## 0.1.175

From the live scenario matrix in the sandbox (2026-10-07):
- **`lane_pilot_update_task` on a queued task works and reaches the writer.** Before, it failed with «illegal stage transition plan-critique: skipped -> pending» after it had already saved the new contract. The queued attempt then ran the old plan. Now plan critique runs again over the earlier receipt, and a queued task reads its stored contract and plan when it gets its writer slot.
- **A writer is told it may delete a stray file it created.** When a file outside owns_paths had no uncommitted changes before the attempt, the feedback says: delete it if you created it, restore it with `git checkout` if you changed it. A writer used to keep such a file «not knowing what was there before» and lost the task to «no progress».
- **A permission error is the machine's fault, not Lane Pilot's.** `EACCES`, `EPERM`, «permission denied» and `PermissionError` (for example at the workspace snapshot) now count as infra failures. Such a task is retried with backoff instead of being parked until the next plugin version.

## 0.1.174

- **A project whose folder is a subfolder of a larger repo: the writer now works in that subfolder.** When the chat folder was the project's own root but sat inside a bigger git repo (a section, GitHub one level up), BB's managed worktree started the writer at the repo root. The writer then created new files at the root, the post-merge check in the subfolder failed, and a pointless `-mainfix` followed. Such a folder (`git rev-parse --show-prefix` on its own machine) now gets Lane Pilot's own worktree of the repo, with the writer in the same subfolder. Found in a live check on OVH, 2026-10-07.

## 0.1.173

- **Activation on a slow machine no longer times out.** `coexistenceInventory` (the scan of a machine's Claude/Lane setup at activation) now runs as a host background job, like `detect` and `importConfig`. Activating a project on OVH failed with «host plugin call … exceeded its deadline», and a host worker died. Found in a live check of a nested-folder project on OVH, 2026-10-07.

## 0.1.172

Lane Pilot uses the four new core functions of runtime `0.45.0-vk.1` (stabilization plan, phase D). Each is feature-tested and the previous behaviour stays as the fallback, so the plugin still loads on a core without them.
- **Idempotent thread spawn (D2).** Every thread Lane Pilot starts (writer, workspace holder, critics, readers, specialists, stage children, browser check, self-repair, docs, errands) goes through `fullAccessSpawn`, which uses `experimental_vkSpawnKeyed` with the key `lp:<owner id>:<role>:<n>` (`src/server/thread-keys.ts`). A spawn whose answer was lost and is repeated returns the same thread; a spawn with no owner id gets a key of its own. The reconcile of a writer, a lost worktree holder, a stage child and a critic asks `experimental_vkFindByPluginMetadata` first (one query instead of paging every thread of the project), so `page_cap` and `holder_ambiguous` on a project with over a thousand threads cannot happen on the new core. The list scan stays as the fallback, and also when the lookup answers with a full page.
- **Drain on reload and shutdown (D3).** `package.json` declares `vk.lifecycle.drain` (5 minutes). The `experimental_vkLifecycle` export handles `reload` and `shutdown`: new checkout writes and acceptance checks (`runSandboxedCommand`) wait, the running ones finish, a snapshot goes to kv, and the old instance is released. The new instance logs its start reason (`bb.vk.startReason`, `afterDrain`, read in the recovery service, not the factory) and consumes the snapshot. The `deploy_drain` RPC and its `bb-plugin-push` use stay as the fallback.
- **Isolated schedules (D4).** `self-repair`, `parked-task-sweep`, `attempt-worktree-sweep`, `writer-silence-sweep`, `docs-maintenance-hourly`, `docs-nightly-hourly`, `docs-nightly-catchup` and `rules-nightly` register through `experimental_vkSchedule` (isolated, no overlap, 10 minutes to 6 hours): a long run no longer holds the others back. Without the function they are the ordinary schedules, the docs passes still return at once.
- **Hook limits and visible timeouts (D4).** `vk.hookPolicy` gives `message.dispatch` 20 s and `contributeEnv` 10 s (not `required`: the policy is per plugin, and a late resolver of a non-PM thread would stop that turn). `bb.vk.experimental_vkOnHookTimeout` keeps each timeout in kv and the self-repair watcher reads it as a `hook` incident, except inside a reload window.
- `vk-requires.json` lists all four as optional.

Stabilization phase E (release train, own worktrees, drills):
- **Self-repair threads work in their own worktree (E2).** Each repair gets a Lane Pilot worktree of the configured checkout (`~/.lane-pilot/worktrees`, branch `lane/self-repair-<hash>-<time>`) and runs there as an unmanaged workspace. The prompt tells it to commit on its branch and not to deploy, bump the version, push or release. With the verdict `fixed` the plugin merges the branch like a writer's (`gitIntegrate`, base lock, rebase); a conflict is retried on 4 passes and then left for the owner; any other verdict, or a day without one, saves the worktree as a patch under `~/.lane-pilot/released` and removes it. No worktree, no repair: the shared checkout is not a fallback. `self_repair_status` shows `branch` and `outcome` per kind.
- **Sandbox drills as a script (E3).** `scripts/lp-drill.sh` runs three parallel tasks in the sandbox project and writes a receipt to `.agents/runs/drills/<date>.json`.
- Deploy side (outside this repository, `infrastructure/plugin-deploy/bb-plugin-push`): the E1 release-train gates.

Tails of phases B and C:
- **`lane_pilot_update_task` uses the same contract lint as dispatch** (`src/server/lint-task.ts`). The task and plan stay unchanged on a failure.
- **Activation adds the bookkeeping folders to `.git/info/exclude` on the workspace's machine** (`.agents/runs/`, `.agents/reports/`, `.bb/chats/`, `notes/lock/`, at any depth). It never edits `.gitignore` and never commits.
- **Settings that existed only in code are now in the settings UI and can be reset:** `writer.silence_nudge_min`, `bookkeeping.paths`, `integration.gate_command`, `integration.gate_when`, `integration.gate_every`.

## 0.1.171

- **A docs pass stopped by a plugin reload no longer logs failures.** During the 0.1.170 deploy, passes still running on treba, treba-sites and my-album.art logged «nightly docs failed … stale API handle» and «The database connection is not open», and the self-repair watcher reads such lines as Lane Pilot faults. Those passes were already set to resume by the catch-up. A closed database now counts as a stop, as a stale handle already did (`pluginStopped`). The unit and pass catch blocks and the docs merge stay quiet on a stop, and a stopped unit keeps its saved progress.

## 0.1.170

From a self-repair of «Lane Pilot docs merge into <path> conflict: CONFLICT (add/add) … Automatic merge failed» (treba-sites, 2026-10-07):
- **A leftover docs pass that conflicts with main is logged as dropped, not as a failed merge.** On 2026-10-02 an in-place docs pass on treba-sites crashed on a too-large KV record and left its pages uncommitted in the checkout (docs passes have worked in their own worktree since 0.1.101). Because of that dirt, the 2026-10-06 pass could not merge, so its worktree was kept. The owner then committed the dirt. On 2026-10-07 the next pass tried to land the kept worktree first and got an add/add conflict in `docs/gotchas.md` and `docs/overview.md`. Lane Pilot handled it as designed: git left no merge state behind, main stayed clean, the leftover was dropped, and the pass started over from main in a fresh worktree. Only the log line was wrong: git's «Automatic merge failed» in a warn line, which the self-repair watcher reads as a Lane Pilot fault. That case now writes an info line, «earlier docs pass for … dropped: main changed the same pages (…); this pass writes them again from main». A conflict or failure of the pass's own merge is still a warning.

## 0.1.169

- **Contract lint before any task exists (B5).** One message to the PM lists every problem with its fix, and no attempt is spent. It checks:
  - `read_first` exists on the workspace's machine, with folders marked as folders;
  - ownership patterns are safe, an owned path is not inside never_touch, and expected outputs are owned and not in never_touch;
  - folder filters in vitest/jest checks end with `/`;
  - a bare full suite is rejected when sandbox-unsafe tests are configured;
  - `depends_on` a blocked or canceled task is answered «replan» instead of a blocked cascade.
- **Bookkeeping files never count as work and never fail a merge (B3).** One list in `src/bookkeeping-paths.ts`, extendable with the project setting `bookkeeping.paths`, is used by the ownership gates and the merge. It covers `.agents/PROGRESS.md`, `.agents/CHANGELOG.md`, `.agents/memory/episodes/**`, `.agents/runs/**`, `.agents/reports/**`, `.bb/chats/**` and `notes/lock/**`. On merge, main's version of those files wins.
- **Main moved? The attempt is rebased, not redone (B6).** Under the integration lock, a `lane/*` attempt is replayed on the current main first. A clean rebase merges without another writer turn (`rebased: true` in the receipt). A real conflict still goes back to the same writer for free.
- **Environment errors after a merge open no mainfix (B7).** A post-merge check failing on `EACCES`/`EPERM`/`EEXIST`/permission denied is an infra incident with one PM message.
- **Long host calls are background jobs (B4).** `jobStart(kind, input)`, `jobStatus(jobId)` and `jobCancel(jobId)` are ordinary short host calls. The work runs in a detached process of its own, with its log and result under `~/.lane-pilot/jobs/<jobId>/`, so the daemon's deadline and the 5 s SIGKILL of the worker no longer reach it. The server runs `detect`, `install`, `rollback`, `snapshot`, `importConfig`, `connectOpencode`, `coexistenceOperation`, `gitIntegrate` (merge, `npm run build` of changed packages), `gitPrepareWorktree` (`npm ci`) and `runBrowserQa` as jobs, and the post-merge check (`runSandboxedCommand` with `job:true`). It polls with backoff and keeps the job id in KV, so a reload or restart picks the job up again. A host without jobs gets the ordinary call.
- **No child process blocks the host worker.** The synchronous git, `opencode --version`, `gitnexus` and clone calls in git-integrate, git-ownership, coexistence, stack-ops, upstream, opencode-connect, critique-coverage and the stability drill use `spawnAsync`. `tests/host-no-sync-spawn.test.ts` fails on a `spawnSync`/`execFileSync`/`execSync` anywhere host.ts can reach.

## 0.1.168

- **One writer session per task.** A failed check, a missing output or a stray file goes back to the same writer as a feedback turn in its own thread: what failed, what to do, and the full log path. The cap is 5 turns or 120 minutes. The session stops early only when the failure and the diff are both unchanged between two turns. A new writer (the next model in the chain) takes over only on a provider or limit failure. One session counts as one attempt.
- **A missing expected output is a warning when the checks are green.** The writer must have produced work, all of it inside owns_paths, and at least one check must have run and passed.
- **No second writer on the same work.** Sending another member of a task's family (`<id>.N`) while one runs or is parked returns `task_in_progress` with the running id. The hint says to use `lane_pilot_update_task` / `lane_pilot_answer_writer`.
- **A PM-verified blocked dependency can be marked satisfied** with `lane_pilot_update_task {taskId, satisfied:true}`, and its dependents start without a dummy follow-up task. A dependent also follows later members of a numbered dependency (`D1.2` → `D1.3`).
- **Dispatch answers at once and is idempotent.** Before, the PM got `{error: terminated}` while pm-read and plan critique still ran, and its resend created `.2`, `.2.2` and `.2.3`. Now the task and its queued attempt are saved before the long stages, and the call returns `state: queued` within 15 s. The same id with the same contract and plan, sent again within 30 minutes, returns the existing task (`deduplicated: true`). A reload in the middle of the stages blocks the attempt instead of starting a writer that skipped critique.
- **A silent writer gets nudged.** Every 5 minutes, a running writer whose thread is active with no event for `writer.silence_nudge_min` minutes (default 20) gets a steer: «no activity, continue; stop a hung command». It is nudged twice. On the third silence the attempt ends as `writer_silent_after_nudge` (class provider, uncharged) and the task moves down the writer chain. Wait receipts show `nudged`.
- **Wait receipts name the next step** for each task that did not end accepted, by its failure class: answer the writer, parked, moves down the chain, fix the contract, or dispatch again. The PM instructions describe the final loop: the integration gate runs the whole suite once per batch. Writers are told that the PM answers `NEEDS_HUMAN` in their own thread.
- **Writers' searches no longer fail on a 61 KB line.** `src/native-hook-sources.ts` is now generated line by line from `lane-stack/hooks` (`scripts/gen-native-hook-sources.mjs`). A root `.ignore` hides `dist/`, maps, run artifacts, `.bb/`, `.gitnexus/` and `node_modules/` from ripgrep.
- The workspace isolation setting offers only «auto» and «worktree».

## 0.1.167

- **Writers always work in their own git worktree (P1, decision 2026-10-06).** The project setting «В папке проекта» (`in_place`) is gone; a saved value reads as auto. Every writer attempt of a Lane chat gets its own worktree, and acceptance merges it into main. Plugin-page runs keep the risk-threshold rule for now.
- **A chat folder inside a larger repo gets a worktree too.** Before, such a folder (treba-sites `templates/blog` on OVH) fell back to in place. Now the host creates a worktree of the whole repo, and the writer works in the same subfolder there. Merging and removing the worktree use its top folder. The hub no longer runs git on a folder it may not see: the git check, the dirt snapshot and the worktree all come from the workspace's host.
- **Writers in one folder no longer queue one by one.** Each writer has its own checkout, so only an owns_paths or area overlap makes a task wait.
- **BB bookkeeping without a hash no longer blocks an attempt.** Example: a chat file that was already dirty before the attempt.
- Main was red with 30 tests after the unfinished P1 commit (`ffd166e`). The suite is green again: 1385 passed.

Shipped with this release, from 2026-10-06 work that had no entry yet:
- each task has a folder with its PLAN.md for the writer, and a retry gets clean check output;
- Linux clean-clone tests;
- the PM guard: no pasting, no errand edits, and the unscoped SQL deletion rule;
- the acceptance metrics card on the Checks tab;
- the `lane_pilot_answer_writer` and `lane_pilot_update_task` tools;
- reminders follow a redispatch;
- the PM chat badge shows phases and a queue chip;
- the integration gate runs once per batch;
- bookkeeping files never block a merge;
- helpers are read-only on the repo;
- authorization follows the agreed goal;
- code roles get GitNexus/MetaMCP.

## 0.1.166

From a self-repair of «writer changed paths outside owns_paths or inside never_touch: <path>» (SelfyStudio, treba-sites, Lane Pilot; 2026-10-05…06):
- **A retry names a stray file correctly and asks the writer to undo only its own edits there.** In Lane Pilot `update-queued-task.2`, the writer added a settings row to `src/ui-catalog.ts`, a file outside owns_paths. The run-scope check names files outside owns_paths together with never_touch files, but the retry called the file «never_touch» and said «drop it». The writer reset the file to git HEAD. That also wiped another session's uncommitted edit in the shared checkout (the `workspace.mode` row without `in_place`). The task was still blocked, because the check compares the file with its state before the attempt, not with HEAD. Now the retry lists never_touch files and files outside owns_paths separately. It tells the writer to undo only its own edits, not to checkout or restore the file, and to answer `NEEDS_HUMAN: the task needs <file> changed (<why>); add it to owns_paths` if the task cannot be done without that file.
- The other five reports were already covered. The SelfyStudio `card-checkout.test.ts` cases date from 2026-10-05 and were fixed in 0.1.161. treba-sites `admin-white-full-url.4` is the subfolder-prefix case fixed in 0.1.164, which the hub has not received yet.

## 0.1.165

From a self-repair of «owns_paths rejected <path>» (content-factory and Lane Pilot, 2026-10-06):
- **A retry no longer sends the writer into files it does not own when a check fails there.** content-factory `host-read-binary` failed `npm run typecheck` in `ui/passport.tsx`: main was red for 17 minutes after two sibling tasks merged a minute apart (one used the `colStatus` key, the other renamed it). Lane Pilot `suite-green-pm-helpers` ran `npx vitest run tests/server …`, and that filter also ran `tests/server-reconcile.test.ts`, which was red on main. In both cases the retry said «fix what it names». The writer edited `ui/i18n.ts` and `tests/server-reconcile.test.ts`, and the task was blocked with «retry limit 2 exhausted: owns_paths rejected …». Now the retry names the files the failing check points at that are outside owns_paths. The writer must not edit them: if its own change broke them, it fixes that in owned files; if they fail without its change, it changes nothing more and answers `NEEDS_HUMAN: <check> fails in <file>, outside owns_paths and not caused by this task`, so the PM can wait for the mainfix or widen the contract.

## 0.1.164

From a self-repair of «missing expected_outputs: <path>» (treba-sites, SelfyStudio, content-factory, Lane Pilot; 2026-10-06):
- **A workspace that is a subfolder of a larger repo is checked in its own paths, on every machine.** treba-sites works in `templates/max_landing` and `templates/blog` inside the `/home/ubuntu/sites/treba-sites` repo on OVH. git lists dirty files from the repo root, and Lane Pilot looked for the subfolder with git on the hub, which cannot see an OVH folder. So the writer's change read as `templates/max_landing/index.html` and was hashed against a file that does not exist (sometimes against the wrong file of the same name). A contract written relative to the folder got «missing expected_outputs», then «outside owns_paths». When the PM rewrote it relative to the repo, the file read as missing. `hero-buttons-polish.2` and `admin-white-full-url.4` were blocked after two attempts each. The dirt snapshot now runs `git status -- .` in the workspace on its host. It keeps only the workspace's files, with the subfolder prefix removed, before hashing them. The server no longer strips the prefix a second time; in a folder the hub can see, that dropped every changed file. Contracts in such a workspace name paths relative to the folder (`index.html`, `admin/index.php`).

## 0.1.163

At the request of the content-factory PM (editor-policy-ui, 2026-10-06):
- **A provider's plan or quota notice moves the task to the next writer.** The writer on acp-cursor/grok-4.6 answered only «Upgrade your plan to continue». Lane Pilot read that as a task that did not produce its files. Both attempts of `editor-policy-ui` and `editor-policy-ui.2` were spent, the breaker stayed closed, and no other model was tried. A short answer that is only a provider notice (plan, usage limit, quota, rate limit, out of credits, credit balance) now ends the attempt as `writer_provider_limit: <notice>`. The attempt is not charged, there is no retry in the same thread, and the writer chain (fallback 1/2, then the PM's model) takes the task at once. A longer report that mentions rate limits stays a report.
- **The breaker opens on the first such notice.** Retries inside the window cannot pass a plan limit, so the provider/model pair opens without waiting for three failures. While it is open, a new task's writer that is refused with `breaker_open` goes down the chain uncharged, instead of spending its attempts on refused spawns.

## 0.1.162

- **Each task has a folder the writer can read.** The PM's canonical plan goes to `.agents/plans/items/<task id>/PLAN.md` in the workspace (excluded from git and never counted as produced), and the writer's brief points at it; the compact contract below the pointer stays the source of truth for owns_paths and checks.
- **Retries tell the writer what failed and what to do.** The previous attempt's record now opens with a `Result:` line followed by one «what failed → what to do» bullet per problem (failing check with its exit code, missing outputs, never_touch and outside-owns files, an answered-but-empty result), keeps the failing check's output tail and names the full log path. A check's full output is saved under the task folder `logs/`, so the retry reads it instead of rerunning blind.
- **A mainfix closes itself when main is already green.** Before spawning a writer, the repair task runs its checks on main: green, it is closed as accepted and the PM is told no action is needed. Otherwise its objective carries each failing command with its output tail, the full output goes to the task folder `logs/`, and expected_outputs hold the commands (never prose, never a file to chase) — a mainfix is accepted with zero changed files when its checks pass, and a command like `bin/check.sh` can no longer make it reject itself. A mainfix that breaks main again still only notifies the PM.
- **Two attempts failing the same way stop the task.** Two consecutive attempts of a task family (a task, its redispatches and mainfixes) with the same failure class and normalized reason block the task with `repeated_failure: <reason>` — no third writer and no fallback model, which would only repeat them.
- **An in-place redispatch counts its own family's leftover edits, never anyone else's.** Only the files an earlier attempt of the same task family produced leave the dirt baseline and count as produced; owner or other-task dirt in an owned file keeps its baseline.
- **An output the attempt inherited is met, not missing.** When the contract names a file that already sits in the workspace with content (a sibling attempt's work), it stops failing «missing expected_outputs» once the attempt produced its other outputs; a writer that produced nothing still fails.
- **A contract failure repeats and stops like any other.** Two attempts of a task family failing the same contract way (the same «missing expected_outputs», the same unmet name) now block with `repeated_failure` instead of burning a third writer.
- **An answered empty_output is the task's failure.** A writer that answers but changes no files fails as a task (the same failure twice stops the task); a writer that returns no output stays a provider failure and still moves down the writer chain.

## 0.1.161

From a self-repair of «owns_paths rejected <path>» (SelfyStudio and content-factory, 2026-10-04…06):
- **A rejected attempt names every file outside the task's owns_paths, not just the first.** When a writer changed a file no task of the run owns and a file a sibling task owns, the reason named only the first. The writer restored that file on its same-thread retry, and the retry then failed on the second. SelfyStudio `cards-retention-1day.4` and `cards-checkout-cabinet-chips.2` were blocked with «retry limit 2 exhausted» this way on 2026-10-05. Now both checks list the files that are outside owns_paths and the files that are in never_touch, all in one reason, so one retry can fix all of them.

## 0.1.160

- **«Токены»: the cost column header is `$`.**

## 0.1.159

- **«Токены» no longer shows a negative API cost for Claude.** Daily rows store uncached / cache-read / cache-write, and the estimate uses the 5-minute cache-write list price. Codex rows stay on the previous formula (its cache writes are zero). Project rows use BB project names, including personal and archived.

## 0.1.158

- **«Токены» shows an estimated API dollar cost.** The last column of the model and project tables, and a total, use Anthropic and OpenAI public list prices as of 2026-10-06. Cached tokens are billed as cache reads only; unknown models show — and are left out of the total.

## 0.1.157

- **«Токены» merges context-window variants of a model.** `claude-opus-5-5` and `claude-opus-5-5[1m]` (and the same for `claude-opus-5`) are one row in by-model, daily series, project top model and month totals. Daily storage stays as ingested; the merge is at read time.

## 0.1.156

- **«Токены» is its own left-nav entry**, after «Агенты», not a project tab. The page shows spend of every BB session: models, days, sync diagnostics, a per-project table (name, total, share, top model) and a project filter.

## 0.1.155

From a self-repair of «missing expected_outputs: <path>» (SelfyStudio and content-factory, 2026-10-02…05):
- **A folder in expected_outputs is met by a file the writer changed in it.** A PM may name a folder (`…/greeting-cards`, `…/greeting-cards/` or `…/greeting-cards/**`). Lane Pilot looked for a changed file with exactly that path, which a folder never is. On 2026-10-05 the writer of SelfyStudio `cards-preview-lightbox-fullscreen` changed three files in the folder, and the task was blocked after two attempts.
- **A `-mainfix` task no longer inherits the merged task's expected_outputs.** Those files are already in main, and the repair may be in another owned file or need no change. The writer of `cards-checkout-typecheck-fix-mainfix` found main green and edited `routes.ts` only so that the required file would be in the diff. When every check already passes before any change, the repair writer now changes nothing and answers `NEEDS_HUMAN: main is already green, nothing to fix`, so the PM can close the task.

## 0.1.154

- **Token sync reads BB events in pages of 100.** `events.list` with `limit` above 100 is HTTP 400 on the live hub, so a thread's 6110 usage rows never arrived. Paging stops on a short page.

## 0.1.153

- **The «Токены» tab** (global and per-project) shows tokens by model from BB thread events, for 7/14/30 days or a calendar month, without calling provider APIs. Collection is incremental per thread, every 30 minutes and once on startup, in the background so other schedules keep their turn. On the live hub the tab stayed empty despite 6110 `thread/tokenUsage/updated` events: listing now uses the real SDK call (`threadId`, `order:"asc"`, string `limit`/`afterSeq`, types `thread/tokenUsage/updated`, `client/turn/requested`, `client/thread/start`, `provider/modelFallback`); a failed listing is counted, the first error is logged once per pass, and that thread's cursor is not advanced. The model comes from `client/turn/requested` `data.execution.model`, then `client/thread/start`, then `provider/modelFallback`. Cursors written by 0.1.151 are reset once so the next pass backfills 90 days. Sync diagnostics sit next to the last sync time; switching project scope reloads the open tab; the month picker lists every month that has data.

## 0.1.152

From a self-repair of «attempt_workspace_snapshot_failed: cannot read writer-workspace git diff: host plugin call … exceeded its deadline» (SelfyStudio, 2026-10-05):
- **Long commands no longer freeze Lane Pilot's host worker.** Checks run on the host (`runSandboxedCommand`), `runCommand`, `runCli`, browser QA and the `npm ci` / `npm run build` of a merge used `spawnSync`. While one ran, the worker could take no other call and could not answer the daemon's cancel. A short call queued behind it missed its deadline, and the daemon SIGKILLed the worker, the running check with it. On OVH this happened 15 times on 2026-10-05: each time a post-merge `vitest` on SelfyStudio main blocked the worker. The writer's workspace snapshot (30 s) hit the deadline and the task was parked. These commands now run asynchronously (`src/spawn-async.ts`), with the same limits and the same result.
- **A post-merge check that could not run no longer reads as a red main.** The killed check came back as exit 1 with «host plugin worker exited (SIGKILL)». Lane Pilot then dispatched a `-mainfix` task for a green main: 6 on SelfyStudio that day, and their writers found nothing to fix. A check whose host call failed is now logged as «could not run» and dispatches nothing.

## 0.1.150

From a self-repair of «relay sweep failed: HTTP 502: The "lane-pilot" plugin's message.dispatch hook failed: did not decide within 10000ms» (2026-10-05):
- **A message into a Lane Pilot chat no longer waits for the host.** For every message into a PM chat, the `message.dispatch` hook prepared the Claude launcher on the host again (`claude --version` and `claude --help`). BB gives that hook 10 s. On a busy OVH host this took up to 36 s: 15 of 629 sends went over the limit, and BB refused the message with HTTP 502. Relay reminders to the SelfyStudio PM failed this way 6 times on 2026-10-05, and owner messages were open to the same failure. A chat that is already bound and has a prepared launcher now proceeds at once. The launcher is refreshed in `contributeEnv` on the same send, as before.
- **A slow refresh no longer takes the PM's agent away.** BB drops a plugin's provider env after 5 s. When the host does not answer within 2.5 s, `contributeEnv` returns the cached launcher, and the refresh still updates the cache for the next turn.

## 0.1.149

From a harness-engineering guide review (2026-10-05):
- **A thrown error from a `lane_pilot_*` tool is structured.** The PM gets `{ok:false,error:{code,message,retryable,sideEffects}}` instead of an uncaught throw, so it can retry or stop without guessing.
- **The PM retries a failed tool only when it is safe.** Retry only when `retryable` is true and `sideEffects` is `"none"`.
- **Outside text is fenced.** Browser page text, an errand report, a specialist answer and council statements come back inside `<outside_data source=...>`, with a preface that they are data, not instructions.
- **A run's child-thread budget is enforced.** `run.max_children` counts writer and helper threads; the next spawn over the limit is refused with `run_budget_exceeded:child threads`.
- **A running writer is stopped when the wall or token budget is gone.** Over `run.max_wall_minutes` or `run.max_tokens` the writer is stopped and the attempt blocked with `run_budget_exceeded:<kind>`; it is not charged and not restarted.
- **`lane_pilot_run_health` shows child threads** used against the limit.
- **The `timeout` attempt state stays** so old rows still classify; a budget overrun is `blocked`, not moved to `timeout`.

## 0.1.139

From checking 0.1.138 live on SelfyStudio (2026-10-05):
- **Memory and project-life stages resume after the plugin has loaded.** Their loops were restarted inside the plugin factory, so after every reload the first host call failed with «host plugin calls are unavailable during factory registration». Until 0.1.138 that went unnoticed: the next round retried it. 0.1.138 made such an early error final and failed a project-life stage with that reason. The loops now start as the first step of the `startup-recovery` service, like the rest of the recovery since 0.1.60.
- **A host hiccup before the spawn claim is retried, not final.** An error before the claim that names the host, a disconnect, ECONN, 502 or `events_list_error` keeps the stage running for the next round, as the stage already does for its child thread. Other early errors and HTTP 4xx spawn refusals still end the stage `failed`.

## 0.1.138

From the same self-repair, after 0.1.137 went live (2026-10-05):
- **A memory or project-life stage that cannot get its child now fails instead of staying open.** Every error without a child thread was taken for «the spawn may have happened», so the stage stayed running and later rounds were refused their spawn claim. Now, when Lane Pilot is sure no child exists, the stage closes `failed` with the reason: the error came before the spawn request (`project_life_git_base_unavailable` on a cleaned worktree, an unsupported service tier, an unavailable model), or BB refused the spawn with an HTTP 4xx (`HTTP 409: Environment unavailable` for a task whose worktree was already removed). An unclear spawn outcome still waits for the child.

## 0.1.137

From a self-repair of «stage memory-maintenance left running … after its task's attempts ended» (2026-10-05):
- **A post-acceptance stage no longer stays running forever in a large project.** Before spawning its child, every memory, docs, project-life, night-review and onboarding stage looked for a child lost in a reload by reading the metadata of every Lane Pilot thread of the project. SelfyStudio has 1255 of them, more than the 1000 the scan reads, so the scan returned `page_cap`, the stage recorded `observing: blocked` and never spawned. Each of 42 background loops repeated that full scan 60 times and then gave up with the stage still running (41 memory stages, 1 project-life stage, 2026-10-04). A stage that never claimed its spawn cannot have lost a child, so it now skips the scan. A stage whose spawn began before its thread id was stored is still scanned.

## 0.1.136

From a self-repair of «kept worktree …: its changes could not be saved (… stale API handle …)» (2026-10-04):
- **A reload no longer reads as a lost save.** A reload ended the plugin while its worktree sweep waited on a host snapshot; the old instance went on to the next worktree and logged «kept worktree … could not be saved» with a stale API handle or a retired host generation (4 + 14 lines on the hub today), and the self-repair watcher took them for failures. Nothing was lost: the new instance saved the same worktrees minutes later. The sweep now stops quietly when its plugin is gone, and its «sweep skipped» line stays out of the log in that case.

## 0.1.135

From stopping SelfyStudio's run on the owner's request (2026-10-04):
- **A cancel ends the fallback chain.** Stopping a fallback writer's thread read as a provider failure and the chain started the next model; it now stops when the attempt was canceled.
- **An attempt whose writer is still starting can be canceled.** It was refused («attempt has no writer thread»); it is now marked, and the spawn stops the thread it gets and ends the attempt canceled.
- **`halt_run {runId}`** stops a whole run: cancels every open attempt, drops its parked tasks and keeps it out of parking, restarts and post-merge repair tasks, until the PM sends a task in that run again.

## 0.1.134

- **A finished task survives a reload during its acceptance.** Lane Pilot writes its receipt (`.agents/runs/<run>/artifacts/<task>/acceptance.json`) into the attempt's worktree before the merge; when a deploy reloaded the plugin in that window, the resumed check read the receipt as the writer's own change and failed the task with `owns_paths rejected …/acceptance.json` (SelfyStudio `gc-hub-port-full.2`, and `gc-scenarios-wishes-pixel.2` twice until its retries ran out, 2026-10-04). The final output check now sees the same files as the ownership gate: bookkeeping under `.agents/`, `.bb/` and tool caches counts only when the task owns it.

## 0.1.133

From the SelfyStudio PM's bug report (2026-10-04):
- **`lane_pilot_wait_writer` says what happened to each task.** A long run always has something running, so the answer was a bare `running` and two tasks blocked at 17:03 looked to the PM like they were still waiting, for two hours. A running result now carries `tasks`: every task touched in the last 3 hours with its state, its reason when it ended and what it waits for when queued; `stages` is cut to those tasks instead of every stage of the run.
- **Reminders:** 150 a day and 20 open per PM thread (were 30 and 10), so a PM can follow a day-long run.

## 0.1.132

- **The PM hears a writer's question at once.** Writers are quiet children, so a task blocked with `NEEDS_HUMAN` waited unseen (SelfyStudio `gc-sec-hub-d.2`: asked at 17:24, the PM found out two hours later). Lane Pilot now sends the PM the question as soon as the task stops.
- **Dependents wait for a fixed dependency instead of failing.** A task whose `depends_on` ended blocked keeps waiting up to 6 hours for that task to be sent again (`<id>.2`) and accepted, then starts by itself; before, the whole chain failed at once and the PM had to resend every link. A canceled dependency still ends the wait at once.

## 0.1.131

- **15 writers at once per run by default** (the owner's choice), also the most `ops.pool_size` takes. The writer pool and the bounded-concurrency helper had their own cap of 10; both follow the same limit now.

## 0.1.130

- **Writers at once per run: 10 by default (was 5), up to 15 (was 10).** Setting `ops.pool_size`; no project had its own value, so all get 10. A run that already started keeps the pool it froze; new runs and the PM's next batch use the new value.

## 0.1.129

- Helper chips are icons again (the owner's choice): role icon and pulse, the task on hover, click opens the chat; «+N» past three and the badge kept on one line stay.

## 0.1.128

- Helper chips beside the agent badge keep to one line: a long task name is cut with an ellipsis at 11rem, and the badge itself no longer wraps on a narrow composer (seen live at the side-panel width).

## 0.1.127

- **A working helper beside the agent badge now reads as one:** its role icon, a pulse and the task's name (cut to fit) instead of a bare 20 px square nobody took for a running writer; a click opens its chat in the side panel. Past three helpers the rest fold into «+N», which opens the list.

## 0.1.126

- **Writers no longer stop for a tool the project's rules name but the worktree lacks.** SelfyStudio's AGENTS.md requires a GitNexus impact check before edits; writers had no GitNexus and answered «restore GitNexus access» (NEEDS_HUMAN), blocking a 6-task chain on 2026-10-04. The brief now says such a rule is no reason to stop: read the code yourself and go on.

## 0.1.125

- **Working helpers show beside the PM chat's agent badge again.** The squares listed the PM's children one page of 50, oldest first; a long chat (SelfyStudio: 335 children) never reached the working writers. It now reads unarchived children, every page.
- **Writers are hidden again** (reverts the visibility part of 0.1.124): the owner wanted the working writers beside the badge, not as separate threads in the project tree.

## 0.1.124

Handed to agents, not the owner:
- **A retry knows why the last attempt failed.** The next writer gets the failure, the failing check with its output tail and the files the attempt changed, fenced as data (`<previous_attempt>`). Live: the retry of a sandbox task asked the exact question the failure raised.
- **Main is checked after each merge (0.1.123).** The task's checks run again on main with everything merged so far; when main is red the work stays merged and Lane Pilot dispatches a repair task `<id>-mainfix` with the failing output in its plan, and tells the PM (a repair that breaks main again goes to the PM instead of chaining). Live: sandbox task accepted, check red on main, `-mainfix` dispatched by itself.
- **Self-repair takes on the stability layer:** a task parked on a Lane Pilot fault for an hour (kind `parked`), a project breaker open for 30 minutes (`breaker`, kept in KV `stability:breakers`) and a failed fire drill (`drill`) become repair incidents.
- **Weekly fire drill** (Mondays 05:00, host call `stabilityDrill`): on every machine that ran a writer this week, a scratch repository gets a stale `index.lock` and a merge cut off midway, and Lane Pilot's recovery must still merge; disk reading is checked too. The outcome is in KV `stability:drill`.
- **Writers are visible.** In the default «in the plugin» placement every Lane Pilot thread was hidden, so writers' work looked like it ran outside BB. Writers, emergency and night fixers, specialists, errands and browser checks now show under the PM chat; critics, readers, memory, docs and worktree holders stay hidden.

## 0.1.122

- **Rules no longer wait for the owner when the project is full.** SelfyStudio had 12 rules in force (the cap), so 5 new ones — 4 from the PM, 1 from the analyzer — sat in «awaiting your decision». Now:
  - writer rules and PM rules have separate caps of 12 (PM rules never reach the writer's brief);
  - a new rule in a full pool takes the slot of the weakest rule on trial for 3+ days — for writers the one given to the fewest attempts, for the PM the oldest; confirmed rules and the owner's are never displaced, and the journal records `displaced by a newer rule`;
  - waiting rules try again at start-up and on every rule scan — the PM's too (only the analyzer's were retried before).

## 0.1.121

- **Fix: a reload could leave Lane Pilot «degraded: service startup-recovery did not stop».** The start-up recovery (resume, worktree sweep with snapshots, parking) ran inside the service and ignored the stop signal until it finished; under a deploy drain its snapshot calls waited, and the next reload found it still running. The recovery now runs beside the service, checks between steps whether to go on, and the service stops at once. Seen on the first drained deploy of 0.1.120; the push script now reloads a second time when BB reports another version.

## 0.1.120

- **Deploy drain.** A reload stopped the host worker mid-call; a git merge killed there left `.git/index.lock` in SelfyStudio's main and failed every merge for an hour. New RPCs `deploy_drain {on}` and `deploy_status`: while draining, host calls that write to a checkout (merge, worktree create/remove/prepare, docs commit, snapshot, rollback, install, docs pages) wait, running ones finish, and the push script reloads once none is in flight (it falls back to the old acceptance wait on a Lane Pilot without drain). A drain nobody ends stops by itself after 20 minutes.
- **An unfinished merge is aborted:** before a merge, a `MERGE_HEAD` older than 10 minutes in the base checkout (a merge whose process died) is aborted under the integration lock, so later merges can start.
- **What the checks are worth** (Checks tab, RPC `critic_stats`): per critic, over 7 or 30 days — tasks checked and blocked, what became of a blocked task (fixed and accepted, sent again without acceptance, dropped), contract mistakes it let through (with examples), and first-try acceptance of checked vs unchecked tasks. SelfyStudio, last 7 days: plan critique checked 140 and blocked 8 (5 then fixed and accepted); checked tasks were accepted on the first attempt 40% of the time vs 18% without the check.

## 0.1.119

- **Fix: start-up parking could pick work already done.** It took tasks by when their attempt was last touched, so a 2-day-old task a cleanup had touched the day before (`…-r3`, replaced by an accepted `…-r4`) was parked; its restart failed before a writer started, so nothing was redone. Parking now goes by when the attempt started (last 24 h), and a task counts as taken over when a sibling with the same name stem (`<id>.N` or `<id>-rN`) was accepted at any time or sent after the failed attempt started.

## 0.1.118

- **Fix: a parked task's restart died on «illegal stage transition writer-agent: failed -> running».** Its writer stages had closed as failed; they are now set back to pending before the restart (`reopenWriterStages`). Seen live on the first three SelfyStudio restarts after 0.1.117 — the project breaker opened on it as designed and held new writers until this release.

## 0.1.117

- **Fix: a merge git refused for another reason was reported as a merge conflict with no files.** On SelfyStudio a stale `.git/index.lock` in main (from 09:29 UTC, no holder) failed every merge for an hour; each read «merge_conflict: main changed since this attempt started:» while main never moved, and the tasks spent their attempts on it. Such a merge is now `merge_failed: git merge failed: <git's error>` — a machine fault when it names `index.lock` — and since 0.1.116 the stale lock is moved aside before the next merge.
- **Tasks already blocked by a Lane Pilot or machine fault are parked at start-up** (last 24 h, latest attempt, not sent again by the PM) and restart by themselves like any parked task.

## 0.1.116

Stability, after the 2026-10-04 incidents and a survey of how merge queues, workflow engines, CI and agent harnesses handle failures (`.bb/chats/thr_tev4nistgf/artifacts/failure-practices/REPORT.md`).

- **Failure classes** (`src/failure-class.ts`): every failed attempt is task, provider, merge, harness (Lane Pilot's fault), infra (machine), contract or judgment. Only task and provider failures spend the task's two attempts; a merge conflict or a Lane Pilot or machine fault is retried for free, at most 3 extra times (as Kubernetes `podFailurePolicy: Ignore`, Buildkite automatic retry).
- **Parked tasks restart by themselves.** A task ended by Lane Pilot's own fault is parked with the fault's fingerprint and restarts from its writer stage once a newer Lane Pilot runs; a machine fault restarts after 10/20/40 min. At most 3 restarts per project per 5-minute pass; a task the PM already sent again is left alone. The PM gets one message listing what was parked and restarted (Temporal, Step Functions redrive, SQS redrive).
- **Project breaker:** three tasks failing on the same Lane Pilot fault within 15 minutes hold the project's new writers until the fix ships, letting one through after 30 minutes.
- **Disk guard:** a writer waits while its host has less than 15 GB or 5% free (new host call `diskFree`).
- **Stale git lock:** before a merge and before creating or removing a worktree, an `index.lock` older than 60 s with no live holder is moved aside.
- **Flaky checks:** a failing verification command runs once more; passing on the re-run counts as passed with `flaky: true`. A command killed by its time limit is not re-run (the host sandbox now reports a timeout as exit 124).
- **Contract checks before a writer:** `output_binary` (warning) for fonts, images, archives a model cannot author; `verify_filter_ignored` (error) for `npm -w <ws> run test -- <filter>` when the script is `node --test`, which ignores the filter; `depends_self` and `depends_cycle` (errors).
- PM prompt: merge conflicts and parked tasks are handled by Lane Pilot; the PM does not redispatch them.

## 0.1.115

- **Fix: a failed attempt's retry was blocked with `reconcile_page_cap`** (SelfyStudio, 4 tasks on 2026-10-04 right after 0.1.114). Before a retry Lane Pilot scanned every thread of the project for the attempt's writer although that thread is stored; the scan now runs only when it is not, over unarchived threads.

## 0.1.114

- **Fix: every SelfyStudio task was blocked with `attempt_worktree_holder_ambiguous:page_cap`** (2026-10-04, 13 of 15 tasks of one batch). Each fresh attempt scanned every thread of the project, reading each one's metadata, for a worktree holder it could not have yet: over a minute per attempt once the project had ~1000 Lane Pilot threads, then a hard block past 1000. The scan now runs only for an attempt whose holder spawn had begun (KV `holder-spawn:<attempt>`, set before the spawn, cleared once the holder id is stored) — the one case a holder can be lost — and the holder and critic scans list unarchived threads only.

## 0.1.113

- Guard (bundled from Lane Stack 1.64.8): deleting for good outside regenerated folders is refused with a pointer to `~/.agents/bin/agent-trash`, which moves files to the Trash; rm inside quoted text no longer trips it.
- Writer brief: delete with agent-trash, not rm (it used to say rm -f was blocked and suggest unlink / find -delete).

## 0.1.112

- Fix: a task no longer waits on an overlapping task that itself depends on it (owns_paths overlap × depends_on deadlock seen live on SelfyStudio `gc-native-price-watermark.5` / `gc-native-how.5`).

## 0.1.111 — 2026-10-04

- **A task that expects a file outside its owns_paths is stopped before a writer runs** (structural finding `output_unowned`): no attempt could pass it, and such contracts were sent again 3–5 times on 2026-10-03.
- **The PM sends a batch's dispatch calls side by side in one message**, so their plan checks (median 68 s each) run at once. Measured: the PM waited 59 min of wall time on dispatch calls over 37 tasks; making dispatch asynchronous would not start writers sooner (the check must pass first), so it stays synchronous.
- Measured and not a bottleneck (2026-10-03, SelfyStudio): worktree provisioning (median 40 s), writers' own test runs (≈36 s per attempt, full suites 8 times a day), Lane Pilot's verification (median 6 s per command).

## 0.1.110 — 2026-10-04

What slowed SelfyStudio down on 2026-10-03 (37 tasks, 88 attempts, 31 accepted — 35%; report `.bb/chats/thr_tev4nistgf/artifacts/dev-speed/`):
- **A bare file name in `expected_outputs` is found under owns_paths.** The PM wrote `CardMockCard.vue`; Lane Pilot looked for it at the repository root, so 22 of 57 failed attempts were writers whose file was in its folder — each such task failed every attempt and was sent again 3–5 times. The PM instructions now ask for repository paths and keep prose in `acceptance`.
- **A missing expected file no longer runs the writer model chain.** It is the contract's problem; GLM 5.3 Flash spent a median 138 min per such task before failing the same way.
- **The 3rd and 4th writer of the chain no longer end `internal_error`.** The stage receipt keeps attempts 0–2; fallback writers wrote 4 and the task blocked.
- **A worktree waits up to 10 min to be provisioned** instead of 3: five tasks sent together waited in BB's thread queue and all blocked with `missing_environment_id`.

## 0.1.109 — 2026-10-03

- **A browser check's verdict is not a Lane Pilot failure.** The 0.1.108 start-up adoption logs «Lane Pilot browser check <task> adopted after a reload: failed» when the product failed its check (gc-qa-free-session.5: SelfyStudio's «Выбрать» did nothing for designs the generator lacks). The self-repair watcher read the word «failed» in that line as Lane Pilot's own fault and opened a repair thread; such lines are now skipped like other non-faults.

## 0.1.108 — 2026-10-03

Self-repair of «stage left open after its task's attempts ended» (SelfyStudio, three tasks, three causes).
- **A task blocked by its `depends_on` closes its stages.** The writer never starts, so `writer-agent`, `verification` and `acceptance-receipt` used to stay pending until the next plugin restart (gc-native-price-watermark.4).
- **A failed attempt whose retry died with a reload ends.** Start-up recovery resumes only attempts in flight; one left at `empty_output`, `validation_failed` or another retryable state was retried by nobody and kept «writer-agent running» for good (bot-preset-catalog-style-fallback-r3, 30 h). On start-up it is now blocked with «…; its retry was lost in a plugin reload» and its stages fail, so the PM can dispatch again.
- **A browser check survives a reload.** The check thread kept working, but the wait for it died with the plugin and its verdict was lost: the stage stayed «running» (gc-qa-free-session.5, whose thread had finished with «failed»). On start-up Lane Pilot now reads the verdict of such a thread, or waits for it until the check's deadline; a claim that never saved a thread id becomes blocked, so it may run again. The receipt also keeps `spawnAttempted` after the thread starts: without it a second `lane_pilot_browser_qa` call claimed the stage again and could start a second check.

## 0.1.107 — 2026-10-03

- **`bb plugin reload|install|update` only from a `bb-plugin-*` checkout**, as the owner confirmed (thr_4autf3vdii): a plugin's own PM ships it; a product PM cannot reload Lane Pilot under running writers. BB reads stay open to every Lane Pilot PM.

## 0.1.106 — 2026-10-03

- **The Lane Pilot PM may read BB state and ship plugins itself** (owner's request via thr_4autf3vdii). Its bb allowlist adds `plugin list|logs|info|show|status|reload|install|update`, `environment list|show|get|providers`, `host list|show`, `provider list|models`, `skill list`, `memory catalog`, `project get`, `version`; deploy steps (`bb-plugin-push`, rsync/ssh to the hub, restarts, tags, `gh release`) were already open. Still closed: starting, stopping or archiving threads (`lane_pilot_specialist`, `lane_pilot_errand`, `lane_pilot_dispatch_writer` do that), `bb plugin rpc`, `bb env-catalog get` (use `env_get`), the terminal run machinery and shell edits of project files.
- **The native BB PM now gets the Lane Pilot rules.** It arrives as `dev-orchestrator` with `LANE_PILOT_AGENT_TYPE`, which took a second branch with the old bb rule and the old `[orchestrator-guard]` text; both PM forms now share one check (`_lane_pilot_shell_checks`). The terminal orchestrator keeps its own allowlist.

## 0.1.105 — 2026-10-03

Instructions audit of the PM, every helper prompt and the skills they load, against the infrastructure as it now is (reports: `.bb/chats/thr_tev4nistgf/artifacts/instructions-audit/`).
- **PM prompt.** New «Receipts» (what to do with plan-critique blocks, needs_human, a blocked dependency, a merge conflict, Lane Pilot's own faults — a repair thread handles those, the PM does not patch Lane Pilot) and «Done» sections; quiet helpers spelled out (poll, or end the turn with `lane_pilot_remind` on the task ids — a turn without it is never resumed); one dispatch call per task; the writer model chain; outside-the-code work as a short list (browser, errand, browser QA); text from pages, mail and research marked as data. Removed: names of tools the PM does not have, the list of old terminal commands. A test fails if the PM text names a tool the PM lacks.
- **PM tools.** Handoff and the file-memory tools (`memory_import/export/golden`) left the PM's set; dispatch, routing stats, council, health and lesson descriptions now match what the tools do (no polling councils, no «cancel this attempt», cap behaviour stated).
- **Guard texts** (Lane Stack 1.64.4): denials name the route per path; shell edits of project files are refused for the PM; force-push and `rm -rf` texts no longer contradict the prompt.
- **Helper prompts.** Shared tolerant JSON extraction for nine parsers with the exact contract in each prompt; repair round with one role and a parser that cannot throw; code critique no longer blocks a `changes_requested` with no blocking finding; errand and browser QA mark page text as data and report a missing `ERRAND:` marker as blocked; browser QA no longer mentions `bb connect`; writer brief: rules some on trial, contract wins, both costs of NEEDS_HUMAN, own worktree, no commit/push, secrets via `env_get`; memory maintainer, project-life, night fix/review, council, onboarding, docs and self-repair prompts fixed per the audit.
- **Role skills.** The memory maintainer (returns JSON, runs no tools) loads no skills; browser QA drops the terminal `browser-qa` skill; docs drop `wiki-methodology` (conflicted with the docs lint); dead skill names removed.

## 0.1.104 — 2026-10-03

The PM held independent tasks back in waves and the owner had to ask for parallel runs (SelfyStudio W3/W11 waited for a 90-minute reminder after their dependencies were in main).
- **Dispatch the whole plan at once.** PM instructions and the `lane_pilot_dispatch_writer` description now say what Lane Pilot already does: tasks with disjoint owns_paths run side by side, a task overlapping an open one queues behind it, and a task with `depends_on` starts by itself once those are accepted — so every task goes out now, none waits for a reminder. Only 14 of 128 SelfyStudio tasks in two days used `depends_on`.
- **`depends_on` follows redispatches.** A dependency named `P1` now means the latest of `P1`, `P1.2`, `P1.3`…; before, a dependent of a task the PM had to send again blocked after two minutes with «no such task was dispatched». The same holds for `lane_pilot_remind` task ids.

Verified live in the sandbox: the PM sent three tasks within a second, P3 with `depends_on: ["P1"]`; P1 and P2 ran in parallel; P3.2 blocked on the old lookup (P1 had been redispatched as P1.2); after the fix a task depending on `P1` started at once.

## 0.1.103 — 2026-10-03

- **Worktrees of failed, retried attempts are released too.** 0.1.102 released a worktree only when its attempts were accepted, blocked or canceled; a failed attempt (validation_failed, empty_output, …) stays in that state after its retry starts, so its ≈2 GB worktree stayed: 31 worktrees, 57 GB on OVH a day later. Now an attempt counts as over when it failed and a later attempt of the same task exists, and a holder worktree never bound to its attempt goes on the same terms. A failed attempt nothing replaced still keeps its worktree.
- **Changes are saved before a worktree goes.** Uncommitted edits (`~/.lane-pilot/released/<environment>.patch`) and commits no other branch has (`<environment>-commits/`) are written by git straight to files on the host (host call `gitWorktreeSnapshot`); if that fails, the worktree stays. Live on OVH: 30 released (23 with saved changes, 39 MB of patches), worktrees 57 → 16 GB, the rest live or recent.

## 0.1.102 — 2026-10-03

- **Worktrees of finished attempts are released while the run is open.** Every writer attempt gets its own BB worktree (≈2 GB in SelfyStudio); they were archived and deleted only when the run closed, and a Lane chat keeps its run open for days. 110 of them (220 GB) filled the OVH disk, and the host went offline: «Lane Pilot: Host is not connected». Every 10 minutes and at start, a worktree whose attempts all ended over 30 minutes ago is archived with its threads and deleted; the run's own workspace and anything an unfinished attempt uses stay. First pass on the hub: 92 released.

## 0.1.101 — 2026-10-03

- **A sub-agent's turn no longer ends a wait.** Codex reports its sub-agents' turns on the parent thread (with `parentToolCallId`); Lane Pilot counted them, so a docs agent's sub-agent closed as «interrupted» failed the whole unit while the agent kept writing in the project checkout. Its pages stayed uncommitted, a deploy found the tree dirty, and the interrupted sub-agent's git left `.git/index.lock` behind (SelfyStudio, 02:21 UTC). Applies to every wait on a child thread, writers included.
- **Nightly docs work in their own worktree.** Each place's pass runs in Lane Pilot's git worktree on `lane/docs-<hash>` (`~/.lane-pilot/worktrees/`), fresh from main for each pass; every checked commit is merged into the project checkout under the writers' merge lock, committed pages only. The checkout is no longer dirty or busy for hours. A pass that broke off keeps its worktree while units have saved progress; without a worktree it runs in place as before. `withBaseLock` takes the lock in the checkout's own git directory (`.git` is a file in a worktree), and a merge of markdown no longer rebuilds packages.
- **Two writer fallback models.** When the writer's model fails for reasons outside the task (a spent limit, a provider error, a model missing from the catalog), fallback 1 takes the task, then fallback 2, then the PM's model as before. Defaults: GLM 5.3 Flash (`acp-opencode` · `zai-coding-plan/glm-5.3-flash`, high) and Gemini 3.8 high (`acp-opencode` · `router9/ag/gemini-3.8-flash-high`); each can be changed or turned off under «Модель исполнителя» (`save_writer_fallback_selection`). A fallback that cannot start hands over to the next.

Verified live: a sandbox docs pass wrote in its worktree while the checkout stayed clean and merged one commit (7 files, +62/−33); a sandbox writer with a missing model was taken by GLM 5.3 Flash and accepted; the settings controls at 1280 and 390 px.

## 0.1.100 — 2026-10-03

- **Helpers no longer wake the PM.** BB sent the whole output of every finished child thread into its parent as a new turn: one SelfyStudio PM chat got 52 (16 plan critiques, 16 large-file readers, 15 writers, 4 memory passes, 1 specialist), and in a sandbox an owner message that arrived in the same turn went unanswered. Lane Pilot watches these helpers itself, so they now spawn with `experimental_vkQuietChild: true` in their plugin metadata, and VK core `quiet-child` (runtime vk.16) keeps their turns from waking the parent. The PM, errands and specialists stay as before: the PM waits for those. Older core stores the key and ignores it.

## 0.1.99 — 2026-10-03

The self-repair watcher went silent for 50 min on the hub. BB runs a plugin's schedules one after another and waits for each; `docs-nightly-catchup` and `docs-nightly-hourly` awaited a whole docs pass, so every other schedule waited too.
- The two docs-nightly schedules start their pass detached and return at once; a tick while the pass still runs is skipped. Failures go to the plugin log.
- `docs-maintenance-hourly` stays awaited: it observes at most 60 s per project.

## 0.1.98 — 2026-10-03

The PM can get work outside the code done. In thr_wb4dsw4usn it could not open Google Cloud Console nor look for a mail account: its shell may not drive the browser or read Env Catalog, and its only delegate edits code — so it sent the owner to click by hand.
- **`lane_pilot_browser`** — one goal in the owner's signed-in Chrome on the Browser QA machine through jev-ultrafast (the computer-use launcher), in seconds; returns the final URL, status and the visible text of the page it ends on (the toolkit launcher now prints jev's page text). A new host call `browserGoal` runs the launcher without a shell (the goal is an argument) and asynchronously. Goals that change anything need `changes: true` and `authorized: true`, given only when the owner asked for that change.
- **`lane_pilot_errand` / `lane_pilot_wait_errand`** — a helper thread for reading pages, several steps, recordings, mail or accounts. Role `errand` loads the browser-automation and Env Catalog plugins and the browser-automation, computer-use and env-catalog skills, nothing for code; it reports and ends with `ERRAND: done | blocked`.
- **Guard (Lane Stack copy).** The PM may run `bb env-catalog list` and `request` (names, not values); a denied `bb` command names lane_pilot_browser and lane_pilot_errand.
- Browser and errand work from any Lane Pilot PM chat, also after its run closed (they need the chat, not open writer work).
- The Browser QA machine is set once for all projects (global setting `browser_qa.host_id` = the Mac mini).
- PM instructions say when to use each. Verified live: a sandbox PM read the OAuth scopes of the OhMySEO Google Cloud project — `lane_pilot_browser` reached the page, then an errand read all three tables with screenshots.

## 0.1.97 — 2026-10-03

Writers get the rules their task needs. Measured on 75 SelfyStudio task contracts and 11 rules, each pair labelled by a separate reviewer, System One asked three times per task.
- **Who a rule is for.** Rules carry `audience` (`writer`, `pm`, `both`) and `always`. A PM rule (task contracts, reviews, merges, deploys) never reaches a writer — before, System One gave such rules to almost every writer. An `always` rule (how to run or read any command) reaches every writer without a question — before, System One never gave it, because no single task looks like it. `lane_pilot_lesson` asks for both, `session_lesson` takes them (older clients get `both`), and the Rules tab shows and changes them.
- **The probability, not the confidence.** The pick now reads System One's `probabilities.yes`; the `confidence` it used is a different number (0.03 where p(yes) is 0.51 — 696 of 825 answers differed). `councilJudge` returns `probabilities` alongside; its other callers are unchanged.
- **Threshold 0.06** instead of 0.3. Conditional rules («on error X do Y») read low; on 25 fresh tasks used for nothing else, recall went 0.53 → 0.91 and precision 0.52 → 0.74 against the old pick.
- **One wait.** Chunks of 8 rules are asked together, not one after another (an answer takes 0.5–1 s).

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
