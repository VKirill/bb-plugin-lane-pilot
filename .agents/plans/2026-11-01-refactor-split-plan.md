---
title: Lane Pilot — split plan for the largest source files
status: proposed
created: 2026-11-01
---

## Кратко для владельца (RU)

Это план разделения самых больших файлов кода Lane Pilot на несколько файлов поменьше.
Ничего не переписывается: код только переносится, поведение не меняется.

Три файла дают основную выгоду (их правят чаще всего, и в них больше всего строк):
1. `src/rooms/writer/server/start.ts` — запуск писателя, сейчас одна функция на ~1200 строк.
2. `src/rooms/storage/database.ts` — все запросы к базе в одном файле на ~1900 строк.
3. `src/rooms/writer/server/finish.ts` — завершение попытки, одна функция на ~850 строк.

Самый большой файл проекта (`sma-map/graph.ts`, 6266 строк) трогать не надо — он
сгенерирован автоматически. То же с `native-hook-sources.ts` и словарями i18n.

После каждого разделения нужно перегенерировать `docs/atlas.md` и поправить
ссылки «файл:строка» в документации — их проверяют тесты, иначе сборка упадёт.
Общий объём работ: ~30–40 часов инженера, знающего репозиторий, по частям.

---

## Method

Ranking input: the 35 largest files, the 60-day churn list
(`.bb/chats/thr_6pwx5dw9f8/tmp/churn.txt`), `git log` bug-fix density, and the
import graph. Score = churn × size × "is logic, not data". Generated files and
hand-maintained data tables were read and classified before proposing anything.

Public surface checked via `src/rooms/<room>/index.ts` barrels (e.g.
`src/rooms/storage/index.ts` re-exports ~90 names from `database.ts`) and
`tests/architecture/deep-imports.json` + `tests/architecture/boundaries.test.ts`,
which police cross-room imports — every split must keep the barrel unchanged.

Documentation cost (applies to every section below): `docs/atlas.md` is
generated (`npx tsx scripts/generate-atlas.ts`) and docs tests verify
`file:line` citations within ±2 lines, and `sma-map/entries.ts` rows hold
`path#symbol` proof strings checked by a test. Any moved symbol needs: atlas
regeneration, citation fixes in `docs/**`, and entry updates in `entries.ts`.
Said once here, not repeated per section.

---

## 1. `src/rooms/writer/server/start.ts` — 1413 lines, churn 60 → score 1

What it does today: admits and runs a writer attempt end to end. `createWriterStart`
builds the room service; inside it, `startWriterTask` (lines ~208–1405) is one
~1200-line closure that does workspace preparation, model/provider chain
selection with refusal tracking, prompt/execution-packet assembly, spawn,
bookkeeping of attempts, and wait/retry loops.

Mixed responsibilities:
- Model selection: `pickWriter`, `chainWithRoom`, `refusalShares`, `writerLoad`
  (provider chains, refusal quotas, load probing).
- Attempt admission & bookkeeping: `freshAttemptStart`, `quarantiningRegression`,
  `familyFailureRecord`, `noteAttemptOutcome`, the `admittedByCore` map.
- The orchestration loop itself: `startWriterTask` — git baseline decisions,
  packet sha, spawn, turn wait, outcome handling. This body alone is ~80% of
  the file.

Proposed modules (all inside `src/rooms/writer/server/`):

| new file | what moves | exports kept |
|---|---|---|
| `start.ts` | `createWriterStart` shell + `startWriterTask` orchestration (still large, ~700) | `createWriterStart`, `sameArea`, `dependsOnTask`, `CANCELED_REDO_WAIT_MS` |
| `start-model.ts` | `pickWriter`, `chainWithRoom`, `refusalShares`, `writerLoad`, `REFUSAL_*` | internal to room |
| `start-admission.ts` | `freshAttemptStart`, `quarantiningRegression`, `familyFailureRecord`, `lastOwnFailure`, `isOwnFailure`, `admittedByCore` | `freshAttemptStart`, `quarantiningRegression`, `familyFailureRecord` (already exported today) |
| `start-outcome.ts` | `noteAttemptOutcome` | internal |

Seams are clean: the model-selection cluster shares only `(settings, hostId,
projectId, taskId)`; admission helpers take `(db, runId, taskId)`.

