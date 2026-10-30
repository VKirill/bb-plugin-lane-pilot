---
title: Самопроверка SMA (20 вопросов), batch3
type: audit
date: 2026-10-30
---

# Самопроверка графа работы Lane Pilot — один прогон, batch3

Проведено один раз по решению координатора (audits direction S7 → решение в `audits-status-batch3.md`).
Скрипт: `awg-assess.mjs` (matveymaslov/agent-work-graphs, копия в `.bb/chats/thr_r6uvh9j2iy/artifacts/evidence/`).

**Счёт: 20/20. Уровень 5** (перепрогон `awg-assess.mjs --answers yyyyyyyyyyyyyyyyyyyy`, 2026-10-30, `swe/wave13`).

Ответы по коду (`swe/wave13` на 0.1.391; строки, закрытые волнами 1–6 и пачкой 13, с тестом-доказательством):

| # | Ответ | Основание |
|---|---|---|
| 1–2 | y | контракт задачи + `contract-lint`, приёмка независимым `acceptance-receipt` |
| 3 | y | один экран приёмки: `AcceptanceCard` (`src/rooms/acceptance/ui/acceptance-card.tsx`, слот в `runs/ui/task-board.tsx`) — договор, план→факт с доказательствами по пунктам, квитанции стадий с видом доказательства (code/advisory), гейты, «не прогонялось» отдельным блоком, риск, база, расход. Тест: `tests/acceptance-card-ui.test.tsx` (5) |
| 4–7 | y | stage-квитанции с командами; worktree на попытку; `dirt_before` в журнале; откат удалением worktree/бэкапа live-folder |
| 8–9 | y | писатель не имеет ключа приёмки; ослабление проверок ловит `testFitFindings` + contract-lint |
| 10 | y | статусы выводятся из `lane_pilot_attempt_transition` |
| 11 | y | `checks.require_red_on_base` — проверка обязана быть красной на базе |
| 12 | y | `pipeline-proof`, реестр `coverage` связывают стадии/гейты/комнаты |
| 13 | y | stateful-двойник SDK `tests/fixtures/sdk-double.ts` (threads/environments/storage.kv): ответы сверяются с записанными реальными формами (`tests/fixtures/real-shapes/`, `record-real-shapes.ts` теперь пишет и `environments.get`); двойник не может выдать ключ, которого нет у реального ответа (`tests/sdk-double.test.ts`); реальный путь комнат идёт на нём (`tests/claude-guard-dispatch.test.ts` — owner-presence через mountNativeWiring) |
| 14 | y | `needs_human`/writer-question ≠ accepted (`question-timeout.ts`) |
| 15 | y | «не измерено» ≠ 0 везде: `costState` measured/partial/not_measured (`usage/server/attempt-metrics.ts`), UI — `graphNotMeasured`/`graphPartial` (`work-graph/ui`), `schRunCostUnknown`, `acc_cost_not_measured`, `tokenUsageNoData` для провайдеров без данных; CLI `bb lane-pilot metrics` печатает «not measured». Тесты: `attempt-metrics.test.ts`, `token-usage.test.ts`, `work-graph-ui.test.tsx`, `acceptance-card-ui.test.tsx` |
| 16 | y | `runs-halt`/`runs-pause`/reconcile-resume переживают перезапуск |
| 17 | y | стена, owner-инбокс, relay |
| 18 | y | регистр deferrals: skip требует `// deferral:<id>` с открытой записью |
| 19 | y | regression-seeds, test-fit, lint-правила от реальных поломок |
| 20 | y | сквозной сценарий задача→писатель→проверки→приёмка в песочнице — `scripts/lp-drill.sh` (parallel3/flow_contract: квитанции стадий writer-agent+verification+acceptance-receipt), квитанция в `.agents/runs/drills/<дата>.json`; учение после выката её требует: `decideAcceptance` не принимает ремонт без drill-квитанции выкатанной версии (`wall/acceptance.ts`, тесты `tests/wall/evidence.test.ts`, `tests/wall/pack-acceptance.test.ts`), `coverage --receipt` сверяет живые заявления с квитанцией (`tests/lp-drill-*.test.ts`) |

Молчаливые места: нет — все четыре пункта аудита закрыты кодом и тестами.
