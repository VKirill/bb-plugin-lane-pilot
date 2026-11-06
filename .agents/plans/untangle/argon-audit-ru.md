---
title: "Аудит запутанности кодовой базы bb-plugin-lane-pilot (Untangle Codebase)"
status: completed
author: Antigravity
date: 2026-11-06
version: "1.0"
tags: [audit, architecture, untangle-codebase, lane-pilot, refactoring]
---

# Аудит запутанности кодовой базы `bb-plugin-lane-pilot`

> [!IMPORTANT]
> **Главный вывод аудита:** Кодовая база находится в состоянии **высокой структурной связности («распределённый монолит внутри одного процесса»)**. Предыдущий механический рефакторинг на «комнаты» (`src/rooms/*`) убрал файловые циклы, но оставил **60 из 69 комнат (`87%`) в одной гигантской сильно связной компоненте (SCC)** и **40+ комнат**, пишущих и читающих сырой SQL напрямую в чужие таблицы.

---

## 1. Паспорт масштаба и метрики запутанности

| Метрика | Значение | Диагноз |
| :--- | :--- | :--- |
| **Всего TS/TSX файлов** | **2 278 файлов** (`304 573 LOC`) | Крупный монорепозиторий плагина |
| **Production-код** | **1 286 файлов** (`182 498 LOC`) | `src/rooms/` (`144 330 LOC`), `packages/*` (`36 692 LOC`), entrypoints (`1 476 LOC`) |
| **Тестовый код** | **1 003 файла** (`122 075 LOC`) | Соотношение тесты/код `0.67:1`, **424** `.skip`/`.todo` |
| **Комнаты в `src/rooms/`** | **69 комнат** (`1 008 файлов`) | Сильная фрагментация: **25+ микро-комнат** по 25–200 LOC |
| **Циклы на уровне файлов** | **0** (контролируется [boundaries.test.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/tests/architecture/boundaries.test.ts#L1-L263)) | Иллюзия чистоты: тест не видит циклы между комнатами |
| **Циклы на уровне комнат (SCC)** | **60 из 69 комнат в 1 SCC** + **98 взаимных пар** (`A ↔ B`) | Почти любая комната транзитивно тянет всю систему |
| **Глубокие импорты в обход barrel** | **56 в 41 паре комнат** ([deep-imports.json](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/tests/architecture/deep-imports.json#L1-L130)) | Замороженный технический долг |
| **Автосгенерированные barrel-файлы** | **143 файла `index.ts`** ([barrels.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/scripts/refactor/barrels.ts#L1-L157)) | Слепок старых хаотичных связей, а не продуманный API |
| **Сырые SQL-запросы (`db.prepare`)** | **1 000+ запросов в 40+ комнатах** | Отсутствует владение данными (Data Ownership) |
| **Глобальные KV-вызовы (`kv.*`)** | **315 вызовов в 41 комнате** | Нетипизированные строковые ключи и префиксы |
| **Проглоченные ошибки в prod** | **1 006 мест** (`191` пустых `catch {}` + `815` `.catch(() => ...)`) | Скрытые сбои, маскирующие гонки инициализации и БД |
| **История Git (последние 199 коммитов)** | **52.8% коммитов** меняют `≥ 2` комнат (в среднем **2.82 комнаты/коммит**) | Высокая ко-изменяемость (Shotgun Surgery) |

### Почему «комнатная» архитектура не развязала код?

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Иллюзия файлового графа (tests/architecture/boundaries.test.ts): 0 циклов  │
│                                                                            │
│   room A / server / index.ts ──────► room B / index.ts                     │
│   room B / server / foo.ts   ──────► room A / index.ts                     │
│                                                                            │
│ На уровне файлов цикла нет (разные index.ts), но на уровне модулей:        │
│   Room A ◄═════════════════════════► Room B  (60 из 69 комнат в одном SCC) │
└────────────────────────────────────────────────────────────────────────────┘
```

Скрипты [rooms.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/scripts/refactor/rooms.ts#L1-L163) и [barrels.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/scripts/refactor/barrels.ts#L1-L157) механически разложили плоскую папку `src/` по 69 директориям и сгенерировали `index.ts` по факту существовавших импортов (`// scripts/refactor/barrels.ts wrote the first version from the existing imports`). Даже если удалить из графа 6 главных хабов (`core`, `storage`, `writer`, `workflow`, `native-agent`, `runs`), **37 остальных комнат всё равно остаются сцепленными в единый цикл**.

---

## 2. План распутывания с первых принципов и найденные проблемы

Ниже проблемы сгруппированы по 6 архитектурным кластерам. В каждом кластере сначала описан **целевой редизайн с первых принципов**, а под ним — конкретные проблемы из 4 категорий (`Hidden links`, `Needless links`, `Surplus`, `Special cases`), которые этот редизайн устраняет.

---

### Кластер A: Слой хранения, миграции и владение таблицами (`storage` + SQL/KV)

#### Целевой дизайн (First-Principles Redesign)
1. **Тонкое ядро БД вместо God-модуля:** [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1-L2036) превращается в чистый инфраструктурный драйвер SQLite (`SqliteConnection` + реестр миграций `registerMigration(domain, sql)`), не импортирующий ни одной доменной комнаты.
2. **Строгое владение таблицами (1 таблица = 1 доменный репозиторий):**
   - Таблицами `lane_pilot_run`, `lane_pilot_attempt`, `lane_pilot_stage_receipt` владеет только домен `execution` (`runs` + `tasks`).
   - Таблицей `lane_pilot_task` владеет только `tasks`.
   - Таблицей `lane_pilot_project_settings` владеет только `settings`.
   - Кросс-доменная аналитика (`wall`, `bench`, `baseline`, `sma-map`, `lead`) читает данные через типизированные read-view/репозитории, а не через сырой `db.prepare` с `json_extract`.
3. **Структурированные колонки вместо парсинга строк ошибок:** Статусы, коды возврата и таймауты проверок хранятся в явных полях (`failure_code`, `check_name`, `timeout_sec`), а не извлекаются регулярками из человекочитаемого `attempt.reason`.
4. **Типизированный `KvNamespace`:** Вместо глобальных строковых префиксов (`host-job:`, `native-selection:`, `lp.design.journal`) каждая комната получает свой namespaced-адаптер с Zod-схемой.

#### Что этот редизайн устраняет:

- **[Needless link] God-файл [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1-L2036) (`2 036 LOC`, fan-in = 52 комнаты, fan-out = 34 комнаты/пакета):**
  - В строках [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1-L43) модуль хранения импортирует 29 доменных комнат и пакетов (`settings`, `writer`, `runs`, `tasks`, `verification`, `learning`, `phase`, `brief`, `money`, `permits`, `outage`, `backlog` и др.).
  - В [`transitionAttempt`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1357-L1384) слой БД напрямую вызывает бизнес-логику `@lane-pilot/memory-core` (`noteRefutedByCheck`, `recordMemoryAccepted`).
  - В [storage/index.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/index.ts#L1-L16) наружу реэкспортируются более 110 символов и сторы `@lane-pilot/workflow-engine`.
- **[Hidden link] Размытое владение SQLite-таблицами (1 000+ `db.prepare` в 40+ комнатах):**
  - `lane_pilot_run` читают/пишут **43 комнаты**, `lane_pilot_attempt` — **38 комнат**, `lane_pilot_task` — **27 комнат**, `lane_pilot_stage_receipt` — **21 комната**, `lane_pilot_wf_run` — **20 комнат**, `lane_pilot_project_settings` — **11 комнат**.
  - Примеры прямой протечки схемы: [finish.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/writer/server/finish.ts#L55-L60) делает `SELECT count(*) ... json_extract(t.contract_json, '$.area')` напрямую по `lane_pilot_attempt` + `lane_pilot_task`; [tools.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/tools/server/tools.ts#L118) выполняет прямой `UPDATE lane_pilot_task SET closed_words=?`.
- **[Hidden link + Special case] Бизнес-логика поверх SQL `instr`/`LIKE` и парсинга текста ошибок:**
  - В [`listCheckTimeouts`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1942-L1960) SQL-запрос ищет подстроку `instr(a.reason, '): verification timed out after ') > 0`, а затем парсит текст регуляркой `/verification failed \((.+?)\): verification timed out after (\d+)s/`. Любое изменение текста ошибки в `verification` молча сломает детектор таймаутов.
  - В [run-goal.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/run-goal/server/run-goal.ts#L1-L120) фильтрация в SQL завязана на `AND NOT (g.state = 'skipped' AND g.detail LIKE 'the check failed:%')`.
- **[Hidden link] Глобальные строковые ключи KV и угадывание владельца worktree по префиксу имени:**
  - `host-job:<id>` формируется в [jobs.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/jobs.ts#L16) и парсится через `key.split(":")[2]` в [lifecycle-events.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/lifecycle-events.ts#L101-L104).
  - `native-selection:` и `native-thread:` разделяются по строковому соглашению между [native-wiring.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/native-wiring.ts#L19-L80) и [native-dispatch.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-agent/native-dispatch.ts#L162-L221).
  - В [`ownerKindOfName`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L2014-L2023) и [core.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/core.ts#L137-L152) владелец git-worktree угадывается по префиксам имени ветки/папки (`docs-`, `self-repair-`, `regress-`, `bisect-`).
- **[Surplus] Мёртвый дубликат БД в пакете:** [packages/workflow-engine/src/db.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/packages/workflow-engine/src/db.ts#L1-L90) не импортируется ни одним файлом.

---

### Кластер B: Ядро инициализации, DI-контейнер и Host-контракты (`core`, `server.ts`, `host-worker`)

#### Целевой дизайн (First-Principles Redesign)
1. **Явный двухслойный контекст (`InfraContext` → `DomainServices`) без `{} as Services`:**
   - Слой 1 (`InfraContext`): `db`, `kv`, `host`, `clock`, `logger`, `eventBus`. Создаётся синхронно и неизменяемо.
   - Слой 2 (`DomainServices`): доменные фасады создаются в явном топологическом порядке без мутации пустого объекта и без передачи всего `Services` (135 полей) в каждую функцию.
2. **Декомпозиция `host-handlers.ts` и `contracts/host.ts` по доменным адаптерам:** Вместо единого свалочного контракта на 76 методов — отдельные модули `gitHost`, `fsHost`, `judgeHost`, `desktopHost`, `networkHost`.
3. **Отказ от `node -e` со строковым JS-скриптом:** Запуск фоновых host-задач через нормальный скомпилированный entrypoint-файл вместо инъекции JS-кода в `spawn(process.execPath, ["-e", RUNNER])`.

#### Что этот редизайн устраняет:

- **[Hidden link] Двухфазная мутация `const services = {} as Services` и скрытый порядок загрузки в [server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L92-L214):**
  - В [server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L92) создаётся пустой объект `const services = {} as Services`, который сразу передаётся по ссылке в 18 фабрик ([server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L94-L141)), пока его поля ещё `undefined`.
  - Поле `services.pmReplay` дописывается мутацией позже ([server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L154)), а `services.errands` (объявленное обязательным в [services.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/services.ts#L197)) остаётся `undefined` вплоть до вызова `registerTools(api, services)` на строке [server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L206) ([tools.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/tools/server/tools.ts#L325)).
  - `mountLearning` ([server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L186)) и `mountRegressionTools` ([server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L205)) обязаны вызываться строго до `registerTools` ([server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L206)), иначе [`mountToolFamilies`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/tools/server/tool-families.ts#L38-L41) упадёт в рантайме из-за отсутствия инструментов из списка `PM_TOOL_FAMILIES`.
- **[Needless link] God-интерфейс [services.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/services.ts#L69-L205) (135 плоских свойств, fan-out = 52 комнаты) и [rpc.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/rpc.ts#L1-L260) (fan-out = 38 комнат):**
  - В `Services` вынесены даже приватные константы отдельных комнат (`DOCS_NIGHT_ATTEMPTS`, `DOCS_OPEN_KEY` в [services.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/services.ts#L111-L116)).
  - В [rpc.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/rpc.ts#L92-L121) прямо в роутере зашита бизнес-логика `front`, `task_word`, `learning_decide` и `conveyor`.
- **[Needless link] Свалочный [host-handlers.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L1-L942) (`942 LOC`) и [contracts/host.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/contracts/host.ts#L1-L599) (76 RPC-методов):**
  - В одном файле смешаны git worktrees, HTTP-вызовы к TypeSafe/OpenLux ([`classifyPlan`, `councilJudge`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L768-L848)), запуск десктопного бинарника `jev-ultrafast` ([`browserGoal`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L911-L942)), сканирование сетевых интерфейсов WireGuard ([`vpnAddress`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L697-L706)) и regex-правка YAML в `.agents/todos` ([`closeBacklogItem`](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L451-L466)).
- **[Hidden link] Динамический запуск `node -e` со строкой кода в [jobs.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/jobs.ts#L57-L85):**
  - Многострочный JS-скрипт `RUNNER` зашит в шаблонную строку, делает динамический `import(pathToFileURL(job.hostEntry).href)` и ищет обработчик по `.default?.handlers?.[job.kind]`.

---

### Кластер C: Конвейер исполнения задач (`writer`, `runs`, `tasks`, `verification`, `critique`, `phase`)

#### Целевой дизайн (First-Principles Redesign)
1. **Единый конечный автомат попытки (Attempt State Machine):** Вместо размазывания переходов попытки по 10 комнатам и обмена строковыми префиксами в поле `reason`, вводится единый координатор `AttemptLifecycle` с типизированным union-типом состояния и результата верификации.
2. **Разделение оркестрации и шагов в `writer` и `phase`:**
   - [writer/server/start.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/writer/server/start.ts#L1-L1469) (`1 469 LOC`) и [writer/server/finish.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/writer/server/finish.ts#L1-L1161) (`1 161 LOC`) разбиваются на чистый пайплайн шагов (`PrepareWorktree` → `BuildPromptContext` → `SpawnWriterThread` → `VerifyAttempt` → `IntegrateOrRollback` → `EmitAttemptEvents`).
   - Побочные реакции (обучение, память, метрики, нотификации, закрытие слов задачи) отвязываются от `finish.ts` через доменные события `AttemptFinishedEvent`.
3. **Возврат чужих файлов из `verification` в их реальные домены:** Файлы документации (`docs-*`, `git-docs.ts`) переносятся в `docs`, а `stability-drill.ts` — в `stability`.

#### Что этот редизайн устраняет:

- **[Needless link] Четыре гигантских God-файла оркестрации:**
  - [writer/server/start.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/writer/server/start.ts#L1-L1469) (`1 469 LOC`, импортирует 22 комнаты/пакета).
  - [self-repair/server/self-repair.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/self-repair/server/self-repair.ts#L1-L1309) (`1 309 LOC`, импортирует 27 комнат).
  - [phase/server/driver.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/phase/server/driver.ts#L1-L1240) (`1 240 LOC`, импортирует 20 комнат).
  - [writer/server/finish.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/writer/server/finish.ts#L1-L1161) (`1 161 LOC`, импортирует 20+ комнат).
- **[Hidden link] Жизненный цикл одной попытки размазан по 10+ комнатам через строковые коды:**
  - `tasks`, `runs`, `writer`, `verification`, `critique`, `stability` ([reconcile.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/stability/server/reconcile.ts#L1-L320)), `stage-return`, `rollback`, `run-goal` и `pilot` общаются через строковые префиксы в `reason` (`WAITING_WRITER_PREFIX`, `verdict_block`, `REPLAY_CHECK_FAILED`, `thread_status_error:`).
- **[Needless link] Чужие файлы внутри `verification` из-за механического переноса в [scripts/refactor/rooms.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/scripts/refactor/rooms.ts#L19-L22):**
  - В комнате `verification` лежат файлы документации [docs-data.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/docs-data.ts), [docs-flows.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/docs-flows.ts), [docs-jev.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/docs-jev.ts), [docs-routes.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/docs-routes.ts), [git-docs.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/git-docs.ts) и файл стабильности [stability-drill.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/verification/stability-drill.ts).

---

### Кластер D: Консолидация 69 комнат в ~18–20 реальных доменов и реестр ролей/моделей

#### Целевой дизайн (First-Principles Redesign)
1. **Единый декларативный реестр ролей и провайдеров (`RoleSpec` + `ProviderCapabilities`):**
   - Все 9 ролей (`pm`, `writer`, `critic`, `reviewer`, `arbiter`, `reconciler`, `researcher`, `librarian`, `consolidator`) и возможности провайдеров описываются в одной таблице метаданных в `packages/models`.
   - RPC-хендлеры настроек, дефолты, миграции и UI-селекторы генерируются из этого реестра автоматически без копипасты.
2. **Укрупнение 25+ микро-комнат (25–200 LOC) в связные домены:**
   - Вместо 12 крошечных комнат вокруг правил и самокоррекции (`learning`, `self-repair`, `self-improve`, `rule-forms`, `wall`, `improvement`, `hypotheses`, `checkers`, `bench`, `baseline`, `deferral`, `pm-replay`) — 2 чётких модуля: `quality-gates` (правила, чекеры, `wall`, `jev`) и `self-improvement` (`learning`, `self-repair`, `bench`).
   - Микро-комнаты `stage-return`, `run-goal`, `pilot`, `conveyor`, `permits`, `receipts` объединяются внутрь домена `execution`.
   - Мёртвые/тестовые комнаты (`atlas`, `twins`, `guard-tools`) убираются из `src/rooms/`.

#### Что этот редизайн устраняет:

- **[Hidden link + Surplus] Копипаста списка ролей в 6+ местах и 9-кратный дубликат RPC в [selections.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/server/rpc/selections.ts#L59-L316):**
  - В [selections.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/server/rpc/selections.ts#L59-L316) один и тот же 25-строчный блок валидации и `casUpsertSettings` скопирован **9 раз подряд** для каждой роли.
  - При добавлении роли нужно синхронно править [selections.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/server/rpc/selections.ts#L59-L316), [settings.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/server/rpc/settings.ts#L271-L371), [run-routing.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/runs/server/run-routing.ts#L1-L120), [page-model.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/ui-shell/ui/page-model.ts#L1-L33), [role-models.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/packages/models/src/role-models.ts#L1-L90) и [rpc-settings.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/contracts/rpc-settings.ts#L1-L120).
- **[Hidden link] Скрытые side-effect импорты для регистрации judgments в [setting-validation.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/setting-validation.ts#L5-L9):**
  - Пять «голых» импортов (`import "../workflow/route-workflow"`, `import "../wall"` и т.д.) нужны только ради побочного эффекта заполнения глобального реестра `listJudgments()` перед валидацией `jev.thresholds`.
- **[Special case] Разбросанные ветки под конкретные `providerId` (`opencode2`, `acp-opencode`, `acp-cursor`):**
  - Спец-ветки размазаны по [server.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/server.ts#L246-L251), [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L353-L355), [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1689-L1692), [settings.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/settings/server/rpc/settings.ts#L147-L153), [spawn-model.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/spawn-model.ts#L73-L109) и [v2.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/lane-stack/opencode/opencode-lane/v2.ts#L38-L53) (исключение для `lane-critic` / `lane-reviewer`).
- **[Surplus] 18 мёртвых / недостижимых из production файлов и 3 мёртвые комнаты:**
  - Комнаты, не используемые в рантайме: [atlas/index.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/atlas/index.ts), [twins/index.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/twins/index.ts), [guard-tools/index.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/guard-tools/index.ts).
  - Мёртвые файлы в prod-комнатах: [install-runner.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-install/install-runner.ts#L1-L93) (в строке 5 прямо написано: *«Lane Pilot does not instrument or run install.sh»*), [s8.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-install/s8.ts#L1-L58), [workflow-draft.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/workflow/ui/workflow-draft.ts#L1-L57), [workflow-model-ops.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/workflow/ui/workflow-model-ops.ts#L1-L22), [memory-delta.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/bench/memory-delta.ts), [skips.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/deferral/skips.ts), [gate.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/memory-eval/server/gate.ts), [thread-completion.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-agent/thread-completion.ts#L1-L9), [night-fix.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/night/night-fix.ts), [growth.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/policy/growth.ts), [session-hooks/cli.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/session-hooks/cli.ts), [work-graph/index.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/work-graph/index.ts).
  - Дублирующийся вызов `compiledMainAgentSpawnBinding` при сборке `rolePrompt` в [activation.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-agent/server/activation.ts#L98-L106) и [activation.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-agent/server/activation.ts#L152-L160).

---

### Кластер E: Вычищение захардкоженных фикстур, личных ID и проглоченных ошибок

#### Целевой дизайн (First-Principles Redesign)
1. **Полное отделение тестовых фикстур и окружения разработчика от production-кода:** Никаких конкретных `projectId`, `host_...`, `ssh -i ~/.ssh/... ubuntu@10.8.0.1`, путей `~/Documents/BB-сервис/...` и проверок на `hello.txt` в коде плагина. Всё это выносится в явный конфиг проекта/хоста или тестовые фикстуры.
2. **Замена слепых `catch {}` на классифицированную обработку ошибок:** Ошибки делятся на ожидаемые (например, `ENOENT` при проверке файла) и неожиданные (логируются через структурированный telemetry/diagnostics канал, а не глушатся).

#### Что этот редизайн устраняет:

- **[Special case] Тестовая фикстура `hello.txt` прямо в production CLI [cli.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/tools/server/cli.ts#L603-L612):**
  - Команда `bb lane-pilot recover` проверяет наличие файла `hello.txt` с текстом `"hello from native BB writer\n"` и `tests/hello.test.txt`!
- **[Special case] Личные ID проектов, хостов, SSH-адреса и локальные пути в production-коде:**
  - В [self-repair.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/self-repair/server/self-repair.ts#L63-L75) объект `SELF_REPAIR_DEFAULTS` хардкодит `projectId: "proj_ejbam66722"`, `environmentId: "env_7etjwdpbuw"`, `sectionId: "9b66deb6-e617-420c-8dc0-3a281ff73545"`, `ignoreProjects: ["proj_3tb652jpsi"]` и `hubSsh: "ssh -i ~/.ssh/id_ed25519 ubuntu@10.8.0.1"`.
  - В [employee-place.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-agent/employee-place.ts#L8-L12) зашиты `AFFINITY_HOSTS` (`"mac-mini": "host_7sea4qaad8"`, `ovh: "host_rwrxyi39aw"`, `windows: "host_z8sapas8an"`).
  - В [host-handlers.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts#L913) зашит путь `join(homedir(), "Documents", "BB-сервис", "toolkit", "computer-use", "bin", "run")`.
  - В [spawn-model.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/spawn-model.ts#L73-L109) зашита проверка macOS-пути `^/Users/[^/]+/Documents(/|$)` специально для `opencode2`.
- **[Special case] 1 006 проглоченных исключений и 122 таймера/поллинга:**
  - **191** пустой блок `catch {}` (в т.ч. 14 в [database.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/storage/database.ts#L1260-L1952), 13 в [host-handlers.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/host-handlers.ts), 8 в [core.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/core/server/core.ts)) и **815** вызовов `.catch(() => undefined/null/false/[])`.
  - Busy-wait блокировки файловой системы через `setTimeout(100)` × 20 × 3 в [jobs.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/host-worker/jobs.ts#L145-L157) и 5-секундный `Promise.race` в [native-install-lifecycle.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/native-install/native-install-lifecycle.ts#L61), возвращающий статус `"running"`, если промис не успел завершиться.

---

### Кластер F: Развязка `sma-map` и архитектурных тестов от текста исходников

#### Целевой дизайн (First-Principles Redesign)
1. **Замена проверки подстрок исходного кода (`path#substring`) на экспорт символов или AST/декораторы:** Вместо того чтобы `sma-map` читал `.ts`-файлы через `readFileSync` и искал в них текстовые подстроки, точки контракта регистрируются явно или проверяются через TypeScript-экспорты.
2. **Перевод `boundaries.test.ts` на проверку циклов между комнатами (Room-level DAG):** Архитектурный тест должен запрещать циклы между **комнатами**, а не только между отдельными файлами.

#### Что этот редизайн устраняет:

- **[Needless link + Главная ловушка рефакторинга] 1 798 строковых привязок в [sma-map/entries.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/sma-map/entries.ts#L9-L1809):**
  - В [sma-map/model.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/sma-map/model.ts#L104-L115) функция верификации читает исходники через `readFileSync(full, "utf8").includes(symbol)` для **1 798 захардкоженных пар `путь#подстрока`**, а [sma-map/live.ts](file:///home/ubuntu/BB-service/bb-plugin-lane-pilot/src/rooms/sma-map/live.ts#L16-L225) хардкодит имена таблиц БД.
  - Кроме того, **12 тестовых файлов** напрямую читают исходники через `readFileSync("src/rooms/...")`. Без предварительного обновления `sma-map` любой перенос файла или переименование функции мгновенно роняет тесты.

---

## 3. Оценка объёма работ (Roadmap & Effort Estimate)

> [!TIP]
> Рефакторинг **нельзя** делать одним гигантским коммитом — из-за `sma-map` и 60-комнатного SCC его нужно проводить **6 изолированными волнами**, где после каждой волны зелёными остаются `pnpm typecheck` и `pnpm test`.

| Волна | Содержание работ | Затронуто файлов | Объём изменений (LOC) | Сложность и риски | Оценка трудозатрат |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Волна 0. Гигиена и удаление балласта (Quick Wins)** | Удаление 18 мёртвых файлов/комнат (`atlas`, `twins`, `guard-tools`, `install-runner.ts`, `workflow-draft.ts`, `packages/workflow-engine/src/db.ts`), вынос `hello.txt` из `cli.ts`, вынос хардкода ID/SSH из `self-repair.ts` и `employee-place.ts`. | ~35–45 файлов | `-1 800` / `+250 LOC` | **Низкий риск.** Быстрая расчистка перед структурными изменениями. | **0.5–1 день** (1–2 агентные сессии) |
| **Волна 1. Отвязка `sma-map` и единый реестр ролей (`RoleSpec`)** | Перевод `sma-map` с `readFileSync().includes()` на стабильные ссылки/генератор; свертка 9-кратной копипасты в `selections.ts` и 6 списков ролей в единый `RoleSpec` в `packages/models`; замена side-effect импортов в `setting-validation.ts`. | ~40–55 файлов | `-1 200` / `+600 LOC` | **Средний риск.** Снимает главный блокер (`sma-map`) для перемещения файлов в следующих волнах. | **1–1.5 дня** (2–3 агентные сессии) |
| **Волна 2. Расщепление `storage/database.ts` и владение таблицами** | Выделение чистого драйвера БД + доменных миграций; инкапсуляция SQL для `lane_pilot_run`, `lane_pilot_attempt`, `lane_pilot_task` в репозитории; замена regex-парсинга `attempt.reason` (`listCheckTimeouts`) на структурированные поля; типизация KV-ключей. | ~110–140 файлов | `~4 500–6 000 LOC` (перенос + рефакторинг) | **Высокий риск.** Центральный узел графа (fan-in 52). Требует пошаговой миграции по одной таблице за раз. | **3–4 дня** (5–7 агентных сессий) |
| **Волна 3. Явный DI-контейнер (`core`) и разделение `host-handlers.ts`** | Ликвидация `const services = {} as Services` и неявного порядка вызовов в `server.ts`; разделение `Services` (135 полей) на `InfraContext` и доменные фасады; разбиение `host-handlers.ts` (942 LOC) и `contracts/host.ts` по доменам; замена `node -e` в `jobs.ts`. | ~80–100 файлов | `~3 000–4 000 LOC` | **Средне-высокий риск.** Разрывает главную звезду зависимостей вокруг `core` и `host-worker`. | **2–3 дня** (4–5 агентных сессий) |
| **Волна 4. Декомпозиция конвейера исполнения (`writer`, `runs`, `verification`, `phase`)** | Единый `AttemptLifecycle` автомат; разбиение God-файлов `writer/start.ts` (1 469 LOC), `writer/finish.ts` (1 161 LOC), `phase/driver.ts` (1 240 LOC), `self-repair.ts` (1 309 LOC); перенос `docs-*` и `stability-drill.ts` из `verification`. | ~90–120 файлов | `~5 000–6 500 LOC` | **Высокий риск.** Самая сложная бизнес-логика (worktrees, ретраи, критика, гейты). | **3–4 дня** (6–8 агентных сессий) |
| **Волна 5. Укрупнение 69 комнат в ~18–20 доменов и DAG-тест** | Слияние 25+ микро-комнат в домены, ликвидация 56 deep-imports, очистка 143 авто-barrels, включение проверки **межкомнатных** циклов в `boundaries.test.ts`, ревизия 191 пустого `catch {}` и 424 `.skip` тестов. | ~250–350 файлов | `~4 000–5 500 LOC` (в основном перемещения и импорты) | **Средний риск** (при условии выполнения Волн 1–4). Завершает превращение графа комнат в строгий DAG. | **2.5–3.5 дня** (4–6 агентных сессий) |
| **ИТОГО** | **Полное приведение кодовой базы в порядок** | **~500–650 файлов** | **~18 000–23 000 LOC затронуто** (чистое сокращение **~4 500–6 000 LOC**) | Полный разрыв 60-комнатного SCC и переход к модульной архитектуре | **~12–17 рабочих дней** (или **20–30 плотных агентных сессий**) |
