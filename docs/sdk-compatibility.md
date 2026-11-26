---
title: "Совместимость Lane Pilot с BB: штатное ядро, VK-сборка, заявленный минимум"
type: reference
status: active
---

# Матрица совместимости SDK BB

Источники: `vk-requires.json` (2 обязательных, 14 необязательных VK-возможностей), `package.json` engines
(`bb >=0.43.3`, `bbPluginSdk >=0.4.104`; разработка — SDK `^0.6.104`), SDK-аудит 2026-11-15
(`.bb/chats/thr_vwps3g2am5/artifacts/sdk-audit-source-20261115.md`).

**Честная рамка.** «Проверено» ниже значит: код читает реальный SDK-контракт и есть регрессия на
фейковом хосте. Это не доказательство на старом runtime — старые BB не поднимались (аудит, пакет 4).
Декларируемый минимум `0.43.3`/`0.4.104` — граница, ниже которой гарантируется только то, что
feature-detection не даёт упасть; полный функционал на нём не проверен.

## Штатный BB (текущий SDK 0.6.x)

| Возможность | Статус | Где |
| --- | --- | --- |
| `experimental_useRpcQuery` + теги + `experimental_invalidate` | Работает: реальные input-схемы всех 10 методов из `ui-query-schemas.ts`, теги на каждом; инвалидация на attempt-сменах (storage-хук), событиях тредов, шагах workflow и owner- RPC-мутациях; modern-путь держит лишь медленный safety-poll (¼ cadence, ≥60с), legacy — прежний pollMs | `ui-query-contract.ts`, `platform/server/services/realtime.ts`, `workflow/server/services/workflow.ts` |
| `experimental_threadInfoSection` | Работает: штатный Info-слот вместо VK-алиаса, группа `1_related`; VK-слот и tab — fallback постарше | `app.tsx` |
| `threads.experimental_listPluginMetadata` (≤200 ID) | Реализовано, проверка текущего пакета ожидается: обычные метаданные helpers пакетно; per-ID fallback в списке помощников на старом SDK. Зарезервированные policy-метаданные этим API недоступны | `runs/server/handlers/runs-rpc.ts` |
| `projects.list` + `threads.experimental_listPluginMetadata` | Работает для daily-отчёта; упавшая секция пишется в отчёт, не молчание | `reports/server/services/daily-report.ts` |
| `experimental_onWorkerExit` + `host-jobs.reconcile` | Работает: проба сохранённых jobId read-only; `lost` хранит запись и jobId, тот же вызов отклонён (resubmit только detect/coexistenceInventory) | `core/server/core.ts` |
| `experimental_environment.removed` | Работает: попытки, привязанные к удалённой среде, проходят resumeOrphans сразу; sweep — fallback | `core/server/lifecycle-events.ts`, `server.ts` |
| `experimental_claimPath` (provider adopt) | Работает: adopt-путь worktree провайдера клеймится до принятия; конфликт → failed create; старый контекст без метода — прежний путь | `native-agent/server/services/` |
| `experimental_thread.events` + `threads.events.list` | Работает: feed с курсором, first-contact по bootAt, sweep 60с | `stability/server/services/thread-event-feed.ts` |

## BB + VK (0.48.1-vk.6, хаб)

Всё из таблицы выше плюс VK-possibilities. Обязательные по `vk-requires.json`:
`experimental_vkSetDispatchData`, `experimental_vkPluginLifecycle` — без них плагин не
поддерживается. Необязательные (quiet child, spawn keyed/find, session policy, vk schedule,
lifecycle, hook timeout, plugin metadata, lastTurn, launchTuning) — каждый feature-tested;
без них соответствующая ветвь деградирует или выключается с записью в лог, молчаливого
падения нет (`thread-keys.ts`, `helper-context.ts`, `hook-timeouts.ts`).

VK-семантика, которую сток не повторяет и которую мы НЕ притворяемся покрытой:
quiet-children (`parentNotifications:"stuck"` пропускает ошибки), идемпотентный spawn по
ключу, обязательная session-policy профилей, dispatch data/lifecycle хуки, изолированное
расписание с timeout/overlap. Это остаётся VK-зависимостью по `vk-requires.json`.

## Заявленный минимум (`bb >=0.43.3`, SDK `>=0.4.104`)

- Гарантировано только: плагин загружается, feature-detection ветви не падают, базовые
  threads/storage/RPC работают.
- НЕ проверено на runtime: весь пакет experimental_* (queries, tags, invalidate, info-секции,
  metadata batch, worker-exit, environment.removed, claimPath, events feed). На таком BB
  эти ветви молча выключаются — UI возвращается на poll, watches на старые/нет событий,
  окружения на старый путь.
- Вывод аудита: минимум стоит пересмотреть только после проверки на реальном старом BB;
  версии SDK не поднимались ради этого.

## Что осталось от core DB

Ничего в runtime: `bb.db` не открывается ни в процессе плагина, ни дочерним процессом.
Profile-check перечисляет помощников через `threads.list` и читает обычные LP-метаданные через `experimental_listPluginMetadata`. Сохранённая required-session-policy читается через опциональный `threads.experimental_vkInspectRequiredSessionPolicies` (VK core P2, чанки ≤200, строгая проверка формы v1: точный набор id, без дублей и пропусков; `valid` → сохранённый snapshot, `absent` → подтверждённое отсутствие → red `noPolicy`, `invalid`/`unavailable`/ошибка/отсутствие метода → день «не проверено»). Это stored snapshot, не доказательство enforcement провайдером; `plugin:skill`-алиасы не разворачиваются (informational в `coverageNote`). На хосте без метода день с counted-релями остаётся «не проверено» — метод есть только в core-сборке с P2 (`experimental_vkInspectRequiredSessionPolicies`), сборки core до него его не имеют. Daily-отчёт собирает метрики по базе плагина и SDK (`reports/server/services/daily-report.ts`); упавшая секция снимка названа в отчёте.

Граница охвата SDK-чтений (честно, без silent green): `threads.list` включает archived и
hidden треды (archived не передаётся — умолчание маршрута покрывает обе группы), но ВСЕГДА
исключает удалённые. Профиль-проверка и снимок отчёта поэтому не видят помощников, удалённых
внутри окна: profile-check пишет это в `coverageNote` отчёта, снимок — в `degraded` строку
отчёта при обнаружении. Отбор намеренно без `originPluginId`: старый SQL ключевался на
`thread_plugin_metadata.plugin_id`, а не на плагине-источнике, поэтому тред чужого origin с
метаданными Lane Pilot остаётся в окне. Порядок `threads.list` — project/pinned/createdAt
desc, не глобальный createdAt: раннего выхода по дате нет, страница за страницей до короткой
или до cap (cap → unverified/degraded, не частичный green). Невалидный не-массив ответ
`threads.list`/`experimental_listPluginMetadata` — ошибка чтения, не пустой успех.
