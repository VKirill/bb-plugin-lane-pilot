#!/usr/bin/env python3
"""Writes docs/self-improvement-settings.md with file:line citations computed from the sources (tests/improvement/docs.test.ts checks them again)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def at(path: str, needle: str) -> str:
    for number, text in enumerate((ROOT / path).read_text().split("\n"), start=1):
        if needle in text:
            return f"`{path}:{number}`"
    raise SystemExit(f"{path}: no line with {needle!r}")


def cite(path: str, needle: str) -> str:
    """A citation cell: the location and the identifier that must sit within two lines of it."""
    return f"{at(path, needle)} | `{needle}`"


rows_wall = [
    ("wall.enabled", "enabled: boolean"), ("wall.max_classes_per_night", "maxClassesPerNight: number"), ("wall.rounds_per_night", "roundsPerNight: number"),
    ("wall.recurrence_floor", "recurrenceFloor: number"), ("wall.walks", "walks: number"), ("wall.hunters", "hunters: number"),
    ("wall.hunter_provider", "hunterProviderId: string"), ("wall.hunter_model", "hunterModel: string"), ("wall.hunter_reasoning_effort", "hunterReasoningLevel: string"),
    ("wall.night_token_cap", "nightTokenCap: number"), ("wall.hunt_share_percent", "huntShare: number"), ("wall.assumed_repair_tokens", "assumedRepairTokens: number"),
    ("wall.bench_subset", "benchSubset: number"), ("wall.rerun_sandbox_only", "rerunSandboxOnly: boolean"),
]

doc = f"""---
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

The screen is a system page next to «Waiting for you» ({at("src/rooms/ui-shell/ui/project-nav.tsx", 'scope: "improvement"')}), mounted by the page shell ({at("src/rooms/ui-shell/ui/page.tsx", "<ImprovementScreen")}). It reads once with `improvement_view` ({at("src/rooms/improvement/server/rpc.ts", "improvement_view: async")}) and saves each field with `save_setting` on project id `*` ({at("src/rooms/improvement/ui/use-improvement.ts", "GLOBAL_SETTINGS_PROJECT_ID, key, value")}).

Above the sections a status strip shows four numbers from the same read: the last and the next night (`03:00`, {at("src/rooms/improvement/server/rpc.ts", "export const NIGHT_HOUR")}), the size of the newest bench set, the policy exam progress (`N of 20` unseen owner decisions), and the count of what waits for the owner.

| Section | Controls | Read-only parts |
|---|---|---|
| Night loop (`Ночной цикл`) | `wall.*`: limits of a night, the hunt, the budget | a dry run of the night (`wall_night` with `dryRun`) |
| Bench set (`Эталонный набор`) | `bench.budget_tokens`, `bench.budget_hours`, `harness.adopt_by` | the newest set: tasks, candidates, date |
| Night policy (`Политика ночи`) | none, on purpose | version, freeze date, the exam, the lists and the standing prohibitions |
| Checks (`Проверки`) | `baseline.*`, `plan_fact.mode`, `critic.code.default_for_risk`, `regress.*` | the note that these are defaults for all projects |
| Waiting for the owner (`Ждут владельца`) | `owner_push.*` | deferral counts and how a term is set |
| Memory (`Память`) | `memory.note_budget` | the pointer to Knowledge, Memory |

The policy is read-only because it is the judge of the night: neither the night nor this page may change it. A deferral term is not a control for the same reason: it has to come from the owner's own message ({at("src/rooms/owner-waiting/items.ts", "needsOwnerMessage")}). Long jobs and decisions for the owner stay commands, listed under «Only by command»: `wall night`, `bench build|run|compare`, `policy-exam`, `coverage`, `rules mechanize`, `task-reverify|task-revert`.

## One mechanism, the old stores as the fallback

A control is a row of `lane_pilot_project_settings` under project `*` (the global level), with the version of `lane_pilot_setting_generation`, validated by `validateSettingValue` ({at("src/rooms/settings/setting-validation.ts", "HUB_KEYS.has(key)")}). The keys are listed once ({at("src/rooms/improvement/keys.ts", "export const HUB_SPECS")}) with the field of the old config object each stands for.

| Was | Now | Read | Written by |
|---|---|---|---|
| plugin key-value `wall:config` | `wall.*` | {at("src/rooms/wall/service.ts", "hubFields(db, \"wall\")")} | `wall config key=value`, the screen |
| plugin key-value `bench:config` | `bench.*` | {at("src/rooms/bench/service.ts", "hubFields(deps.db, \"bench\")")} | `bench config`, the screen |
| table `lane_pilot_owner_config` | `owner_push.*` | {at("src/rooms/owner-waiting/push.ts", "hubFields(db, \"owner_push\")")} | `waiting config`, `owner_waiting_config`, the screen |
| per-project `harness:config:<id>` | `harness.adopt_by` (the default of every project) | {at("src/rooms/harness/server/harness.ts", "hubFields(db, \"harness\")")} | `harness configure`, the screen |
| project settings, CLI only | `baseline.*`, `regress.*` in the catalog | {at("src/rooms/baseline/logic.ts", "parseBaselineSettings")} | the screen (default), the project's «Work» tab (own value) |

Rules: a field with a row reads the row; a field without one reads the old store, so nothing set before is lost; a write goes to the row only and leaves the old store alone ({at("src/rooms/wall/service.ts", "writeHubFields(db, \"wall\"")}); the CLI commands keep their syntax and their clamping (a value over the limit is stored as the limit). A write from the CLI moves the setting's version, so a page that read before sees the next save as a conflict and reloads ({at("src/rooms/improvement/hub.ts", "INSERT INTO lane_pilot_setting_generation")}). A project record of `harness.adopt_by` that was saved before keeps winning over the default.

