---
title: The Self-improvement page and its settings
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [settings, sma, night-loop, bench, policy, owner-waiting, ui]
sources:
  - src/rooms/improvement/keys.ts
  - src/rooms/improvement/hub.ts
  - src/rooms/improvement/server/rpc.ts
  - src/rooms/improvement/ui/improvement-page.tsx
  - src/rooms/improvement/ui/use-improvement.ts
  - src/rooms/wall/service.ts
  - src/rooms/bench/service.ts
  - src/rooms/owner-waiting/push.ts
  - src/rooms/harness/server/harness.ts
  - src/rooms/settings/setting-validation.ts
  - scripts/improvement-rows.py
  - tests/improvement/hub.test.ts
  - tests/improvement/improvement-ui.test.tsx
  - tests/improvement/tidy.test.ts
---

# The Self-improvement page and its settings

TL;DR: every control of the loop that learns from failures (the night loop, the bench set, the night policy, the checks around a task, the push about what waits for the owner, the note memory budget) is one screen, **System → Self-improvement** (`Самоулучшение`), and every control writes through one mechanism: `save_setting` on the global level with the setting's version. Until 0.1.270 these were four different stores and half of them were CLI-only.

## Where it is

The screen is a system page next to «Waiting for you» (`src/rooms/ui-shell/ui/project-nav.tsx:17`), mounted by the page shell (`src/rooms/ui-shell/ui/page.tsx:59`). It reads once with `improvement_view` (`src/rooms/improvement/server/rpc.ts:43`) and saves each field with `save_setting` on project id `*` (`src/rooms/improvement/ui/use-improvement.ts:78`).

Above the sections a status strip shows four numbers from the same read: the last and the next night (`03:00`, `src/rooms/improvement/server/rpc.ts:19`), the size of the newest bench set, the policy exam progress (`N of 20` unseen owner decisions), and the count of what waits for the owner.

| Section | Controls | Read-only parts |
|---|---|---|
| Night loop (`Ночной цикл`) | `wall.*`: limits of a night, the hunt, the budget | a dry run of the night (`wall_night` with `dryRun`) |
| Bench set (`Эталонный набор`) | `bench.budget_tokens`, `bench.budget_hours`, `harness.adopt_by` | the newest set: tasks, candidates, date |
| Night policy (`Политика ночи`) | none, on purpose | version, freeze date, the exam, the lists and the standing prohibitions |
| Checks (`Проверки`) | `baseline.*`, `checks.require_red_on_base`, `plan_fact.mode`, `critic.code.default_for_risk`, `regress.*` | the note that these are defaults for all projects |
| Waiting for the owner (`Ждут владельца`) | `owner_push.*` | deferral counts and how a term is set |
| Memory (`Память`) | `memory.note_budget` | the pointer to Knowledge, Memory |

The policy is read-only because it is the judge of the night: neither the night nor this page may change it. A deferral term is not a control for the same reason: it has to come from the owner's own message (`src/rooms/owner-waiting/items.ts:24`). Long jobs and decisions for the owner stay commands, listed under «Only by command»: `wall night`, `bench build|run|compare`, `policy-exam`, `coverage`, `rules mechanize`, `task-reverify|task-revert`.

## One mechanism, the old stores as the fallback

A control is a row of `lane_pilot_project_settings` under project `*` (the global level), with the version of `lane_pilot_setting_generation`, validated by `validateSettingValue` (`src/rooms/settings/setting-validation.ts:38`). The keys are listed once (`src/rooms/improvement/keys.ts:28`) with the field of the old config object each stands for.

| Was | Now | Read | Written by |
|---|---|---|---|
| plugin key-value `wall:config` | `wall.*` | `src/rooms/wall/service.ts:121` | `wall config key=value`, the screen |
| plugin key-value `bench:config` | `bench.*` | `src/rooms/bench/service.ts:37` | `bench config`, the screen |
| table `lane_pilot_owner_config` | `owner_push.*` | `src/rooms/owner-waiting/push.ts:38` | `waiting config`, `owner_waiting_config`, the screen |
| per-project `harness:config:<id>` | `harness.adopt_by` (the default of every project) | `src/rooms/harness/server/harness.ts:185` | `harness configure`, the screen |
| project settings, CLI only | `baseline.*`, `checks.require_red_on_base`, `regress.*` in the catalog | `src/rooms/baseline/logic.ts:35` | the screen (default), the project's «Work» tab (own value) |

Rules: a field with a row reads the row; a field without one reads the old store, so nothing set before is lost; a write goes to the row only and leaves the old store alone (`src/rooms/wall/service.ts:126`); the CLI commands keep their syntax and their clamping (a value over the limit is stored as the limit). A write from the CLI moves the setting's version, so a page that read before sees the next save as a conflict and reloads (`src/rooms/improvement/hub.ts:72`). A project record of `harness.adopt_by` that was saved before keeps winning over the default.

## The controls

Every row is in the catalog (`scripts/ui-catalog-hand.json`, written by `scripts/improvement-rows.py`, generated into `packages/settings-catalog/src/ui-catalog.ts`), has an English and a Russian label and help that says the default, and the default is the one the code uses (`tests/improvement/hub.test.ts` compares them).