Protecting tests: `tests/live-folder-start.test.ts`, `tests/pipeline.test.ts`,
`tests/host-no-sync-spawn.test.ts`, `tests/claude-guard-dispatch.test.ts`,
`tests/main-agent-spawn.test.ts`, `tests/writer-catalog-unavailable.test.ts`.
The seam with weakest coverage is the refusal-share window logic — write one
unit test for `refusalShares` before the move (it's pure SQL counting, easy).

Risk: medium. `startWriterTask` holds mutable closure state (`attemptId`,
`writerThreadId`, `dirtBefore`, `baselineDirtBefore`) across a long retry loop;
do not split *inside* it in pass 1 — move the helper clusters only. Runtime
risk that tests won't catch: none significant if only helpers move.

Hours: 4–5. Rollback: single `git revert`; keep the barrel identical.

## 2. `src/rooms/storage/database.ts` — 1926 lines, churn 78 → score 1

What it does today: the plugin's whole DAO. Lines 48–478 are the `migrations`
array (430 lines of embedded SQL). The rest is ~100 exported functions grouped
by table: runs, tasks, attempts + attempt transitions, stage receipts, gate
events, settings (CAS), secrets issuance, check durations, accepted facts,
worktree registry, inspect/state pagination.

Mixed responsibilities: schema migrations + 10 unrelated table domains +
`checkIdentity`/`checkHistoryKey` command normalization (pure string logic,
not SQL).

Proposed modules (inside `src/rooms/storage/`):

| new file | what moves | exports kept |
|---|---|---|
| `database.ts` | `openDatabase`, `LanePilotDatabase`, `HARNESS_VERSION`, shared row types | unchanged via barrel |
| `migrations-data.ts` | the `migrations` array literal | `migrations` (re-exported by `index.ts`) |
| `db-runs.ts` | `createRun`, `setRun*`, `getRun*`, `closeRun`, `listRunsPage`, `listRunsWithAttempts`, `freezeRunBinding`, `findOpenNativeRun`, `loadRunHelperPolicyJson`, `persistRunHelperPolicyJson` | all via barrel |
| `db-tasks.ts` | `createTask`, `getTask`, `listTasksForRun`, `listLiveTasksForRun`, `freeTaskId`, `saveTaskPlan`, `getTaskPlan`, `taskBasePath`, `saveTaskGitBase`, `getTaskGitBase`, `listTaskKinds`, `updateTaskContract` | via barrel |
| `db-attempts.ts` | `createAttempt`, `transitionAttempt`, `getAttempt`, `latestTaskAttempt*`, `recordFinishedAttempt`, `reviveCanceledAttempt`, `setAttempt*`, `saveReasoningTrace`, `getReasoningTrace`, `inspect*` | via barrel |
| `db-stages.ts` | stage receipts, stage events, gate events, `claimStageSpawn`, `claimDocsSpawn`, `listUnfinishedStages` | via barrel |
| `db-settings.ts` | `importSettingsOnce`, `casSetting`, `casUpsertSetting(s)`, `casResetSettings`, `getSettingVersions`, `listSettingRows`, `removeOwnSettings`, `clearSettingValue`, `savePrototypeConfig`, `loadPrototypeConfig`, `loadProjectSettings`, `saveProjectSetting`, `claimActivation`/`getActivation`/`releaseActivation` | via barrel |
| `db-telemetry.ts` | `recordSecretIssuance`, `listSecretIssuance`, `recordCheckDuration`, `listCheck*`, `checkIdentity`, `checkHistoryKey`, `recordThreadTurn`/`countThreadTurns` | via barrel |
| `db-facts-worktrees.ts` | accepted facts + worktree registry + `ownerKindOfName` | via barrel |

Seams: every function already takes `db` as first arg — zero shared state.
`attemptChanged`/`onAttemptChanged` pub-sub must stay with `db-attempts.ts`.

Protecting tests: nearly everything — `tests/errands.test.ts`,
`tests/activation.test.ts`, `tests/acceptance-v2.test.ts`,
`tests/memory-floor.test.ts`, plus transitively ~half the suite. The split is
mechanical move + re-export; `tsc --noEmit` is the main gate.

Risk: low. Only real hazard: migration order must stay identical (the array
moves verbatim, do not reformat). Watch that `openDatabase` keeps running
`migrations` from `migrations-data.ts` in the same transaction shape.

Hours: 3–4. Rollback: `git revert` — pure move, no behavior.

## 3. `src/rooms/writer/server/finish.ts` — 1094 lines, churn 54 → score 2

What it does today: finishes a writer attempt — merge into the base checkout,
integration gate, post-merge repair dispatch, owner-word waits, dirty-base and
merge-queue retries, final bookkeeping. `finishWriterAttemptBody` (~168–1014)
is one ~850-line closure; `checkMainAfterMerge` is another ~80.

Mixed responsibilities:
- Merge + gate orchestration (`gateFor`, `noteMergedForGate`, `mergeHolder`,
  `IntegrationGateRunner` usage).
- Post-merge repair construction (`postMergeRepair` top-level, log tailing,
  plan text building).
- Wait/retry policy (`MERGE_QUEUE_MS`, `DIRTY_BASE_WAIT_MS`,
  `OWNER_WORD_WAIT_MS`, `dirtyBase` predicate) woven through the body.
- After-merge verification (`checkMainAfterMerge`).

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `finish.ts` | `createWriterFinish` + `finishWriterAttempt`/`Body` (~500) | `createWriterFinish`, `postMergeRepair` |
| `finish-merge.ts` | `gateFor`, `noteMergedForGate`, `mergeHolder`, wait constants, `dirtyBase` | internal |
| `finish-repair.ts` | `postMergeRepair` helpers: `tail`, `logName`, log-map, plan text | `postMergeRepair` stays re-exported |
| `finish-main-check.ts` | `checkMainAfterMerge` | internal |

Protecting tests: `tests/nested-repo-flow.test.ts`, `tests/bookkeeping-exclude.test.ts`,
`tests/orphaned-worktree.test.ts`, `tests/one-session.test.ts`,
`tests/pipeline.test.ts`. Weakest seam: owner-word wait transitions — one test
that a `risk:high` task waits and a `risk:low` task doesn't already exists in
spirit (`owner.words risky` commit); verify before moving.

Risk: medium-high — this file is the merge hot path; a moved wait-condition
bug ships as a stuck task in production, not a red test. Move helpers first,
keep the body last.

Hours: 4–5. Rollback: `git revert`.

## 4. `src/rooms/phase/server/driver.ts` — 1238 lines, churn 55 → score 2

What it does today: the phase state machine. `createPhaseDriver` holds ~25
transition methods (`open`, `context`, `plan`, `planCheck`, `drawing`,
`goalAudit`, `lessons`, `question`, `answer`, `word`, `waveReview`, `withdraw`,
`revise`, `correct`, `stop`, `stopWave`, `compensate`, `returnTo`, `setState`,
`admitIfReady`) plus file-fingerprint helpers and the book writer
(`writeBook`, `book`, `move`, `facts`).

Mixed responsibilities: document I/O (read/sha/write docs), transition API
method group, journal/book persistence, and `mountPhaseDriver` wiring.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `driver.ts` | `createPhaseDriver` assembling pieces; `move`, `admitIfReady`, `mustGet`; `mountPhaseDriver`, `PhaseRefusal`, `PhaseApi` | `createPhaseDriver`, `mountPhaseDriver`, `PhaseRefusal`, `PhaseApi`, `DESIGN_JOURNAL`, `ROLE_LINES` |
| `driver-docs.ts` | `readFile`, `binaryFingerprint`, `readText`, `writeDocs`, `writeBook`, `book` | internal |
| `driver-methods.ts` | the `Reported &` transition methods (open…compensate) | internal |
| `driver-journal.ts` | `journalDrawing`, `noteDesignWord`, `addRoleLine`, `journalSteps`, `checkerRunBinding`, `reviewerRead` | internal |

The methods all need the same closure services (`ctx`, `services`, `move`,
`book`); pass a small `DriverTools` object rather than duplicating. Since
methods are individually exported through the returned `phases` API, the public
surface is `PhaseApi` — unchanged.

Protecting tests: `tests/phase-candidate.test.ts`,
`tests/block-plan-critique-stages.test.ts`, `tests/jev-plan.test.ts`, and the
SMA `entries.ts` proof strings that cite `driver.ts` line contents (these
*will* need updating — they're symbol-name based, so renamed files must keep
the cited function names).

Risk: medium. The closure-services pattern means method extraction is
repetitive; do it with a `DriverTools` bundle typed as
`ReturnType<typeof buildDriverTools>` — no new interfaces beyond that.

Hours: 5–6. Rollback: `git revert`.

## 5. `src/rooms/verification/git-integrate.ts` — 1131 lines, churn 38 → score 2

What it does today: all git plumbing for writer worktrees — worktree
create/remove/reuse, lane branches, integrate/sync (fetch, rebase, merge with
bookkeeping resolution), index-lock recovery, node_modules mirroring/cloning,
info-exclude management, protected-checkout detection.

Mixed responsibilities (already layered by prefix groups in the file):
- Worktree lifecycle: `createWorktree`, `orphanedWorktree`, `retire*`,
  `worktreeOfBranch`, `laneBranchTask`, `reuseLaneBranch`, `dropLaneBranch`,
  `workspaceGitLayout`.
- Integration: `integrateWorktree`, `syncWorktree`, `merge`,
  `rebaseOntoBase`, `resolveBookkeepingToMain`, `settleStagedBookkeeping`,
  `stageOwnedBookkeeping`, `stagedPaths`.
- Locking/recovery: `withBaseLock`, `withIndexLockNote`,
  `recoverStaleGitLock`, `abortStaleMerge`, `indexLockGone`, `ownerAlive`.
- Dependency mirroring: `withInstallLock`, `installBaseDependencies`,
  `dependenciesStale`, `refreshStaleDependencies`, `rebuildChangedPackages`,
  `nestedPackageDirs`, `workspaceDirs`, `mirrorNodeModules`, `dropLinksInto`,
  `cloneEntry` (+ the `NODE_MODULES_*` sets).
- Exclude lines & misc: `persistTaskFolder`, `taskFolderRel`,
  `appendExcludeCommand`, `ensureExcludeLinesCommand`, `infoExcludePath`,
  `ensureInfoExclude`, `protectedCheckout`, `changedBetween`, `git`,
  `identity`.

Proposed modules (inside `src/rooms/verification/`):

| new file | what moves | exports kept |
|---|---|---|
| `git-integrate.ts` | re-export facade + `integrateWorktree`, `syncWorktree`, `merge`, `rebaseOntoBase`, `withBaseLock` | every current export re-exported (room `index.ts` unchanged) |
| `git-worktree.ts` | worktree lifecycle + lane branches + `workspaceGitLayout` | `createWorktree`, `worktreeOfBranch`, `workspaceGitLayout` |
| `git-locks.ts` | lock/recovery helpers | `withIndexLockNote`, `recoverStaleGitLock`, `abortStaleMerge` |
| `git-deps.ts` | node_modules mirroring block (~lines 690–920) | internal |
| `git-exclude.ts` | exclude-line helpers + `persistTaskFolder`, `protectedCheckout` | `TASK_FOLDER_EXCLUDE`, `taskFolderRel`, `appendExcludeCommand`, `ensureExcludeLinesCommand`, `protectedCheckout`, `EXCLUDE_*` |

Protecting tests: `tests/git-worktree-subfolder.test.ts`,
`tests/orphaned-worktree.test.ts`, `tests/bookkeeping-exclude.test.ts`,
`tests/integration-gate.test.ts`, `tests/nested-repo-flow.test.ts`.

Risk: medium. `git-integrate.ts` has real bug history (3 `fix(...)` commits in
8 — replay dedup, worktree retry reuse). The merge path must keep its exact
command order; only move whole functions.

Hours: 3–4. Rollback: `git revert`.

## 6. `src/rooms/host-worker/host-handlers.ts` — 942 lines, churn 36 → score 3

What it does today: ~40 `ExperimentalHostRpcHandlers` implementations — thin
wrappers that call into git-integrate, docs-verification, job runner, JEV, and
misc helpers.

Mixed responsibilities by RPC prefix: `git*` (~15 handlers), `docs*` (~10),
`job*` (3), gate handlers, telemetry/file readers, permit tickets, worktree
janitor.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `host-handlers.ts` | registration assembly + `ctx`, `hashFile` | unchanged |
| `host-git.ts` | all `git*`, `worktreeJanitor`, `laneWorktreeRoot`, `runReplayChecks` | all handler consts |
| `host-docs.ts` | all `docs*`, `listDocsPages`, `writeDocsPages`, `applyOnboardingPages`, `gitCommitDocs` | handler consts |
| `host-misc.ts` | `job*`, `gate*`, `stabilityDrill`, `openCodeLimitProbe`, `diskFree`, `readOpenCodeTelemetry`, `readBoundedFile`, `listWorkflowFiles`, `listPermitTickets`, `jevSource` | handler consts |

Seams are trivial — each handler is already a standalone exported const.

Protecting tests: `tests/host-snapshot-dry-run.test.ts`,
`tests/host-no-sync-spawn.test.ts`, `tests/detect-rpc-shape.test.ts`
(the contract-shape test is the real guardian here).

Risk: low — pure moves; the RPC contract test catches a missing export.

Hours: 1–2. Rollback: `git revert`.

## 7. `src/rooms/self-repair/server/self-repair.ts` — 1273 lines, churn moderate → score 3

What it does today: the self-repair daemon — incident collection, signature
grouping, repair worktrees, verdict tracking, spawn of repair threads, the
repair workflow graph, status reporting. Roughly: lines 40–240 are config +
detection regexes + pure classifiers (`writerStrayFiles`, `writerRedCheck`,
`pointsAtEngine`, `reasonSignature`); 440–1255 is `createSelfRepair` internals.

Mixed responsibilities: pure detection/classification vs. stateful daemon
(collect → regroup → worktree → spawn → verdict → settle) vs. the registered
graph vs. status API.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `self-repair.ts` | `createSelfRepair` shell, `tick`, `status` | current exports |
| `self-repair-detect.ts` | all the regexes + `collect`, `writerStrayFiles`, `writerRedCheck`, `pointsAtEngine`, `reasonSignature`, `repairAnswerForThread` | `writerStrayFiles`, `writerRedCheck`, `pointsAtEngine`, `reasonSignature`, `repairAnswerForThread`, `VERDICTS`, `Incident`, `SelfRepairConfig`, `SELF_REPAIR_DEFAULTS` |
| `self-repair-state.ts` | `state`, `writeState`, `fitState`, `patchRecord`, `patchRecord` record types, `SignatureRecord` | internal |
| `self-repair-act.ts` | worktree create/release/settle, `spawnRepairThread`, `waitForSpawn`, `askOwnerAboutRepair`, `labelJevReceipts`, `readVerdict`, `settleRecord`, `regroup`, `placeThread`, `threadBusy` | internal |
| `self-repair-graph.ts` | `registerGraph` | internal |

Protecting tests: `tests/night-graphs/wall-hunt.test.ts` (adjacent),
`tests/jev/*` output-guard tests; direct coverage of `collect`/`regroup` is
thin — write one test for `regroup` signature merging before moving.

Risk: medium — a daemon; a dropped incident silently stops repairs (no crash).
Move pure classifiers first (zero risk), daemon body second.

Hours: 3–4. Rollback: `git revert`.

## 8. `packages/workflow-engine/src/engine.ts` — 1595 lines, churn low-medium → score 3

What it does today: `WorkflowEngine` class — graph run lifecycle: pin
resolution, step dispatch to `NodeExecutor`s, wait/deadline handling,
journal/draft persistence, spend accounting, crash classification, resume.

Mixed responsibilities: pure helpers (pins, usage sums, `checkStepOutput`,
`scopeChain`, lenient env) vs. the ~1300-line class.

Proposed modules (inside `packages/workflow-engine/src/`):

| new file | what moves | exports kept |
|---|---|---|
| `engine.ts` | `WorkflowEngine` class + `ENGINE_COMPAT_VERSION`, options | all current exports |
| `engine-util.ts` | `collectPins`, `addSpend`, `pinKey`, `checkStepOutput`, `scopeChain`, `lenient`, `asObject`, `requestGoals`, type-only exports | `requestGoals`, `StepInput`, `Usage`, `StepDone`/`StepWait`/`StepOutcome`, `PollResult`, `EffectReconcile`, `StepContext`, `NodeExecutor`, `RunSummary`, `CrashError`, `MissingValueError` |

Risk: high relative to payoff — the class is the hot path for every graph run;
a subtle closure-capture mistake breaks all workflows. The pure helpers are
the only easy win (~200 lines out). Splitting the class itself is NOT
recommended this round.

Hours: 1–2 (helpers only). Rollback: `git revert`.

## 9. `src/rooms/tools/server/cli.ts` — 712 lines, churn 57 → score 3

What it does today: `registerCli` — every `bb lane-pilot` subcommand handler in
one function, grouped already by command area but interleaved.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `cli.ts` | `registerCli` assembling groups | `registerCli` |
| `cli-runs.ts` | run/task/attempt commands | internal |
| `cli-workflow.ts` | workflow/graph commands | internal |
| `cli-admin.ts` | settings/doctor/state commands | internal |

(Exact group boundaries to be drawn from the command names inside
`registerCli` — they're already sequential.)

Protecting tests: CLI smoke coverage is indirect
(`tests/lp-drill-script.test.ts`); write one `registerCli` smoke test listing
registered command names before the split — the whole file's risk is a dropped
command at runtime.

Risk: low-medium. Hours: 2. Rollback: `git revert`.

## 10. `src/rooms/docs/server/docs-nightly.ts` — 1018 lines → score 4

What it does today: docs maintenance daemon — docs units (write → verify →
commit → finish), units index records, docs workflow graphs, nightly/catch-up
scheduling. Same factory-monolith shape as self-repair.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `docs-nightly.ts` | `createDocsNightly`, `createSerialQueue`, `docsMergeNote` | current exports |
| `docs-unit.ts` | `writeDocsUnit`, `runDocsUnit`, `startUnitRun`, `verifyDocsUnit`, `commitDocsUnit`, `finishDocsUnit`, record index helpers | internal |
| `docs-graphs.ts` | `registerDocsGraphs`, `runDocsMaintenanceGraph` | internal |
| `docs-schedule.ts` | `guarded`, `inBackground`, `scheduleDocs`, `runDocsCatchUps`, `runScheduledDocsMaintenance` | internal |

Protecting tests: docs tests exist (`atlas.test.ts`, docs citation tests) but
don't drive this daemon — write one `docsUnitRecordKey`/`updateDocsUnitsIndex`
test first.

Risk: medium (daemon; silent skip on failure). Hours: 3–4.

## 11. `src/rooms/workflow/server/workflow-executors.ts` — 732 lines, churn 38 → score 4

What it does today: `registerChainExecutors` — one executor per graph node
type, plus human-node parsing (`humanFields`, `humanOutput`, `namedOption`,
`DELEGATE`), contract defaults (`withContractDefaults`, `commandOf`).

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `workflow-executors.ts` | `registerChainExecutors`, `chainRuntimeFor`, `need`, `needLanePilot`, `pmCheckout` | current exports |
| `executors-human.ts` | `humanOptions`, `humanFields`, `humanOutput`, `namedOption`, `normalizeChoice`, `DELEGATE`, `MACHINE_HUMAN_WAIT_SEC` | `humanOptions`, `humanFields`, `humanOutput`, `MACHINE_HUMAN_WAIT_SEC` |
| `executors-contract.ts` | `withContractDefaults`, `commandOf`, `taskContractFields`, `shortPathCriticDefault`, `stringList`, `RISKS`, `VERIFY`, `asList` | `withContractDefaults`, `commandOf`, `shortPathCriticDefault` |

Protecting tests: `tests/errand-graph.test.ts`, `tests/council-graph.test.ts`,
`tests/owner-ask.test.ts` (human nodes), `tests/contract-lint.test.ts`.

Risk: low. Hours: 1–2.

## 12. `src/rooms/critique/server/critique-runs.ts` — 962 lines, churn low → score 4

What it does today: five independent critique runners — `runPmRead`,
`runPlanCritique`, `runCodeCritique` (+ `candidatePatches`,
`readCodeCritique`, `attemptEnvironment`), `runSpecialistReview`,
`criticTiebreakVote` — already cleanly separated functions sharing helpers.

Proposed modules:

| new file | what moves | exports kept |
|---|---|---|
| `critique-runs.ts` | shared helpers (`limitProbe`, `settingOn/Off`, `verdictReasons`, `dependencyFindings`) + re-exports | all current exports |
| `critique-plan.ts` | `runPlanCritique`, `runPmRead`, `dependencyFindings` | same |
| `critique-code.ts` | `runCodeCritique`, `candidatePatches`, `readCodeCritique`, `attemptEnvironment` | same |
| `critique-specialist.ts` | `runSpecialistReview`, `criticTiebreakVote` | same |

Protecting tests: `tests/code-critique-blind.test.ts`,
`tests/critic-tiebreak.test.ts`, `tests/critique-stage-reuse.test.ts`,
`tests/block-plan-critique-stages.test.ts`.

Risk: low. Hours: 1–2.

## 13. `src/rooms/harness/server/harness.ts` + `src/rooms/wall/service.ts` — 817 / 966 → score 5

Both are `create*` factory monoliths like self-repair (config/state helpers +
stages + sessions + tick/status). Same split shape: `-detect`/`-state`/`-act`
extraction only when next heavily edited — churn on both is below the top-25
list median today. Listed for completeness; defer until a functional change
touches them.

## 14. `packages/i18n/src/i18n.ts` — 2549 lines, churn 65 → score 5 (data, not logic)

What it is: ~2400 lines of hand-edited dictionaries already grouped into named
sub-objects (`chromeEn`, `fieldEn`, … × en/ru), merged at line 2421; ~120
lines of logic (`detectLocale`, `t`, `subscribeToLocaleHintChanges`,
`stateLabel`, `validationMessage`).

Verdict: **split dictionaries only if merge conflicts actually hurt.** If yes:

| new file | what moves |
|---|---|
| `i18n.ts` | merge + all logic (~250 lines) |
| `dict/<group>.ts` × ~17 | each `xxxEn`/`xxxRu` pair |

Mechanical, zero-risk, churn-65 payoff on conflict rate. `i18n-fields.ts`
(2108 lines) is the same and goes with it. Do NOT invent a loading scheme —
keep static imports.

## Ranked order of work

1. `storage/database.ts` — highest churn, pure mechanical move, lowest risk.
2. `writer/server/start.ts` — highest logic density; model-selection cluster
   out first, orchestration body untouched in pass 1.
3. `writer/server/finish.ts` — merge hot path; helpers out first.
4. `phase/server/driver.ts` — state machine; needs the `DriverTools` bundle.
5. `verification/git-integrate.ts` — layered groups, moderate bug history.
6. `host-worker/host-handlers.ts` — trivial, do whenever.
7. `self-repair/server/self-repair.ts` — classifiers first, daemon second.
8. `tools/server/cli.ts` — after writing the command-list smoke test.
9. `docs/server/docs-nightly.ts` — daemon; needs one record-index test first.
10. `workflow/server/workflow-executors.ts` — trivial.
11. `critique/server/critique-runs.ts` — trivial, low churn; optional.
12. `workflow-engine/src/engine.ts` — helpers only; class stays.
13. `i18n` dictionaries — only when conflicts bite.

## Do not touch

- `src/rooms/sma-map/graph.ts` (6266) — **generated** by
  `scripts/sma-map-import.py`; regenerate, never edit.
- `src/rooms/native-install/native-hook-sources.ts` (2420) — **generated** by
  `scripts/gen-native-hook-sources.mjs`.
- `src/rooms/sma-map/entries.ts` (1809) — hand-edited data table, but it is one
  `Record` keyed by node id whose `path#symbol` proofs are test-checked; size
  is the point of the file (it's the map). If split, split by SMA region into
  merged objects — low value, skip unless conflicts bite.
- `src/rooms/council/ui/office-*.ts`, `council-office.tsx` (684–941 each) —
  scene/UI assets for the council office; layout files are authored content,
  not logic. Revisit only when a UI redesign touches them.
- `src/rooms/ui-shell/ui/use-lp-page.tsx` — UI hook; churn low.
- `packages/i18n/src/i18n-fields.ts` — data table (see §14).
- Legacy paths in the churn file (`src/contracts.ts`, `src/database.ts`,
  `src/server/writer/*`, `src/host-handlers.ts`, `src/native-agent-overlay.ts`,
  `src/server/tools.ts`, `src/ui-catalog.ts`) — historical; files moved or
  deleted already. Confirm no ghost file before acting on any.

## Documentation cost

Every split must end with: `npx tsx scripts/generate-atlas.ts`, a pass over
`docs/**` for stale `file:line` citations (docs tests check ±2 lines), and
updates to `src/rooms/sma-map/entries.ts` proof strings for any symbol whose
file changed (they cite paths, e.g. `src/rooms/phase/server/driver.ts#…` — a
moved function needs its entry repointed, and the function name must be kept
or the entry rewritten). `PROJECT.md`'s `sources:` front matter lists several
of these files by name — update when files are renamed, not just split.

## Verification per split

- `npx tsc --noEmit` — primary gate (import completeness).
- `npx vitest run` on the room's test files + `tests/architecture/` +
  `tests/atlas.test.ts` + the SMA entries test.
- Manual smoke for daemons (self-repair, docs-nightly, wall): the risk is a
  silently dropped event, not a crash — check one tick end to end.