## The controls

Every row is in the catalog (`scripts/ui-catalog-hand.json`, written by `scripts/improvement-rows.py`, generated into `packages/settings-catalog/src/ui-catalog.ts`), has an English and a Russian label and help that says the default, and the default is the one the code uses (`tests/improvement/hub.test.ts` compares them).

| Control | Reader field | Where the code holds it |
|---|---|---|
"""
for key, needle in rows_wall:
    doc += f"| `{key}` | {cite('src/rooms/wall/config.ts', needle)} |\n"
for key, path, needle in [
    ("bench.budget_tokens", "src/rooms/bench/runner.ts", "DEFAULT_BUDGET_TOKENS"), ("bench.budget_hours", "src/rooms/bench/runner.ts", "DEFAULT_BUDGET_HOURS"),
    ("harness.adopt_by", "src/rooms/harness/server/harness.ts", "adoptBy: AdoptBy"),
    ("owner_push.enabled", "src/rooms/owner-waiting/push.ts", "export type PushConfig"), ("owner_push.quiet", "src/rooms/owner-waiting/push.ts", "const QUIET"),
    ("owner_push.timezone", "src/rooms/owner-waiting/push.ts", "function validTimezone"),
    ("baseline.already_built", "src/rooms/baseline/logic.ts", "BaselineSettings"), ("baseline.time_cap_sec", "src/rooms/baseline/logic.ts", "timeCapSec: number"),
    ("regress.nightly", "src/rooms/baseline/logic.ts", "nightly: boolean"), ("regress.last_n", "src/rooms/baseline/logic.ts", "lastN: number"),
    ("regress.last_days", "src/rooms/baseline/logic.ts", "days: number"), ("regress.check_cap_sec", "src/rooms/baseline/logic.ts", "checkCapSec: number"),
    ("regress.budget_sec", "src/rooms/baseline/logic.ts", "budgetSec: number"), ("regress.bisect_steps", "src/rooms/baseline/logic.ts", "bisectSteps: number"),
    ("plan_fact.mode", "src/rooms/writer/server/plan-fact.ts", "PLAN_FACT_MODE_SETTING"), ("critic.code.default_for_risk", "src/rooms/critique/quality-mode.ts", "CODE_CRITIC_DEFAULT_SETTING"),
    ("memory.note_budget", "packages/memory-core/src/settings.ts", "noteBudget"),
]:
    doc += f"| `{key}` | {cite(path, needle)} |\n"

doc += f"""
Ranges are the readers' own: `{at("src/rooms/improvement/keys.ts", "const PROJECT_RANGES")}` repeats what `parseBaselineSettings` and `parseRegressSettings` clamp to, so a value the reader would silently change is refused when it is saved. `memory.note_budget` was saved unchecked and the memory reader threw on a value outside 1 to 1 000 000; it is now checked.

## Tidy-up of the existing settings

- The generator `scripts/generate-ui-catalog.py` had drifted from the checked-in catalog (four rows and three defaults edited by hand in the generated files). `scripts/ui-catalog-hand.json` now reproduces the checked-in catalog byte for byte, and every change below went through it. `LP_UI_CATALOG_PROJECT` and `LP_UI_CATALOG_UPSTREAM` point it at the main checkout when it runs from a linked worktree.
- Raw keys as labels (`plan_critique.agent`, `night_review.agent`, `specialist.agent`, `memory.agent`, `docs.agent`, `onboarding.agent`) now read «Роль агента …». «Раздел памяти» is «Память одного бота», «Порог N строк выдержек» is «Минимум строк для сжатия выдержек», «Провайдер окружения для worktree» is «Откуда берётся рабочая копия»; the code critic by risk is «Критика кода по риску» like its group; the workflow rows say «воркфлоу», not «цепочки», like the tab; the Insights presets carry the stage names.
- The extra rows of «Work» had one heading «Run operations» for unrelated things. They are now «Лимиты запуска» (`run.max_*`), «Интеграционные ворота» (`integration.gate_*`), «Служебные файлы проекта» (`bookkeeping.paths`) and «Jev» (`jev.*`).
- In the service tab the flags of the old command-line runner (run operations, install folders) sit in one fold, «Только для CLI-прогонов Lane Stack» ({at("src/rooms/runs/ui/runs-service.tsx", "cli-only-settings")}).
- An empty number is shown empty: «Попыток на запуск» with no limit showed `0`, which reads as zero attempts ({at("src/rooms/settings/ui/setting-controls.tsx", "An empty value")}).
- Long enum labels that cut off in a select («Выключено (только если ревью кода включено или качество full)») are short.
- The baseline and re-check settings, which could be set only by a hand-written `save_setting`, are in the catalog, on the Self-improvement page and in the project's «Work» tab.

Found, not changed: `ops.max_tasks` («Задач в сессии») is read only by the command-line flags of the old runner ({at("src/rooms/core/server/core.ts", '"ops.max_tasks": stored')}), so native writers never see it; its label now says so. `ui.language` is a stored row that the runtime excludes ({at("src/rooms/core/server/core.ts", 'if (key === "ui.language") return false;')}) and the language switch of the Overview does the work: the row looks orphaned. The owner push has a second editor on the «Waiting for you» board; it writes through the same RPC, so the two cannot disagree.
"""
(ROOT / "docs/self-improvement-settings.md").write_text(doc)