| Control | Reader field | Where the code holds it |
|---|---|---|
| `wall.enabled` | `src/rooms/wall/config.ts:3` | `enabled: boolean` |
| `wall.max_classes_per_night` | `src/rooms/wall/config.ts:5` | `maxClassesPerNight: number` |
| `wall.rounds_per_night` | `src/rooms/wall/config.ts:7` | `roundsPerNight: number` |
| `wall.recurrence_floor` | `src/rooms/wall/config.ts:27` | `recurrenceFloor: number` |
| `wall.walks` | `src/rooms/wall/config.ts:9` | `walks: number` |
| `wall.hunters` | `src/rooms/wall/config.ts:11` | `hunters: number` |
| `wall.hunter_provider` | `src/rooms/wall/config.ts:19` | `hunterProviderId: string` |
| `wall.hunter_model` | `src/rooms/wall/config.ts:20` | `hunterModel: string` |
| `wall.hunter_reasoning_effort` | `src/rooms/wall/config.ts:21` | `hunterReasoningLevel: string` |
| `wall.night_token_cap` | `src/rooms/wall/config.ts:13` | `nightTokenCap: number` |
| `wall.hunt_share_percent` | `src/rooms/wall/config.ts:15` | `huntShare: number` |
| `wall.assumed_repair_tokens` | `src/rooms/wall/config.ts:17` | `assumedRepairTokens: number` |
| `wall.bench_subset` | `src/rooms/wall/config.ts:23` | `benchSubset: number` |
| `wall.rerun_sandbox_only` | `src/rooms/wall/config.ts:25` | `rerunSandboxOnly: boolean` |
| `bench.budget_tokens` | `src/rooms/bench/runner.ts:50` | `DEFAULT_BUDGET_TOKENS` |
| `bench.budget_hours` | `src/rooms/bench/runner.ts:51` | `DEFAULT_BUDGET_HOURS` |
| `harness.adopt_by` | `src/rooms/harness/server/harness.ts:53` | `adoptBy: AdoptBy` |
| `owner_push.enabled` | `src/rooms/owner-waiting/push.ts:17` | `export type PushConfig` |
| `owner_push.quiet` | `src/rooms/owner-waiting/push.ts:23` | `const QUIET` |
| `owner_push.timezone` | `src/rooms/owner-waiting/push.ts:25` | `function validTimezone` |
| `checks.require_red_on_base` | `src/rooms/baseline/logic.ts:20` | `requireRed` |
| `baseline.already_built` | `src/rooms/baseline/logic.ts:14` | `BaselineSettings` |
| `baseline.time_cap_sec` | `src/rooms/baseline/logic.ts:18` | `timeCapSec: number` |
| `regress.nightly` | `src/rooms/baseline/logic.ts:184` | `nightly: boolean` |
| `regress.last_n` | `src/rooms/baseline/logic.ts:186` | `lastN: number` |
| `regress.last_days` | `src/rooms/baseline/logic.ts:187` | `days: number` |
| `regress.check_cap_sec` | `src/rooms/baseline/logic.ts:189` | `checkCapSec: number` |
| `regress.budget_sec` | `src/rooms/baseline/logic.ts:191` | `budgetSec: number` |
| `regress.bisect_steps` | `src/rooms/baseline/logic.ts:193` | `bisectSteps: number` |
| `plan_fact.mode` | `src/rooms/writer/server/plan-fact.ts:11` | `PLAN_FACT_MODE_SETTING` |
| `critic.code.default_for_risk` | `src/rooms/critique/quality-mode.ts:49` | `CODE_CRITIC_DEFAULT_SETTING` |
| `memory.note_budget` | `packages/memory-core/src/settings.ts:7` | `noteBudget` |

Ranges are the readers' own: ``src/rooms/improvement/keys.ts:61`` repeats what `parseBaselineSettings` and `parseRegressSettings` clamp to, so a value the reader would silently change is refused when it is saved. `memory.note_budget` was saved unchecked and the memory reader threw on a value outside 1 to 1 000 000; it is now checked.

## Tidy-up of the existing settings

- The generator `scripts/generate-ui-catalog.py` had drifted from the checked-in catalog (four rows and three defaults edited by hand in the generated files). `scripts/ui-catalog-hand.json` now reproduces the checked-in catalog byte for byte, and every change below went through it. `LP_UI_CATALOG_PROJECT` and `LP_UI_CATALOG_UPSTREAM` point it at the main checkout when it runs from a linked worktree.
- Raw keys as labels (`plan_critique.agent`, `night_review.agent`, `specialist.agent`, `memory.agent`, `docs.agent`, `onboarding.agent`) now read «Роль агента …». «Раздел памяти» is «Память одного бота», «Порог N строк выдержек» is «Минимум строк для сжатия выдержек», «Провайдер окружения для worktree» is «Откуда берётся рабочая копия»; the code critic by risk is «Критика кода по риску» like its group; the workflow rows say «граф», not «воркфлоу» or «цепочка», like the tab; the Insights presets carry the stage names.
- The extra rows of «Work» had one heading «Run operations» for unrelated things. They are now «Лимиты запуска» (`run.max_*`), «Интеграционные ворота» (`integration.gate_*`), «Служебные файлы проекта» (`bookkeeping.paths`) and «Jev» (`jev.*`).
- In the service tab the flags of the old command-line runner (run operations, install folders) sit in one fold, «Только для CLI-прогонов Lane Stack» (`src/rooms/runs/ui/runs-service.tsx:193`).
- An empty number is shown empty: «Попыток на запуск» with no limit showed `0`, which reads as zero attempts (`src/rooms/settings/ui/setting-controls.tsx:126`).
- Long enum labels that cut off in a select («Выключено (только если ревью кода включено или качество full)») are short.
- The baseline and re-check settings, which could be set only by a hand-written `save_setting`, are in the catalog, on the Self-improvement page and in the project's «Work» tab.

Found, not changed: `ops.max_tasks` («Задач в сессии») is read only by the command-line flags of the old runner (`src/rooms/core/server/core.ts:297`), so native writers never see it; its label now says so. `ui.language` is a stored row that the runtime excludes (`src/rooms/core/server/core.ts:276`) and the language switch of the Overview does the work: the row looks orphaned. The owner push has a second editor on the «Waiting for you» board; it writes through the same RPC, so the two cannot disagree.
