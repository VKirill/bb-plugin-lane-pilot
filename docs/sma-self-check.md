---
title: Самопроверка SMA (20 вопросов), batch3
type: audit
date: 2026-10-30
---

# Самопроверка графа работы Lane Pilot — один прогон, batch3

Проведено один раз по решению координатора (audits direction S7 → решение в `audits-status-batch3.md`).
Скрипт: `awg-assess.mjs` (matveymaslov/agent-work-graphs, копия в `.bb/chats/thr_r6uvh9j2iy/artifacts/evidence/`).

**Счёт: 16/20. Уровень 1.**

Ответы по коду batch3 (`swe/wave6`, файл-строка при отрицании):

| # | Ответ | Основание |
|---|---|---|
| 1–2 | y | контракт задачи + `contract-lint`, приёмка независимым `acceptance-receipt` |
| 3 | n | договор, квитанции и риски разнесены: нет одного экрана приёмки (`ui-shell` карточка задачи показывает части) |
| 4–7 | y | stage-квитанции с командами; worktree на попытку; `dirt_before` в журнале; откат удалением worktree/бэкапа live-folder |
| 8–9 | y | писатель не имеет ключа приёмки; ослабление проверок ловит `testFitFindings` + contract-lint |
| 10 | y | статусы выводятся из `lane_pilot_attempt_transition` |
| 11 | y | `checks.require_red_on_base` — проверка обязана быть красной на базе |
| 12 | y | `pipeline-proof`, реестр `coverage` связывают стадии/гейты/комнаты |
| 13 | n | тестовый рантайм SDK дублирует боевой объект; расхождение уже кусалось (`pluginSdkApp` подмена в старых тестах) |
| 14 | y | `needs_human`/writer-question ≠ accepted (`question-timeout.ts`) |
| 15 | n | неизмеренный расход местами читается как 0 (`costUsd` null-ветки без «не измерено» в отчётах) |
| 16 | y | `runs-halt`/`runs-pause`/reconcile-resume переживают перезапуск |
| 17 | y | стена, owner-инбокс, relay |
| 18 | y | регистр deferrals: skip требует `// deferral:<id>` с открытой записью |
| 19 | y | regression-seeds, test-fit, lint-правила от реальных поломок |
| 20 | n | живой end-to-end дрилл пачки ещё не прогонялся (назначен координатору после выката) |

Молчаливые места (по скрипту): экран приёмки (3), двойник богаче настоящего SDK (13), «не измерено» вместо 0 (15), живой прогон (20).
