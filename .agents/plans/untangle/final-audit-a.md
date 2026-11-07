# Lane Pilot Untangle — Финальный аудит A (Argon, `3b87083f`): что осталось после волн F1–F9

- **Worktree**: `/home/ubuntu/BB-service/wt/audit` (`HEAD` detached at `main` `3b87083f`)
- **Сравнение с историей**: [decision-log.md](file:///home/ubuntu/BB-service/wt/audit/.agents/plans/untangle/decision-log.md) (волны U0–U10 / F1–F9) и ранний аудит [argon-audit-ru.md](file:///home/ubuntu/BB-service/wt/audit/.agents/plans/untangle/argon-audit-ru.md) (на базе `c6b443cb`)
- **Главный вопрос к каждой части**: **должны ли эти части меняться вместе?**

---

## 1. Численная сверка (`node scripts/room-graph.mjs` и статический срез на `3b87083f`)

Запуск [scripts/room-graph.mjs](file:///home/ubuntu/BB-service/wt/audit/scripts/room-graph.mjs#L1-L97) на коммите `3b87083f` (совпадает с [room-graph-baseline.json](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/room-graph-baseline.json#L1-L6)):

```json
{ "rooms": 88, "largestScc": 64, "mutualPairs": 94, "edges": 684 }
```

| Метрика | База до Untangle (`c6b443cb`) | Цель в [decision-log.md](file:///home/ubuntu/BB-service/wt/audit/.agents/plans/untangle/decision-log.md#L14-L19) | Факт на `3b87083f` | Почему метрика не сошлась с целью |
| :--- | ---: | ---: | ---: | :--- |
| **Узлы в `src/rooms` (`rooms`)** | 81 | ~50 | **88** (+7) | F9 (слияние 25 микро-комнат) не выполнялся; при этом в корень `src/rooms/` добавили 6 свободных `.ts`-файлов (`@migrations.ts`, `@state-machine.ts`, `@failure-class.ts`, `@setting-validation.ts`, `@plugin-db.ts`, `@dirt-snapshot.ts`) и `package.json`, которые [room-graph.mjs](file:///home/ubuntu/BB-service/wt/audit/scripts/room-graph.mjs#L15-L19) считает отдельными `@`-узлами |
| **Крупнейший цикл (`largestScc`)** | 65 | `<= 5` | **64** (-1) | 1) [core/server/services.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/services.ts#L1-L183) (`out: 54, in: 43`) склеивает тип `Services` (импортируемый 35 комнатами) и рантайм-хелперы (`scheduleIsolated`, `registerObservedTool`, `fullAccessSpawn`) с композицией 47 доменных фабрик и [core/server/rpc.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc.ts#L1-L131); 2) даже если удалить из графа `core`, `contracts` и `tools`, в `src/rooms` остаётся **SCC из 50 комнат** из-за взаимных пар вокруг `ui-shell`, `workflow`, `writer`, `runs`, `critique`, `tasks`, `verification`, `native-agent`, `settings` |
| **Взаимные пары `A <-> B` (`mutualPairs`)** | 123 | 0 | **94** (-29) | **37** взаимных пар создаёт `core <-> <room>`; ещё **57** взаимных пар — между самими доменными комнатами (8 пар `ui-shell <-> <tab-room>`, 9 пар `workflow <-> <stage-room>`, 6 пар `writer <-> <room>`, 5 пар `runs <-> <room>`, 4 пары `critique <-> <room>` и др.) |
| **Межкомнатные рёбра (`edges`)** | 671 | `<= 250` | **684** (+13) | Вынос 6 `@`-файлов в корень `src/rooms/` и дробление файлов без переноса подписчиков (`writer/server/{stability,workflow,verification,rule-forms}.ts`) добавили новые внешние рёбра |
| **Глубокие импорты в обход `index.ts`** | — | 0 | **53 импорта (39 пар)** в [deep-imports.json](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/deep-imports.json#L1-L41) + слепые зоны | 53 глубоких импорта заморожены в бейзлайне; ещё 3 глубоких импорта в `@migrations.ts` и `@plugin-db.ts` не видны тесту из-за дыры в [boundaries.test.ts](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L38-L55) |
| **Прямые `db.prepare(...)` в `src/rooms`** | 910 | Только в комнате-владельце таблицы | **910** (`1 121` с `packages/`) | F2 (Table Ownership) выполнен только для 4 мест (`worktree-keys`, `cancel-code`, колонки `failure_code/check_name/timeout_sec`, `STAGE_CONTRACT`). `lane_pilot_run` читают/пишут напрямую **45** комнат/пакетов, `lane_pilot_attempt` — **39**, `lane_pilot_task` — **29**, `lane_pilot_stage_receipt` — **22**, `lane_pilot_wf_run` — **20** |
| **Подавленные `.catch(() => …)` в `src/rooms`** | 977 (799 однострочных) | Именованные границы ошибок (F8) | **977** (`990` с `packages/`) | F8 не выполнялся на уровне комнат; антипаттерн `kv.get(...).catch(() => null) ?? []` перед `kv.set` создаёт риск потери данных при сбое KV |
| **Тривиальные/пустые `catch {}` в `src/rooms`** | 168 | Логирование / `ENOENT`-проверка | **202** однострочных (`169` без аргумента, `12` абсолютно пустых `catch {}`) | Даже в `packages/kit/src/hash.ts` `sha256FileOrNull` всё ещё глушит любые ошибки чтения файла (`EACCES`, `EIO`) через `catch { return null; }` |
| **Тесты с `readFileSync` по `src/` + `.skip` / `.todo`** | 1 `.skip`, 423 `.todo` | 0 source-text тестов | **85** тест-файлов с `readFileSync` по `src/`, **1** `.skip`, **423** `.todo` | Кроме того, [sma-map/model.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/model.ts#L108-L118) (`brokenProof`) по-прежнему проверяет 1 798 якорей через `readFileSync(full, "utf8").includes(symbol)` |

### Топ узлов-концентраторов по `node scripts/room-graph.mjs`

| Узел (`src/rooms/<room>`) | Исходящие (`out`) | Входящие (`in`) | Сумма (`out + in`) | Главная причина связности |
| :--- | ---: | ---: | ---: | :--- |
| `core` | 54 | 43 | **97** | Смешивает `Services` + `rpc.ts` (импорт 47 доменных комнат) с рантайм-примитивами (`scheduleIsolated`, `registerObservedTool`, `fullAccessSpawn`), которые нужны 43 комнатам |
| `contracts` | 2 | 58 | **60** | Импортирует доменные комнаты `anamnesis` и `schedule` (плюс локальный `settings.ts`), втягивая всех 58 потребителей в доменный граф |
| `storage` | 4 | 55 | **59** | 1556-строчный `database.ts` (139 `db.prepare`), синхронно вызывающий `@lane-pilot/memory-core` в `transitionAttempt` и реэкспортирующий `@lane-pilot/workflow-engine` |
| `writer` | 29 | 25 | **54** | 4 файла подписчиков (`stability.ts`, `workflow.ts`, `verification.ts`, `rule-forms.ts`) с пометками `MERGER: Move it there` так и остались внутри `writer/server/` |
| `tools` | 50 | 2 | **52** | Точка сборки агентских тулов и CLI (`cli.ts` содержит инлайн-оркестрацию для `cancel`, `recover`, `council*`, `excavate`, `design-metrics`); образует цикл `core <-> tools` |
| `runs` | 19 | 31 | **50** | Смешивает машину состояний ранов с RPC `native-install`/`native-agent`, JEV-свайпами в `failure-class-model.ts` и 4 копиями regex-парсеров `attempt.reason` |
| `workflow` | 23 | 22 | **45** | Импортирует 9 доменных комнат для регистрации графов, а те же комнаты импортируют `builtinWorkflow` / `WorkflowEngine` / `NativeModelPicker` обратно из `workflow` |
| `native-agent` | 19 | 22 | **41** | Двусторонние глубокие импорты с `writer`, `runs`, `settings`, `ui-shell`, `relay`, `learning`, `qa`, `stability` |
| `tasks` | 11 | 28 | **39** | Взаимные циклы с `runs`, `verification`, `critique`, `writer`, `workflow` и прямые SQL-запросы к `lane_pilot_token_daily` (`usage`) |
| `critique` | 13 | 20 | **33** | Взаимные циклы с `writer`, `tasks`, `qa`, `memory`, `workflow` и глубокие импорты в `writer/server/start` и `tasks/execution-packet` |

---

## 2. Ранжированный план исправлений по рычагу (Fixes Ranked by Leverage, R1–R10)

Каждое исправление ниже сформулировано из первых принципов и объединяет все конкретные находки (`file:line`, категория, почему текущая связь ошибочна), которые это исправление устраняет за один шаг.

---

### R1. Разделить `src/rooms/core` на нижний рантайм-примитив (`src/rooms/runtime`) и верхний композиционный слой (`server.ts`), перенести 6 свободных `@`-файлов из корня `src/rooms/` и очистить `src/rooms/contracts` от доменных импортов
**Рычаг**: Убирает **37 из 94** взаимных пар (`core <-> <domain>`), выводит `contracts` (fan-in 58) и `@migrations.ts` (out 23) из SCC, ликвидирует все 6 свободных `@`-файлов в `src/rooms/` и устраняет слепую зону архитектурных тестов.

**Единое исправление (The one fix)**:
1. Оставить в нижнем слое (`src/rooms/core` или `src/rooms/runtime`, `out: 0` в доменные комнаты) только инфраструктурные примитивы, импортируемые доменными комнатами (`scheduleIsolated`, `registerObservedTool`, `fullAccessSpawn`, `modelCatalogOf`, `resolveSpawnModel`, `spawnUsageOf`, `graphStepMetadata`, `findThreadsByMetadata`, `stageHelperSettings`, `fenceOutside`, `gitCallRpc`), а сборку [services.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/services.ts#L1-L183) (тип `Services`, который комнаты заменяют на узкие порты `Pick<Services, ...>` или аргументы фабрик) и [rpc.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc.ts#L1-L131) поднять в верхний композиционный слой рядом с `server.ts`.
2. Перенести [tool-result.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/tool-result.ts#L1-L55), [action-schema.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/action-schema.ts#L1-L106) и [owner-turn.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/owner-turn.ts#L1-L78) в `src/rooms/tools/server/`, разрывая цикл `core <-> tools`.
3. Перенести Zod-схемы `anamnesisHostMethods`, `anamnesisRpcMethods` и `scheduleRpcContract` внутрь `src/rooms/contracts/`, чтобы у `contracts` было **0 импортов из доменных комнат**, и удалить дублирующий обходной контракт `uiQueryContract` (`z.unknown()`).
4. Убрать 6 свободных файлов из корня `src/rooms/`: `state-machine.ts`, `failure-class.ts`, `dirt-snapshot.ts`, `setting-validation.ts` — в `@lane-pilot/contracts` / `settings`; `migrations.ts` — в `src/rooms/storage/migrations.ts`; `plugin-db.ts` — в `tests/helpers/plugin-db.ts`; ужесточить [boundaries.test.ts:115](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L114-L116) до `!/^src\/rooms\/[^/]+\//.test(f)`.

#### Находки, которые закрывает R1:

1. **[src/rooms/core/server/services.ts:1-183](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/services.ts#L1-L183)** — `Needless links`
   - **Почему это неверно**: Файл импортирует 47 доменных комнат (`createRuns`, `createWriter`, `createCritique`, `createPhase`, `createWorkflow` и т.д.), чтобы объявить 110-польный интерфейс [`Services`](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/services.ts#L70-L183). Поскольку 35 доменных комнат импортируют `type { Services } from "../../core/server"`, любая правка сигнатуры в одной комнате меняет центральный тип, от которого зависят остальные 34 комнаты, а [scripts/room-graph.mjs:44](file:///home/ubuntu/BB-service/wt/audit/scripts/room-graph.mjs#L44) фиксирует 35 двусторонних циклов `core <-> <room>`.
   - **Исправление**: Поднять `Services` в композиционный корень, а в доменных комнатах объявлять локальные узкие интерфейсы зависимостей.

2. **[src/rooms/core/server/rpc.ts:1-131](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc.ts#L1-L131), [rpc-chat-agent.ts:1-18](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc-chat-agent.ts#L1-L18), [rpc-memory-probe.ts:1-12](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc-memory-probe.ts#L1-L12)** — `Needless links`
   - **Почему это неверно**: Сборщик всех RPC-обработчиков плагина (`registerRpc`, импортирующий 32 доменные комнаты) лежит внутри комнаты `core`, откуда те же комнаты берут низкоуровневые функции (`scheduleIsolated`, `fullAccessSpawn`). Кроме того, на строках [rpc.ts:93-122](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/rpc.ts#L93-L122) прямо инлайном написаны обработчики для `front` (`first_run_*`, `helpers_*`, `peers_list`, `coord_*`, `door_audience`, `actions_recent`), `task_word` (`recordTaskWord` + `answerTaskWord`), `learning_decide`, `world_version`, `money_status` и `conveyor_*`, а `rpc-chat-agent.ts` и `rpc-memory-probe.ts` лежат в `core/server/` вместо `native-agent/server` и `memory-probe/server`.
   - **Исправление**: Перенести инлайновые обработчики в их комнаты (`front`, `tasks`, `learning`, `world`, `money`, `runs`), а `registerRpc` вызывать на верхнем уровне композиции.

3. **[server.ts:97-220](file:///home/ubuntu/BB-service/wt/audit/server.ts#L97-L220)** — `Hidden links`
   - **Почему это неверно**: На строке [server.ts:97](file:///home/ubuntu/BB-service/wt/audit/server.ts#L97) создаётся пустой объект `const services = {} as Services;`, который передаётся по ссылке в 28 фабрик ([server.ts:100-149](file:///home/ubuntu/BB-service/wt/audit/server.ts#L100-L149)), пока его поля ещё `undefined`. Даже после `Object.assign` объект дозаполняется на строке [server.ts:162](file:///home/ubuntu/BB-service/wt/audit/server.ts#L162) (`services.pmReplay = pmReplay`) и строке [server.ts:214](file:///home/ubuntu/BB-service/wt/audit/server.ts#L214) (`services.errands = mountErrands(ctx, services)`), хотя в [`Services`](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/services.ts#L173) поле `errands: ErrandsApi` объявлено как обязательное и во время вызовов `registerAgentRoutineActions`, `mountNightGraphs`, `registerRpc`, `mountLead`, `mountPhaseDriver` ([server.ts:151-180](file:///home/ubuntu/BB-service/wt/audit/server.ts#L151-L180)) фактически равно `undefined`.
   - **Исправление**: Собирать сервисы в явном топологическом порядке слоями (Tier 1 -> Tier 2 -> Tier 3) и возвращать замороженный `Readonly<Services>` без `{} as Services`.

4. **[src/rooms/core/server/core.ts:1-22](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/core.ts#L1-L22) и [src/rooms/contracts/server-core.ts:57-223](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/server-core.ts#L57-L223)** — `Needless links` и `Hidden links`
   - **Почему это неверно**: `createCore` ([core.ts:162-422](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/core.ts#L162-L422)) монтирует в инфраструктурный контекст `ctx` методы 7 доменных комнат (`runs`, `native-install`, `native-agent`, `stability`, `relay`, `secrets`). А чтобы избежать импорта типов из этих комнат, в [contracts/server-core.ts:57-223](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/server-core.ts#L57-L223) вручную скопированы 25 доменных структурных типов (`Realtime`, `OwnerAsk`, `Secrets`, `CompiledMainAgent`, `CustomAgentMeta`, `StoredAgentRow`, `WriterBindingResolution`, `RunPolicy`, `DirtSnapshot`, `AttemptRow`, `RunRow`, `SectionRow`, `DeployDrain`, `NativeInstaller`, `CoexistenceOperationInput`).
   - **Исправление**: Оставить в `ServerCore` только инфраструктуру (`bb`, `db`, `host`, `log`, `realtime`, `state`), а доменные операции вызывать через сервисы соответствующих комнат.

5. **[src/rooms/core/server/tool-result.ts:5](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/tool-result.ts#L5), [action-schema.ts:1-106](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/action-schema.ts#L1-L106), [owner-turn.ts:1-78](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/owner-turn.ts#L1-L78), [self-repair-deps.ts:1-21](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/self-repair-deps.ts#L1-L21)** — `Needless links` и `Surplus`
   - **Почему это неверно**: `tool-result.ts:5` импортирует `boundPresentation` из `../../tools/server`, а `self-repair-deps.ts:2` импортирует `SelfRepairDeps` из `../../self-repair/server` ради одного вызова в [tools/server/tools.ts:328](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tools/server/tools.ts#L328), создавая циклы `core <-> tools` и `core <-> self-repair`.
   - **Исправление**: Перенести `tool-result.ts`, `action-schema.ts` и `owner-turn.ts` в `src/rooms/tools/server/` и удалить одноразовый мешок-адаптер `self-repair-deps.ts`.

6. **[src/rooms/contracts/rpc-shell.ts:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/rpc-shell.ts#L2), [src/rooms/contracts/rpc-knowledge.ts:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/rpc-knowledge.ts#L2), [src/rooms/contracts/host.ts:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/host.ts#L2), [src/rooms/contracts/ui-query.ts:1-25](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/ui-query.ts#L1-L25)** — `Needless links` и `Hidden links`
   - **Почему это неверно**: Нижний слой `src/rooms/contracts` импортирует `scheduleRpcContract` из `../schedule` и `anamnesisRpcMethods`/`anamnesisHostMethods` из `../anamnesis`. Как прямо признано в комментарии [ui-query.ts:10-13](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/ui-query.ts#L10-L13), импорт `../schedule` тянет `@lane-pilot/kit` (и `node:*` builtins) в `rpcContract`, из-за чего для UI пришлось создать второй, ослабленный контракт `uiQueryContract` с `z.unknown()`, который нужно синхронизировать вручную со списком RPC!
   - **Исправление**: Перенести схемы `scheduleRpcContract`, `anamnesisRpcMethods` и `anamnesisHostMethods` в `src/rooms/contracts/` и удалить костыль `ui-query.ts`.

7. **[src/rooms/migrations.ts:1-545](file:///home/ubuntu/BB-service/wt/audit/src/rooms/migrations.ts#L1-L545), [src/rooms/plugin-db.ts:1-16](file:///home/ubuntu/BB-service/wt/audit/src/rooms/plugin-db.ts#L1-L16), [src/rooms/setting-validation.ts:1-13](file:///home/ubuntu/BB-service/wt/audit/src/rooms/setting-validation.ts#L1-L13), [src/rooms/dirt-snapshot.ts:1-19](file:///home/ubuntu/BB-service/wt/audit/src/rooms/dirt-snapshot.ts#L1-L19), [src/rooms/state-machine.ts:1-148](file:///home/ubuntu/BB-service/wt/audit/src/rooms/state-machine.ts#L1-L148), [src/rooms/failure-class.ts:1-324](file:///home/ubuntu/BB-service/wt/audit/src/rooms/failure-class.ts#L1-L324) и [tests/architecture/boundaries.test.ts:38-55, 114-116](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L38-L55)** — `Hidden links`, `Needless links` и `Surplus`
   - **Почему это неверно**: Эти 6 файлов вынесли на один уровень вверх в `src/rooms/*.ts`, чтобы формально вывести их из `storage`. В результате:
     - `roomName` в [boundaries.test.ts:38](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L38) возвращает `null`, делая `deepImports()` слепым к их глубоким импортам (`./anamnesis/server`, `./learning/migrations` в [migrations.ts:10-11](file:///home/ubuntu/BB-service/wt/audit/src/rooms/migrations.ts#L10-L11) и `./storage/database` в [plugin-db.ts:5](file:///home/ubuntu/BB-service/wt/audit/src/rooms/plugin-db.ts#L5));
     - [memory-eval/server/corpus.ts:3](file:///home/ubuntu/BB-service/wt/audit/src/rooms/memory-eval/server/corpus.ts#L3) и [shelf.ts:6](file:///home/ubuntu/BB-service/wt/audit/src/rooms/memory-eval/server/shelf.ts#L6) импортируют `../../migrations`, втягивая `@migrations.ts` (и все 22 импортируемые им комнаты) обратно в 64-комнатный SCC;
     - `plugin-db.ts` используется только в тестах/скриптах и содержит дублирующий реэкспорт `export * from "./storage"` + `export * from "./storage/database"` ([plugin-db.ts:9-10](file:///home/ubuntu/BB-service/wt/audit/src/rooms/plugin-db.ts#L9-L10));
     - в `src/rooms/runs/` остались 4-строчные прокси-обёртки [runs/state-machine.ts:1-4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/state-machine.ts#L1-L4) и [runs/failure-class.ts:1-4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/failure-class.ts#L1-L4).
   - **Исправление**: Переместить все 6 файлов в их пакеты/комнаты, удалить прокси в `runs/`, а в [boundaries.test.ts:115](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L115) запретить любые файлы вне `src/rooms/<room>/`.

---

### R2. Завершить инверсию зависимостей в исполнительном кластере (`writer`, `runs`, `critique`, `tasks`, `verification`, `workflow`, `stability`, `rule-forms`, `stage-return`)
**Рычаг**: Разрубает **50-комнатный внутренний SCC**, который остаётся даже после вычета `core`, `contracts` и `tools`.

**Единое исправление (The one fix)**:
1. Завершить перенос 4 файлов подписчиков `onAttemptFinished`, которые в волне F5 (U9) были созданы внутри `src/rooms/writer/server/` с комментарием `MERGER: Move it there`, но так и не были перенесены в целевые комнаты:
   - `writer/server/stability.ts` -> `src/rooms/stability/server/attempt-finished.ts`
   - `writer/server/workflow.ts` -> `src/rooms/workflow/server/attempt-finished.ts`
   - `writer/server/verification.ts` -> `src/rooms/verification/server/attempt-finished.ts`
   - `writer/server/rule-forms.ts` -> `src/rooms/rule-forms/server/attempt-finished.ts`
2. Передавать состояние попытки и рана явно в событии `AttemptFinishedEvent`, разделив его на `onAttemptFailed` и `onAttemptAccepted`, чтобы порядок регистрации слушателей перестал быть скрытым контрактом.
3. Перенести определения встроенных графов (`builtinWorkflow(...)`) из `src/rooms/workflow/builtin.ts` в комнаты-исполнители (или регистрировать исполнителей в `workflow` при монтировании), чтобы разорвать 9 взаимных циклов `workflow <-> {anamnesis, critique, errands, lead, native-agent, phase, qa, self-repair, writer}`.
4. Вынести общие чистые структуры задач и фолбэков (`task-v2`, `execution-packet`, `read-first`, `writer-fallbacks`, `critic-pair`, `STICKY_WINDOW_MS`) в `@lane-pilot/contracts` (или публичные `index.ts`), убрав 25 глубоких импортов между `writer`, `tasks`, `critique`, `runs`, `verification` и `native-agent`.

#### Находки, которые закрывает R2:

1. **[src/rooms/writer/server/stability.ts:6-9](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/stability.ts#L6-L9), [workflow.ts:5-8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/workflow.ts#L5-L8), [verification.ts:14-17](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/verification.ts#L14-L17), [rule-forms.ts:5-8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/rule-forms.ts#L5-L8) и [finish.ts:26, 76, 428-458](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/finish.ts#L26-L76)** — `Needless links`
   - **Почему это неверно**: Во всех 4 файлах в шапке написано `MERGER: this file belongs to src/rooms/<room>/server/attempt-finished.ts. Move it there...`, но файлы остались в `src/rooms/writer/server/`. Более того, `createWriterVerification` вызывается из `finish.ts:428,433,458` напрямую, даже не через шину `onAttemptFinished`. Из-за этого `writer` имеет `out: 29, in: 25`, а [start.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L1-L1540) (1 540 LOC) и [finish.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/finish.ts#L1-L1008) (1 008 LOC) продолжают тянуть зависимости от `stability`, `workflow`, `verification` и `rule-forms`.
   - **Исправление**: Перенести эти 4 файла в их целевые комнаты и подписывать их на `onAttemptFinished` при старте.

2. **[src/rooms/writer/server/attempt-finished.ts:61-66, 83-93](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/attempt-finished.ts#L61-L93), [start.ts:128-130, 1411-1423, 1451-1461](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L128-L130), [finish.ts:75-77](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/finish.ts#L75-L77)** — `Hidden links`
   - **Почему это неверно**: Комментарий в `attempt-finished.ts:61-63` гласит: *«Registration order is the run order — it is a contract»*. На ошибке (`start.ts:1411-1423`) событие эмитится **до** записи stage-receipt и `refreshRun` (чтобы `stability` увидела ещё не остановленный ран), а на успехе (`start.ts:1451-1461`) — **после** `refreshRun` (чтобы `workflow:after-accept` увидел обновлённый статус).
   - **Исправление**: Разделить хуки на `onAttemptFailed` и `onAttemptAccepted` и передавать снимок состояния рана явно в payload события.

3. **[src/rooms/stage-return/server/stage-return.ts:65-70](file:///home/ubuntu/BB-service/wt/audit/src/rooms/stage-return/server/stage-return.ts#L65-L70), [src/rooms/writer/server/state.ts:14](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/state.ts#L14), [src/rooms/writer/server/start.ts:642](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L642)** — `Hidden links` и `Special cases`
   - **Почему это неверно**: `stage-return` напрямую читает внутренний `Set<string>` комнаты `writer` (`services.activeWriterTasks`), вручную собирает приватный строковый ключ `` `${row.run_id}:${taskId}` `` и ждёт его освобождения в busy-wait цикле `while (services.activeWriterTasks.has(key)) { await sleep(500); }`.
   - **Исправление**: Инкапсулировать ожидание внутри `writer/server/state.ts` методом `waitForWriterTaskDrain(runId, taskId, timeoutMs)` на промисах без внешнего доступа к `Set` и без поллинга `sleep(500)`.

4. **[src/rooms/runs/failure-class-model.ts:8-12, 150-158](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/failure-class-model.ts#L8-L12)** — `Hidden links`
   - **Почему это неверно**: Чтобы обойти циклические импорты с `workflow`, `tasks` и `writer`, строки 8–12 копируют строковые литералы `ROUTE_WORKFLOW_ID = "route.workflow"`, `PLAN_FACT_JEV_ID = "plan.fact"`, `WRITER_MODEL_JEV_ID = "writer.model"`. При этом функция чтения классификации сбоя `judgedFailureClass` ([строки 150-158](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/failure-class-model.ts#L150-L158)) скрыто запускает запись исходов в `jev`, читает `lane_pilot_wf_run` и удаляет/перезаписывает KV-ключ `` `writer-route:${row.runId}:${row.taskId}` ``, принадлежащий [writer/writer-model-pick.ts:135](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/writer-model-pick.ts#L135).
   - **Исправление**: Перенести константы ID суждений в `@lane-pilot/contracts`, а запись исходов (`routeSweep`, `planFactSweep`, `writerModelSweep`) перенести на подписчиков `onAttemptFinished`, оставив `judgedFailureClass` чистой функцией чтения.

5. **[src/rooms/writer/server/verify.ts:81](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/verify.ts#L81) и [src/rooms/tasks/server/check-reading.ts:21, 29](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tasks/server/check-reading.ts#L21-L29)** — `Hidden links`
   - **Почему это неверно**: `failIfNoTestRan` в `writer/server/verify.ts:81` склеивает префикс `` `check failed: ${reason}\n${result.stderr}` `` в текстовый `stderr` процесса, а `readCheckRun` в комнате `tasks` восстанавливает факт отсутствия тестов регуляркой `/^check failed: the check exited 0 but\b/m`.
   - **Исправление**: Передавать структурное поле `noTestRanReason?: string` или вызывать `noTestRanReason` внутри `readCheckRun`.

6. **[src/rooms/runs/server/rpc/runs.ts:41-60, 271-355](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/rpc/runs.ts#L41-L60)** — `Needless links` и `Hidden links`
   - **Почему это неверно**: RPC-модуль комнаты `runs` обрабатывает методы `native_install_start`, `native_install_status`, `prepare_native_session`, `native_thread`, `activation_context`, вручную собирает KV-ключи `` `native-thread:${threadId}` `` и `` `native-agent-type:${threadId}` `` ([строки 274, 277](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/rpc/runs.ts#L274-L277) вместо хелперов из `native-agent/native-kv.ts`) и напрямую мутирует `PARKED_KEY` комнаты `stability` ([строки 354-355](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/rpc/runs.ts#L354-L355)).
   - **Исправление**: Перенести RPC-обработчики `native_install_*` в `native-install/server`, а `prepare_native_session` / `native_thread` / `activation_context` — в `native-agent/server`.

7. **[src/rooms/rollback/server/rollback.ts:278-286](file:///home/ubuntu/BB-service/wt/audit/src/rooms/rollback/server/rollback.ts#L278-L286) и [src/rooms/verification/server/merge-intent.ts:21-22](file:///home/ubuntu/BB-service/wt/audit/src/rooms/verification/server/merge-intent.ts#L21-L22)** — `Hidden links` и `Special cases`
   - **Почему это неверно**: `verification` записывает merge-коммиты с трейлером `Lane-Pilot-Task: <taskId>`, но `rollback.ts:286` (`taskOfSubject`) парсит первую строку темы коммита регуляркой `/^([A-Za-z0-9][A-Za-z0-9._-]{0,127}): /`, которая ломается на обычных коммитах `feat: ...` / `fix: ...`. Кроме того, `rollback.ts:278-281` крутит busy-wait цикл `await sleep(20_000)` до 15 минут при `status === "busy"`.
   - **Исправление**: Экспортировать парсер трейлера `Lane-Pilot-Task:` из `verification/server/merge-intent.ts` и использовать единую очередь интеграции вместо 20-секундного поллинга.

8. **Глубокие импорты внутри исполнительного кластера ([tests/architecture/deep-imports.json:2-40](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/deep-imports.json#L2-L40))**:
   - [critique/server/critique-runs.ts:19, 39](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/server/critique-runs.ts#L19-L39) (`tasks/execution-packet`, `writer/server/start`), [critique/server/specialists.ts:8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/server/specialists.ts#L8) (`writer/server/writer-task`), [runs/server/run-finish.ts:4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/run-finish.ts#L4) (`writer/server/sticky`), [runs/server/run-routing.ts:3, 5](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/run-routing.ts#L3-L5) (`native-agent/helper-context`, `native-agent/helper-placement`), [runs/server/rpc/runs.ts:9, 20](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/rpc/runs.ts#L9-L20) (`native-agent/server/native-profile`, `usage/server/attempt-metrics`), [stability/server/reconcile.ts:5, 9](file:///home/ubuntu/BB-service/wt/audit/src/rooms/stability/server/reconcile.ts#L5-L9) и [stability/server/stability.ts:6-7](file:///home/ubuntu/BB-service/wt/audit/src/rooms/stability/server/stability.ts#L6-L7) (`runs/server/stage-records`, `runs/server/run-routing`, `runs/server/runs-halt`), [verification/server/integration-gate.ts:4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/verification/server/integration-gate.ts#L4) и [merge-intent.ts:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/verification/server/merge-intent.ts#L2) (`runs/server/stage-records`), [writer/server/dispatch.ts:15](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/dispatch.ts#L15), [second-pilot.ts:9, 11](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/second-pilot.ts#L9-L11), [spawn.ts:12](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/spawn.ts#L12), [update-task.ts:23](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/update-task.ts#L23), [verify.ts:10](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/verify.ts#L10) (`tasks/*`, `critique/critic-pair`), [host-worker/handlers/git.ts:6, 11](file:///home/ubuntu/BB-service/wt/audit/src/rooms/host-worker/handlers/git.ts#L6-L11) (хост-воркер импортирует серверные баррели `tasks/server` и `verification/server`). — `Needless links`
   - **Исправление**: Экспортировать общие типы/функции через публичные `index.ts` комнат или `@lane-pilot/contracts` и удалить эти строки из `deep-imports.json`.

---

### R3. Разорвать 8 двусторонних циклов `ui-shell <-> <domain>` и вычистить дублирование каталога настроек между `ui-shell`, `settings` и `@lane-pilot/settings-catalog`
**Рычаг**: Убирает сразу **8 взаимных пар (`mutualPairs`)** вокруг `ui-shell`, выводит `settings` из зависимости от 6 доменных комнат (`lead`, `schedule`, `workflow`, `runs`, `wall`, `improvement`, `docs`), убирает 11 глубоких импортов и ликвидирует тройное дублирование метаданных настроек.

**Единое исправление (The one fix)**:
1. Вынести общие UI-хуки и примитивы (`Pill`, `CARD_BODY`, `useLpPoll`, `useLpRealtime`, `useOpenThreadPanel`, `FieldControl`) из `ui-shell` в нижний UI-модуль (или `@lane-pilot/ui-kit`), чтобы доменные экраны (`runs/ui`, `workflow/ui`, `schedule/ui`, `settings/ui`, `errands/ui`, `harness/ui`, `owner-waiting/ui`, `self-repair/ui`) не импортировали `ui-shell` обратно.
2. Перенести константы допустимых значений настроек (`LEAD_MODES`, `WORKFLOW_PRESETS`, `FAILURE_CLASS_MODES`, `WALL_MODES`, `DOCS_DEFAULT_SELECTION`) и валидацию диапазонов (`min`/`max`/`options`) в `@lane-pilot/settings-catalog`, чтобы комната `settings` не импортировала доменные комнаты.
3. Хранить флаги `dedicated`/`basic`/`sectioned`, `helpKey` и ключи ролей в `@lane-pilot/settings-catalog`, удалив ручную развёртку 36 констант и списков ключей из `ui-shell/ui/page-model.ts`.

#### Находки, которые закрывает R3:

1. **8 взаимных циклов `ui-shell <-> {runs, workflow, schedule, settings, errands, harness, owner-waiting, self-repair}`** ([ui-shell/ui/page.tsx:5-14](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/page.tsx#L5-L14), [tab-overview.tsx:2-6](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/tab-overview.tsx#L2-L6), [tab-automation.tsx:2-8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/tab-automation.tsx#L2-L8) против [runs/ui/runs-service.tsx:5](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/ui/runs-service.tsx#L5), [workflow/ui/workflows.tsx:8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/workflow/ui/workflows.tsx#L8), [workflow/ui/workflow-draft.ts:6](file:///home/ubuntu/BB-service/wt/audit/src/rooms/workflow/ui/workflow-draft.ts#L6), [schedule/ui/schedules.tsx:3](file:///home/ubuntu/BB-service/wt/audit/src/rooms/schedule/ui/schedules.tsx#L3), [errands/ui/errands-card.tsx:3](file:///home/ubuntu/BB-service/wt/audit/src/rooms/errands/ui/errands-card.tsx#L3), [harness/ui/harness-card.tsx:4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/harness/ui/harness-card.tsx#L4), [owner-waiting/ui/owner-waiting-strip.tsx:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/owner-waiting/ui/owner-waiting-strip.tsx#L2), [self-repair/ui/self-repair-strip.tsx:2](file:///home/ubuntu/BB-service/wt/audit/src/rooms/self-repair/ui/self-repair-strip.tsx#L2)) — `Needless links`
   - **Почему это неверно**: Верхняя оболочка `ui-shell` монтирует вкладки доменных комнат, но одновременно экспортирует базовые атомарные компоненты (`Pill`, `useLpPoll`, `useLpRealtime`, `useOpenThreadPanel`), из-за чего каждая комната с UI замыкает цикл обратно на `ui-shell`.
   - **Исправление**: Вынести базовые UI-примитивы и хуки опроса/реалтайма из `ui-shell` в нижний пакет/комнату `ui-primitives`.

2. **[src/rooms/settings/setting-validation.ts:2-8, 57-114](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/setting-validation.ts#L2-L8)** — `Needless links` и `Hidden links`
   - **Почему это неверно**: Платформенная комната `settings` импортирует `LEAD_MODES` из `../lead`, `parseCronExpression` из `../schedule`, `WORKFLOW_PRESETS` из `../workflow/route-workflow` (deep import), `FAILURE_CLASS_MODES` из `../runs/failure-class-judgment` (deep import), `WALL_MODES` из `../wall`, `parseAllowedHours` из `../improvement`. При этом строки 57–114 вручную проверяют `if (key === "plan_critique.min_score")`, `if (key === "code_critique.max_rounds")`, `if (key === "usage.skip_percent")` и т.д., дублируя границы `min`/`max`/`options`, которые уже заданы в `@lane-pilot/settings-catalog`.
   - **Исправление**: Перенести enum-константы и табличную валидацию по метаданным строк в `@lane-pilot/settings-catalog`.

3. **[src/rooms/ui-shell/ui/page-model.ts:121-201, 236-294](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/page-model.ts#L121-L201) и [src/rooms/ui-shell/ui/use-lp-page.tsx:30, 33](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/use-lp-page.tsx#L30-L33)** — `Hidden links` и `Surplus`
   - **Почему это неверно**: В `page-model.ts:121-201` вручную развёрнуты 36 констант ролей (`WRITER_PROVIDER`…`SPECIALIST_SERVICE_TIER`), дублирующих `PAIR_ROLE_SPECS` из [settings/model-keys.ts:15-26](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/model-keys.ts#L15-L26), а на строках 236–294 захардкожены `DEDICATED_KEYS`, `SECTIONED_SETTING_KEYS`, `BASIC_SETTING_KEYS` и `HELP_BY_KEY`. В `use-lp-page.tsx:30, 33` импортируются `DOCS_DEFAULT_SELECTION` (deep import в `docs/docs-defaults`) и все 36 констант ролей, которые **ни разу не используются** в файле!
   - **Исправление**: Удалить мёртвые импорты в `use-lp-page.tsx:30, 33` и генерировать списки ключей/справки из `@lane-pilot/settings-catalog`.

4. **[src/rooms/settings/ui/picker-selections.ts:2-3, 40-58](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/ui/picker-selections.ts#L2-L3) и [src/rooms/settings/server/rpc/settings.ts:147-171](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/settings.ts#L147-L171)** — `Hidden links` и `Special cases`
   - **Почему это неверно**: `picker-selections.ts:40-58` содержит спец-ветки `if (id === "docs")` и `if (id === "projectLife")` (хардкодит `"codex"`, `"gpt-6-luna"`, `"high"` прямо в UI), а `settings.ts:147-171` в `get_screen` вручную проставляет дефолты через `??=`, в обход `SETTING_CATALOG`.
   - **Исправление**: Брать дефолты всех ролей и настроек единообразно из `@lane-pilot/settings-catalog`.

5. **[src/rooms/ui-shell/ui/use-lp-page.tsx:292-370](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/use-lp-page.tsx#L292-L370) и [tab-team.tsx:233-241](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/tab-team.tsx#L233-L241)** — `Hidden links`
   - **Почему это неверно**: Функции `save(row, value)` (`lines 292-332`) и `saveKey(key, value)` (`lines 334-370`) — две 38-строчные копии одного и того же вызова `rpc.call("save_setting", ...)` с обработкой CAS-конфликта и валидации; третья копия написана инлайн в `tab-team.tsx:233-241`.
   - **Исправление**: Выразить `save(row, value)` через `saveKey(row.storageKey, value)` и переиспользовать его в `tab-team.tsx`.

6. **[src/rooms/settings/ui/setting-controls.tsx:93, 96, 101](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/ui/setting-controls.tsx#L93-L101) и [src/rooms/ui-shell/ui/tab-work.tsx:92-94](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/tab-work.tsx#L92-L94)** — `Special cases`
   - **Почему это неверно**: Универсальный рендерер `FieldControl` проверяет `JEV_KEYS.has(row.storageKey)`, подменяя тип контрола на `"switch"` и конвертируя булево значение в `"1"`/`"0"`, а `WorkTab` перехватывает `row.storageKey === "jev.provider"` внутри общего цикла секции.
   - **Исправление**: Описать правильный `control` для JEV-ключей в `@lane-pilot/settings-catalog`.

---

### R4. Консолидировать владение таблицами SQLite, KV-ключами и глобальным состоянием в `src/rooms/storage` (завершение F2)
**Рычаг**: Убирает скрытую связность по сырому SQL (`910` `db.prepare` в `src/rooms`, где основные таблицы читаются напрямую из 20–45 комнат), разрывает прямую зависимость `storage -> @lane-pilot/memory-core`, устраняет утечку глобальных `Map`/`Set` между экземплярами БД и закрывает двойной учёт worktrees.

**Единое исправление (The one fix)**:
1. Разделить 1556-строчный [src/rooms/storage/database.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L1-L1556) на доменные хранилища (`runs-store.ts`, `tasks-store.ts`, `attempts-store.ts`, `stages-store.ts`, `settings-store.ts`, `worktrees-store.ts`), перенести вызовы `@lane-pilot/memory-core` из `transitionAttempt` в подписчика `onAttemptChanged` комнаты `memory` и убрать из `storage/index.ts` реэкспорты `@lane-pilot/memory-core` и `@lane-pilot/workflow-engine`.
2. Перенести сырые SQL-запросы к `lane_pilot_wf_run`/`lane_pilot_wf_step`, `lane_pilot_wall`, `lane_pilot_token_daily`/`lane_pilot_token_cursor`, `lane_pilot_deferral`, `lane_pilot_reconcile_cursor` из чужих комнат (`phase`, `runs`, `writer`, `tasks`, `critique`, `pilot`, `receipts`, `work-graph`) в методы комнат-владельцев (`workflow`, `wall`, `usage`, `deferral`, `stability`, `storage`).
3. Перевести модульные синглтоны `toldDirectly`, `illegalTransitionLog`, `attemptListeners` в `WeakMap<LanePilotDatabase, ...>` (как уже сделано для `settingValidators` на строке 21).

#### Находки, которые закрывает R4:

1. **[src/rooms/storage/database.ts:11, 14, 881-882, 899-921](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L11-L14) и [src/rooms/storage/index.ts:4, 6-15](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/index.ts#L4-L15)** — `Needless links`
   - **Почему это неверно**: Вопреки заявлению F1 в `decision-log.md`, `storage/database.ts` по-прежнему импортирует `dropMemoryIndexes`, `hideRecord`, `noteRefutedByCheck`, `recordMemoryAccepted` из `@lane-pilot/memory-core` и синхронно вызывает их внутри `transitionAttempt`, а `storage/index.ts` реэкспортирует `memory-core` и 18 символов `@lane-pilot/workflow-engine`.
   - **Исправление**: Вызывать `creditMemoryOfAttempt` / `refuteMemoryOfAttempt` через слушателя `onAttemptChanged` в комнате `memory` и удалить реэкспорты из `storage/index.ts`.

2. **[src/rooms/storage/database.ts:649, 816, 820](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L649-L820) и [src/rooms/core/server/spawn-model.ts:34, 44](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/spawn-model.ts#L34-L44)** — `Hidden links`
   - **Почему это неверно**: `toldDirectly` (`line 649`), `illegalTransitionLog` (`line 816`) и `attemptListeners` (`line 820`) в `database.ts`, а также `seenLimits` (`line 34`) и `threadModels` (`line 44`) в `spawn-model.ts` — глобальные коллекции на уровне модуля. При создании нескольких экземпляров `LanePilotDatabase` или `bb.agents` (в тестах, CLI, `memory-eval`) подписки и кэши протекают между независимыми экземплярами.
   - **Исправление**: Привязать эти структуры к экземпляру `LanePilotDatabase` / `bb.agents` через `WeakMap`.

3. **[src/rooms/storage/database.ts:254, 495-503, 814](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L495-L503), [src/rooms/state-machine.ts:6, 112-130](file:///home/ubuntu/BB-service/wt/audit/src/rooms/state-machine.ts#L112-L130), [src/rooms/failure-class.ts:213](file:///home/ubuntu/BB-service/wt/audit/src/rooms/failure-class.ts#L213), [src/rooms/work-graph/logic.ts:37](file:///home/ubuntu/BB-service/wt/audit/src/rooms/work-graph/logic.ts#L37), [src/rooms/phase/server/intake.ts:202, 208, 214](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/intake.ts#L202-L214)** — `Hidden links`
   - **Почему это неверно**:
     - `reviveCanceledAttempt` ([database.ts:495-503](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L495-L503)) делает сырой `UPDATE lane_pilot_attempt SET state='queued' WHERE id=? AND state='canceled'`, нарушая `FINAL_ATTEMPT_STATES = ["accepted", "canceled"]` (`line 814`) и обходя `transitionAttempt` и `attemptListeners`;
     - `failure-class.ts:213` проверяет несуществующий статус `"validating"`;
     - `work-graph/logic.ts:37` хардкодит свой список `ENDED_ATTEMPT` и свои списки стадий `GRAPH_STAGES` (`lines 10-15`);
     - `phase/server/intake.ts:202, 208, 214` хардкодит в SQL `state IN ('running','queued','spawn_requested','spawn_unknown')`, забывая `'waiting_writer'` из `OPEN_ATTEMPT_STATES` ([state-machine.ts:6](file:///home/ubuntu/BB-service/wt/audit/src/rooms/state-machine.ts#L6)).
   - **Исправление**: Свести все переходы (включая `revive`) и наборы состояний (`OPEN_ATTEMPT_STATES`, `TERMINAL_ATTEMPT_STATES`, `HOLDING_ATTEMPT_STATES`) в единый модуль `state-machine` и использовать его во всех запросах.

4. **[src/rooms/storage/database.ts:1517-1555](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L1517-L1555), [src/rooms/storage/worktree-keys.ts:1-22](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/worktree-keys.ts#L1-L22), [src/rooms/core/server/core.ts:147](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/core.ts#L147)** — `Hidden links`
   - **Почему это неверно**: Вопреки записи U7 в `decision-log.md`, функция `ownerKindOfName` ([database.ts:1533-1542](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L1533-L1542)) всё ещё существует и угадывает владельца worktree по префиксу имени (`"docs"`, `"self-repair"`, `"regress"`, `"rollback"`, `"phase"`), а параллельно таблице `lane_pilot_worktree` поддерживаются 3 KV-ключа в `storage/worktree-keys.ts`.
   - **Исправление**: Требовать явный `worktreeOwner` во всех вызовах `gitCreateWorktree`, хранить все открытые worktrees только в `lane_pilot_worktree` и удалить `ownerKindOfName` и `worktree-keys.ts`.

5. **[src/rooms/storage/database.ts:1113, 1180, 1193-1205](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L1113-L1205)** — `Special cases`
   - **Почему это неверно**: Универсальные функции хранилища `casUpsertSetting` и `casUpsertSettings` содержат захардкоженные ключи `writer.provider`, `writer.model`, `writer.reasoning_effort`, `writer.service_tier` и булев параметр `options: { nativeWriterSelection?: boolean }`, нужный только одному сценарию выбора модели райтера.
   - **Исправление**: Вынести групповую проверку связанных ключей в `SettingsValidator` комнаты `settings`.

6. **Прямые SQL-запросы к чужим таблицам в обход комнаты-владельца**:
   - [src/rooms/core/server/core.ts:307](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/core.ts#L307) (`UPDATE lane_pilot_attempt SET cancel_code=?` напрямую в обход `markCancelCode` из [storage/cancel-code.ts:9](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/cancel-code.ts#L9)), [context.ts:30](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/context.ts#L30), [realtime.ts:60, 72](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/realtime.ts#L60-L72);
   - [src/rooms/tools/server/tools.ts:119, 198-199](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tools/server/tools.ts#L119) (`UPDATE lane_pilot_task SET closed_words=?`) и [cli.ts:308, 328](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tools/server/cli.ts#L308-L328);
   - [src/rooms/writer/server/finish.ts:55-61, 442](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/finish.ts#L55-L61) (`areaHasLiveWork` с `json_extract(t.contract_json,'$.area')`), [start.ts:89-91, 107-108, 186-188, 481, 626, 1058, 1065](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L89-L108), [dispatch.ts:102-129, 347, 366, 558](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/dispatch.ts#L102-L129), [dispatch-workflow.ts:333, 353](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/dispatch-workflow.ts#L333-L353);
   - [src/rooms/runs/server/stage-records.ts:128, 145, 162-163](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/stage-records.ts#L128-L163) (запросы к `lane_pilot_reconcile_cursor` и `lane_pilot_wf_run`) и [task-board.ts:169-182](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/task-board.ts#L169-L182) (запрос к `lane_pilot_wf_run`/`lane_pilot_wf_step` с regex `/threadId":"([^"]+)"/`);
   - [src/rooms/tasks/server/conversation-tools.ts:33-53](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tasks/server/conversation-tools.ts#L33-L53) и [queue-tool.ts:36-37, 60](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tasks/server/queue-tool.ts#L36-L60) (включая `lane_pilot_token_daily` комнаты `usage`);
   - [src/rooms/phase/server/driver-docs.ts:112-128](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-docs.ts#L112-L128), [driver-methods.ts:49](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-methods.ts#L49), [driver-steps.ts:186, 311, 333, 453](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-steps.ts#L186-L453), [driver-journal.ts:20-67](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-journal.ts#L20-L67);
   - [src/rooms/critique/server/specialist-graph.ts:63, 75](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/server/specialist-graph.ts#L63-L75) (`lane_pilot_wf_run`);
   - [src/rooms/pilot/store.ts:10-39](file:///home/ubuntu/BB-service/wt/audit/src/rooms/pilot/store.ts#L10-L39) (`lane_pilot_wall`, `lane_pilot_task`, `lane_pilot_attempt`), [src/rooms/receipts/index.ts:19-54](file:///home/ubuntu/BB-service/wt/audit/src/rooms/receipts/index.ts#L19-L54) (6 таблиц), [src/rooms/work-graph/server/report.ts:14, 30-35, 59](file:///home/ubuntu/BB-service/wt/audit/src/rooms/work-graph/server/report.ts#L14-L59) (`lane_pilot_token_cursor`, `lane_pilot_stage_event`). — `Hidden links`
   - **Исправление**: Перенести все эти SQL-запросы в публичные функции репозитория комнаты-владельца таблицы.

7. **Разрозненные строковые шаблоны KV-ключей между комнатами**:
   - [src/rooms/critique/server/specialists.ts:47](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/server/specialists.ts#L47) (собирает `` `lp.role.lines:${projectId}:${role}` `` вручную, тогда как соседний `employee-lessons.ts:13` использует `roleLinesKey` из `native-agent`), [src/rooms/wiring/phase-reactions.ts:10-11](file:///home/ubuntu/BB-service/wt/audit/src/rooms/wiring/phase-reactions.ts#L10-L11) (`DESIGN_JOURNAL`, `ROLE_LINES`), [src/rooms/writer/server/start.ts:206](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L206) (`` `writer-pick:${key}` ``), [src/rooms/writer/server/finish.ts:761, 770](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/finish.ts#L761-L770) (`lp.task.approach:*`, `lp.task.questions:*`), [src/rooms/front/server/index.ts:9-11](file:///home/ubuntu/BB-service/wt/audit/src/rooms/front/server/index.ts#L9-L11), [src/rooms/settings/server/rpc/preferences.ts:19, 34](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/preferences.ts#L19-L34), [server.ts:301-314](file:///home/ubuntu/BB-service/wt/audit/server.ts#L301-L314) (`DRAIN_SNAPSHOT_KEY`). — `Hidden links`
   - **Исправление**: Экспортировать типизированные функции чтения/записи KV из комнаты-владельца каждого ключа.

---

### R5. Заменить парсинг человекочитаемых строк (`reason`, `BOOK.md`, `action.key`, `disposition`, имён RPC) на структурные коды и поля
**Рычаг**: Убирает самый хрупкий класс скрытых связей в репозитории, где изменение формулировки ошибки или текста в одной комнате молча ломает классификацию, ретраи, UI и гейты в другой.

**Единое исправление (The one fix)**:
Передавать и хранить в `transitionAttempt` и возвращаемых типах гейтов явные структурные поля (`failureCode: FailureCode`, `checkName`, `timeoutSec`, `waitsFor`, `wordTurn`, `blocking`), а `failureClass`, `isKnownReason`, `wayOut` и `failureCause` вычислять по единой таблице `Record<FailureCode, ...>` без регулярных выражений по тексту `reason`.

#### Находки, которые закрывает R5:

1. **Четыре параллельные таблицы регулярок + SQL/storage-парсеры для `attempt.reason`**:
   - [src/rooms/failure-class.ts:27-135](file:///home/ubuntu/BB-service/wt/audit/src/rooms/failure-class.ts#L27-L135) (`PATTERNS` — 23 regex),
   - [src/rooms/runs/unknown-codes.ts:5-10](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/unknown-codes.ts#L5-L10) (`KNOWN` — 24 regex),
   - [src/rooms/runs/way-out.ts:17-53](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/way-out.ts#L17-L53) (`WAY_OUT` — 28 regex),
   - [src/rooms/runs/acceptance-stats.ts:39-50, 88](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/acceptance-stats.ts#L39-L50) (`failureCause` и `t.reason LIKE 'waiting_writer:%'`),
   - [src/rooms/storage/database.ts:837-843](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L837-L843) (`failureFieldsFromReason` парсит `verification failed (...): verification timed out after (\d+)s`),
   - [src/rooms/self-repair/server/rule-scan.ts:438](file:///home/ubuntu/BB-service/wt/audit/src/rooms/self-repair/server/rule-scan.ts#L438) (`a.reason LIKE 'verification failed (%'`),
   - [src/rooms/runs/server/rpc/runs.ts:170, 243-246](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/rpc/runs.ts#L170) (`attempt.reason?.includes("merge") || ...` и regex по `result_json`). — `Hidden links`
   - **Почему это неверно**: Хотя в F2 добавили колонки `failure_code`, `check_name`, `timeout_sec`, вызывающий код по-прежнему передаёт текстовый `reason`, `database.ts:837` пытается вытащить поля из текста регуляркой, а 4 файла в `runs` поддерживают 4 отдельных списка регулярок для одних и тех же причин.
   - **Исправление**: Сделать `failureCode` обязательным при переходе в `failed`/`blocked` и заменить все 4 списка регулярок единым словарём по `FailureCode`.

2. **Три копии определения транзиентной ошибки хоста в `memory`, `project-life` и `docs`**:
   - [src/rooms/memory/server/memory.ts:276, 290](file:///home/ubuntu/BB-service/wt/audit/src/rooms/memory/server/memory.ts#L276-L290),
   - [src/rooms/project-life/server/project-life.ts:220, 234](file:///home/ubuntu/BB-service/wt/audit/src/rooms/project-life/server/project-life.ts#L220-L234),
   - [src/rooms/docs/server/docs.ts:206](file:///home/ubuntu/BB-service/wt/audit/src/rooms/docs/server/docs.ts#L206). — `Hidden links`
   - **Почему это неверно**: Во всех трёх файлах скопирован один и тот же блок `catch (cause)` с проверкой `["events_list_error","host","disconnect","ECONN","502"].some((word)=>reason.includes(word))` и логикой реконсиляции дочернего треда стадии.
   - **Исправление**: Вынести общий раннер/обработчик ошибки наблюдения фоновой стадии (`handleStageObservationError`) и классификатор транзиентных ошибок хоста в общий модуль стадий.

3. **[src/rooms/runs/server/task-board.ts:57-62](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/server/task-board.ts#L57-L62) и [src/rooms/writer/server/start.ts:367, 516](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/start.ts#L367)** — `Hidden links`
   - **Почему это неверно**: `task-board.ts` восстанавливает ID блокирующей задачи из текста `writer.reason` регулярками `/waiting for depends_on: ([^\s(]+)/` и `/waiting for (\S+) \(thread/`.
   - **Исправление**: Записывать блокирующий `taskId`/`threadId` структурно в `result` стадии `writer`.

4. **[src/rooms/writer/server/writer-hold.ts:45-61, 130-140](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/writer-hold.ts#L45-L61)** — `Special cases`
   - **Почему это неверно**: `writerHold` формирует строку `owner_present:<providerId>:...`, а в том же файле на строках 130–140 `waitingWriterText` разбирает её обратно через `reason.includes("owner_present")` и regex `/owner_present:([^\s:]+)/`.
   - **Исправление**: Хранить `kind` и `providerId` полями в объекте `WriterHold`.

5. **[src/rooms/phase/server/driver-steps.ts:251-252, 334, 388](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-steps.ts#L251-L252), [driver-methods.ts:144, 183](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/driver-methods.ts#L144), [intake.ts:264](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/server/intake.ts#L264)** — `Hidden links` и `Special cases`
   - **Почему это неверно**: `driver-steps.ts` ищет подстроку `(input ${would.inputSha.slice(0, 12)})` в тексте книги и парсит `action.key` регуляркой `/:word:([a-z]+).../`; `driver-methods.ts:144, 183` ищет подстроку `"owner's word"` в `check.why[0]`; `intake.ts:264` меняет поведение по `input.key.startsWith("lead:")`.
   - **Исправление**: Добавить структурные поля `wordTurn` в `NextAction`, `failedInputSha` в `PhaseRecord.verification` и параметр `decided?: boolean` в `handOver`.

6. **[src/rooms/receipts/index.ts:75, 80-82](file:///home/ubuntu/BB-service/wt/audit/src/rooms/receipts/index.ts#L75-L82) и [src/rooms/run-goal/server/run-goal.ts:32](file:///home/ubuntu/BB-service/wt/audit/src/rooms/run-goal/server/run-goal.ts#L32)** — `Special cases`
   - **Почему это неверно**: В `receipts/index.ts:75` булев гейт `clear` вычисляется как `item.disposition === "keep with its term"`, а в `run-goal.ts:32` проверяется мёртвый префикс `verdict.detail?.startsWith("the check failed:")`.
   - **Исправление**: Заменить сравнение английской прозы в `receipts` на булево поле `blocking: boolean`, а в `run-goal.ts:32` поставить `failureCode: null`.

7. **[src/rooms/front/logic.ts:65](file:///home/ubuntu/BB-service/wt/audit/src/rooms/front/logic.ts#L65)** — `Hidden links`
   - **Почему это неверно**: Регулярное выражение `MUTATING_RPC = /^(save_|reset_|set_|...)/` пытается угадать по префиксу имени метода, мутирует ли RPC состояние.
   - **Исправление**: Помечать мутирующие методы явно в контракте/регистрации RPC.

---

### R6. Устранить утечки проектно-специфичных, машинно-специфичных и провайдерно-специфичных хардкодов из общих модулей (завершение F3 и F7)
**Рычаг**: Очищает базовые слои (`@lane-pilot/kit`, `src/rooms/contracts`, `src/rooms/core`, `src/rooms/failure-class.ts`, `src/rooms/verification`, `src/rooms/writer`) от хардкодов игры Vampirism Fire / Roblox Studio, личных серверов (`mac-mini`, `ovh`, `windows`), личного треда разработчика (`thr_2spsxrsutt`), тестовой фикстуры `hello.txt` и проверок `providerId === "opencode2" | "codex" | "claude-code"`.

**Единое исправление (The one fix)**:
Перенести проектные паттерны ошибок и команды гейтов в настройки проекта, личные пути и тестовые проверки — в тесты, а различия провайдеров (`opencode2`, `codex`, `claude-code`) — в декларативную таблицу возможностей провайдеров в `@lane-pilot/models` / `native-agent`.

#### Находки, которые закрывает R6:

1. **[src/rooms/failure-class.ts:187-206](file:///home/ubuntu/BB-service/wt/audit/src/rooms/failure-class.ts#L187-L206) и [src/rooms/verification/server/gate-detect.ts:21, 63-64](file:///home/ubuntu/BB-service/wt/audit/src/rooms/verification/server/gate-detect.ts#L21)** — `Special cases`
   - **Почему это неверно**: Общий классификатор продукта хардкодит регулярки конкретного Roblox-проекта (`Unable to reach Roblox Studio`, `No Roblox Studio instances are connected`, `studio_id is not connected`, `Server datamodel is not available in Edit mode`, `did not load MapData within \d+s`, `studio\.lock`, `FAIL DebugHook missing`), а `gate-detect.ts` хардкодит `scripts/studio_test.py` и `cd game && python3 -I scripts/studio_test.py`.
   - **Исправление**: Вынести проектные паттерны окружения и команду гейта в настройки проекта.

2. **[packages/kit/src/paths.ts:41-46](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/paths.ts#L41-L46), [packages/kit/src/jsonc.ts:1-134](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/jsonc.ts#L1-L134), [packages/kit/src/bounded-read.ts:1-149](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/bounded-read.ts#L1-L149), [packages/kit/src/redact.ts:118](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/redact.ts#L118)** — `Special cases` и `Needless links`
   - **Почему это неверно**: В базовом пакете `@lane-pilot/kit` функция `defaultLocalFallback` хардкодит личный путь чата разработчика `.bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack` ([paths.ts:45](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/paths.ts#L45)), `jsonc.ts` хардкодит пути плагинов OpenCode, `bounded-read.ts` реализует инструмент `lane_pilot_read`, а `redact.ts:118` вырезает `[lane-pilot-selection:...]`.
   - **Исправление**: Удалить `defaultLocalFallback` и перенести `jsonc.ts`, `bounded-read.ts` и `withoutSelectionMarkers` в `native-install`, `host-worker` и `native-agent`.

3. **[src/rooms/writer/server/verify.ts:542-551](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/verify.ts#L542-L551)** — `Special cases`
   - **Почему это неверно**: Продакшн-валидатор `validateWriterResult` проверяет `if (input.task.expected_outputs.includes("hello.txt") && input.task.expected_outputs.includes("tests/hello.test.txt"))` и сверяет содержимое файла со строкой `"hello from native BB writer\n"`.
   - **Исправление**: Удалить этот тестовый `if` из продакшн-кода `verify.ts` и проверять содержимое файла командой `verification` в самом тесте.

4. **[src/rooms/core/server/spawn-model.ts:54, 73-117](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/spawn-model.ts#L73-L117)** — `Special cases`
   - **Почему это неверно**: Вопреки записи F7 в `decision-log.md`, `spawn-model.ts` всё ещё содержит `DOCUMENTS_FOLDER = /^\/Users\/[^/]+\/Documents(\/|$)/` и `PROVIDER_DOCUMENTS_SENSITIVE = new Set(["opencode2"])`.
   - **Исправление**: Перенести ограничения провайдера в декларативные метаданные провайдера.

5. **[src/rooms/contracts/rpc-shell.ts:17, 151, 172](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/rpc-shell.ts#L17) и [src/rooms/contracts/server-core.ts:127](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/server-core.ts#L127)** — `Special cases`
   - **Почему это неверно**: В 4 местах контракта захардкожен enum имён личных серверов `["mac-mini", "ovh", "windows", "any"]`.
   - **Исправление**: Вынести единый тип/схему `machineAffinitySchema` и ослабить проверку в контракте до идентификатора хоста.

6. **Разрозненные проверки `providerId === ...` по комнатам**:
   - [server.ts:262](file:///home/ubuntu/BB-service/wt/audit/server.ts#L262) (`OPENCODE_WRITER_PROVIDER`), [src/rooms/core/server/pm-spawn.ts:94-128](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/pm-spawn.ts#L94-L128) (`args.providerId !== "opencode2"`), [src/rooms/writer/server/state.ts:29](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/state.ts#L29) (`providerId === "opencode2" && model.startsWith("router9/")`), [src/rooms/writer/server/writer-task.ts:451](file:///home/ubuntu/BB-service/wt/audit/src/rooms/writer/server/writer-task.ts#L451) (`providerForwardsAgentOnly`), [src/rooms/wall/server/wall.ts:183](file:///home/ubuntu/BB-service/wt/audit/src/rooms/wall/server/wall.ts#L183), [src/rooms/project-life/project-life.ts:8](file:///home/ubuntu/BB-service/wt/audit/src/rooms/project-life/project-life.ts#L8), [src/rooms/native-agent/server/helper-bb-shim.ts:83](file:///home/ubuntu/BB-service/wt/audit/src/rooms/native-agent/server/helper-bb-shim.ts#L83), [src/rooms/harness/server/harness.ts:311](file:///home/ubuntu/BB-service/wt/audit/src/rooms/harness/server/harness.ts#L311), [src/rooms/qa/server/qa.ts:43, 121, 159, 221](file:///home/ubuntu/BB-service/wt/audit/src/rooms/qa/server/qa.ts#L43). — `Special cases`
   - **Исправление**: Свести свойства провайдеров (`supportsFastTier`, `forwardsAgentOnly`, `supportsHookSettings`, `requiresWorkerHome`, `usageProviderOf`) в единую таблицу возможностей провайдеров в `@lane-pilot/models`.

---

### R7. Влить 20+ микро-комнат и вынести тестовые/скриптовые комнаты из `src/rooms/` (выполнение F9)
**Рычаг**: Сокращает число комнат с 88 до ~55, убирает десятки искусственных межкомнатных рёбер и очищает `src/rooms/` от утилит, которые вызываются только из `scripts/` или `tests/`.

**Единое исправление (The one fix)**:
Перенести не-рантайм комнаты (`atlas`, `twins`, `guard-tools`) в `scripts/` и `tests/helpers/`, а однофайловые микро-комнаты с единственным потребителем (`world`, `conveyor`, `wiring`, `wires`, `validators`, `permits`, `pilot`, `receipts`, `work-graph`, `outbound`, `self-improve`, `world-assets`) влить в их родительские комнаты, обновив [src/rooms/coverage/registry.ts](file:///home/ubuntu/BB-service/wt/audit/src/rooms/coverage/registry.ts#L76-L133).

#### Находки, которые закрывает R7:

1. **Тестовые и скриптовые модули, оформленные как продакшн-комнаты в `src/rooms/` (`fanIn: 0` из `src/rooms`)**:
   - [src/rooms/atlas/index.ts:1-4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/atlas/index.ts#L1-L4) и [logic.ts:1-104](file:///home/ubuntu/BB-service/wt/audit/src/rooms/atlas/logic.ts#L1-L104) (108 LOC, вызывается только из `scripts/generate-atlas.ts` и `tests/atlas.test.ts`),
   - [src/rooms/twins/index.ts:1-4](file:///home/ubuntu/BB-service/wt/audit/src/rooms/twins/index.ts#L1-L4) и [logic.ts:1-34](file:///home/ubuntu/BB-service/wt/audit/src/rooms/twins/logic.ts#L1-L34) (38 LOC, вызывается только из `tests/twins.test.ts`),
   - [src/rooms/guard-tools/index.ts:1-38](file:///home/ubuntu/BB-service/wt/audit/src/rooms/guard-tools/index.ts#L1-L38) (38 LOC, тестовые списки `UNSHOWN_FIELDS`, `leaks`, `parityGaps`). — `Surplus`
   - **Исправление**: Перенести `atlas` в `scripts/`, а `twins` и `guard-tools` — в `tests/helpers/`.

2. **Однофайловые/микро-комнаты, не имеющие собственной оси изменений**:
   - [src/rooms/conveyor/logic.ts:1-21](file:///home/ubuntu/BB-service/wt/audit/src/rooms/conveyor/logic.ts#L1-L21) (25 LOC — один булев флаг в KV для паузы ранов в `runs`),
   - [src/rooms/world/migrations.ts:1-15](file:///home/ubuntu/BB-service/wt/audit/src/rooms/world/migrations.ts#L1-L15) (18 LOC — только один `CREATE TABLE lane_pilot_world`, без логики, сервера и UI),
   - [src/rooms/wiring/phase-reactions.ts:1-43](file:///home/ubuntu/BB-service/wt/audit/src/rooms/wiring/phase-reactions.ts#L1-L43) (46 LOC — адаптер `PhaseReactions` для `phase`),
   - [src/rooms/outbound/index.ts:1-51](file:///home/ubuntu/BB-service/wt/audit/src/rooms/outbound/index.ts#L1-L51) (51 LOC — санитайзер исходящих сообщений для `relay`),
   - [src/rooms/wires/logic.ts:1-48](file:///home/ubuntu/BB-service/wt/audit/src/rooms/wires/logic.ts#L1-L48) (52 LOC — генератор одной `git grep` команды для `verification`),
   - [src/rooms/self-improve/index.ts:1-65](file:///home/ubuntu/BB-service/wt/audit/src/rooms/self-improve/index.ts#L1-L65) (65 LOC — часть `improvement` / `self-repair`),
   - [src/rooms/world-assets/index.ts:1-65](file:///home/ubuntu/BB-service/wt/audit/src/rooms/world-assets/index.ts#L1-L65) (65 LOC),
   - [src/rooms/receipts/index.ts:1-92](file:///home/ubuntu/BB-service/wt/audit/src/rooms/receipts/index.ts#L1-L92) (92 LOC — сводка по таблицам `runs` и `deferral`),
   - [src/rooms/permits/index.ts:1-102](file:///home/ubuntu/BB-service/wt/audit/src/rooms/permits/index.ts#L1-L102) (102 LOC — KV-разрешения для `verification`/`writer`),
   - [src/rooms/pilot/logic.ts:1-78](file:///home/ubuntu/BB-service/wt/audit/src/rooms/pilot/logic.ts#L1-L78) и [store.ts:1-40](file:///home/ubuntu/BB-service/wt/audit/src/rooms/pilot/store.ts#L1-L40) (123 LOC — вызывается ровно в одном месте `writer/server/start.ts:320`),
   - [src/rooms/validators/deliverable.ts:1-288](file:///home/ubuntu/BB-service/wt/audit/src/rooms/validators/deliverable.ts#L1-L288) (291 LOC — часть `verification`),
   - [src/rooms/work-graph/logic.ts:1-187](file:///home/ubuntu/BB-service/wt/audit/src/rooms/work-graph/logic.ts#L1-L187) (287 LOC — отчёт стадий задачи для `runs`). — `Surplus`
   - **Исправление**: Влить каждую микро-комнату в её комнату-владельца (`runs`, `storage`, `phase`, `relay`, `verification`, `self-repair`, `tasks`).

---

### R8. Заменить безмолвное проглатывание ошибок (`.catch(() => …)` / `catch {}`) на именованные границы ошибок (выполнение F8)
**Рычаг**: Устраняет риск тихой потери данных в KV (где ошибка чтения превращается в перезапись истории пустым массивом) и маскировки сбоев SQLite/FS/RPC в **56 комнатах** (`977` `.catch(() => …)` и `202` тривиальных/пустых `catch`).

**Единое исправление (The one fix)**:
Запретить `.catch(() => null)` перед модифицирующей записью в KV (`read-modify-write`), в файловых хелперах (`sha256FileOrNull`) перехватывать только `ENOENT`, а для ожидаемых ошибок фоновых задач и RPC использовать единый хелпер `ignoreStoppedOrLog(ctx, label)`, логирующий неожиданные ошибки через `ctx.log`.

#### Ключевые находки, которые закрывает R8 (полная таблица по всем комнатам — в Разделе 3):

1. **Баг потери данных при `read-modify-write` в KV из-за `.catch(() => null)`**:
   - [src/rooms/wiring/phase-reactions.ts:16-17, 20-21, 29-30](file:///home/ubuntu/BB-service/wt/audit/src/rooms/wiring/phase-reactions.ts#L16-L30) (`const lines = ((await kv.get(DESIGN_JOURNAL).catch(() => null)) as ... | null) ?? []; await kv.set(DESIGN_JOURNAL, [...lines, line]);`),
   - [src/rooms/front/server/index.ts:73-76, 103-105](file:///home/ubuntu/BB-service/wt/audit/src/rooms/front/server/index.ts#L73-L105) (`PEERS` и `ACTIONS`). — `Special cases`
   - **Почему это неверно**: При временном сбое чтения KV `.catch(() => null)` возвращает `null`, `?? []` подставляет пустой массив, и следующий `kv.set` **затирает всю историю журнала в KV** одной новой записью!
   - **Исправление**: Не перехватывать ошибку чтения KV перед записью (`kv.get` должен пробрасывать ошибку, если ключ не удалось прочитать).

2. **[src/rooms/conveyor/logic.ts:12](file:///home/ubuntu/BB-service/wt/audit/src/rooms/conveyor/logic.ts#L12)** — `Special cases`
   - **Почему это неверно**: `await kv.get(CONVEYOR_OFF_KEY).catch(() => null)` при сбое KV возвращает `null`, что интерпретируется как `{ on: true }` — т.е. упавшее хранилище молча **включает** остановленный владельцем конвейер!
   - **Исправление**: Пробрасывать ошибку чтения KV (или считать конвейер остановленным при недоступности KV).

3. **[packages/kit/src/hash.ts:60-66](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/hash.ts#L60-L66)** — `Special cases`
   - **Почему это неверно**: `sha256FileOrNull` делает безусловный `catch { return null; }`, маскируя ошибки прав доступа (`EACCES`) и сбои диска (`EIO`) под «файл не существует» (прямо упоминалось в F8 `decision-log.md`, но осталось в коде).
   - **Исправление**: Возвращать `null` только при `(err as NodeJS.ErrnoException)?.code === "ENOENT"`, иначе пробрасывать исключение.

4. **Подавление ошибок в `settings`, `validators`, `permits`, `rollback`, `server.ts`, `cli.ts`**:
   - [src/rooms/settings/server/rpc/settings.ts:62, 65, 69, 70, 73, 232, 326, 333, 344](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/settings.ts#L62-L73), [preferences.ts:57, 78, 88, 125, 143](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/preferences.ts#L57-L143), [role-models.ts:23](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/role-models.ts#L23), [src/rooms/validators/deliverable.ts:35-281](file:///home/ubuntu/BB-service/wt/audit/src/rooms/validators/deliverable.ts#L35-L281) (18 `.catch(() => null)`), [src/rooms/permits/index.ts:14-97](file:///home/ubuntu/BB-service/wt/audit/src/rooms/permits/index.ts#L14-L97) (8 подавленных ошибок), [src/rooms/rollback/server/rollback.ts:191, 346, 357, 365](file:///home/ubuntu/BB-service/wt/audit/src/rooms/rollback/server/rollback.ts#L191), [server.ts:96, 121, 192, 194](file:///home/ubuntu/BB-service/wt/audit/server.ts#L96-L194), [src/rooms/tools/server/cli.ts:304, 335, 509, 579](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tools/server/cli.ts#L304-L579). — `Special cases`
   - **Исправление**: Логировать нетривиальные ошибки через `ctx.log` перед возвратом fallback-значения.

---

### R9. Устранить дублирующиеся константы, утилиты и мёртвый код между комнатами и пакетами
**Рычаг**: Убирает рассинхронизацию копий одной и той же формулы (`taskFamily`, `MAIN_ATTEMPT_LIMIT`, `CANCEL_CODES`, `REASONING_LEVEL`, `sha256`, `stripAnsi`, `settingOff`) и очищает мёртвые выражения.

**Единое исправление (The one fix)**:
Оставить ровно одно определение для каждой общей константы/функции в `@lane-pilot/kit` или `@lane-pilot/contracts` и удалить локальные копии и мёртвый код.

#### Находки, которые закрывает R9:

1. **Четыре расходящиеся реализации `taskFamily` / `isMainfixTask`**:
   - [src/rooms/failure-class.ts:168-175](file:///home/ubuntu/BB-service/wt/audit/src/rooms/failure-class.ts#L168-L175) (срезает `.N` и `-mainfix`),
   - [src/rooms/storage/database.ts:576, 602](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/database.ts#L576-L602) (на строке 6 уже импортирует `taskFamily`, но на строке 576 объявляет локальную копию `family`, а на строке 602 — неполную копию `taskId.replace(/(\.\d+)+$/, "")` без `-mainfix`!),
   - [src/rooms/pilot/logic.ts:27](file:///home/ubuntu/BB-service/wt/audit/src/rooms/pilot/logic.ts#L27) и [src/rooms/pilot/store.ts:16](file:///home/ubuntu/BB-service/wt/audit/src/rooms/pilot/store.ts#L16),
   - [src/rooms/runs/acceptance-stats.ts:111-112](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/acceptance-stats.ts#L111-L112). — `Hidden links`
   - **Исправление**: Вынести `taskFamily` и `isMainfixTask` в `@lane-pilot/contracts` и вызывать их везде.

2. **[src/rooms/runs/constants.ts:1-37](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/constants.ts#L1-L37) и [src/rooms/state-machine.ts:77](file:///home/ubuntu/BB-service/wt/audit/src/rooms/state-machine.ts#L77)** — `Hidden links` и `Needless links`
   - **Почему это неверно**: `MAIN_ATTEMPT_LIMIT = 2` объявлен дважды, а в `runs/constants.ts:1-25, 36` лежат константы `native-install` (`TARGET_SHA`, `UPSTREAM_REPO`, `S8_RELATIVE_PATHS`, `EXTERNAL_OPS`, `INSTALLED_GUARD`), заставляющие `native-install` импортировать `runs`.
   - **Исправление**: Перенести константы установки в `src/rooms/native-install/`, а `MAIN_ATTEMPT_LIMIT` экспортировать из одного места.

3. **[packages/kit/src/hash.ts:6-11](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/hash.ts#L6-L11), [packages/kit/src/bounded-read.ts:70](file:///home/ubuntu/BB-service/wt/audit/packages/kit/src/bounded-read.ts#L70), [packages/contracts/src/stage-contract.ts:29-31](file:///home/ubuntu/BB-service/wt/audit/packages/contracts/src/stage-contract.ts#L29-L31), [src/rooms/phase/logic.ts:162](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/logic.ts#L162), [src/rooms/phase/stages.ts:238](file:///home/ubuntu/BB-service/wt/audit/src/rooms/phase/stages.ts#L238)** — `Surplus` и `Hidden links`
   - **Почему это неверно**: Пять разных обёрток и алиасов (`sha256Hex`, `sha256Buffer = sha256Hex`, `sha256`, `sha`) вокруг одного и того же SHA-256.
   - **Исправление**: Использовать `sha256Hex` из `@lane-pilot/kit` и удалить остальные обёртки.

4. **[src/rooms/contracts/rpc-ops.ts:23](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/rpc-ops.ts#L23) vs [src/rooms/storage/cancel-code.ts:3](file:///home/ubuntu/BB-service/wt/audit/src/rooms/storage/cancel-code.ts#L3); [src/rooms/contracts/rpc-settings.ts:5, 157, 166](file:///home/ubuntu/BB-service/wt/audit/src/rooms/contracts/rpc-settings.ts#L157-L166); [src/rooms/tools/server/tools.ts:99-103, 137-141, 171-175, 213-217, 247-250](file:///home/ubuntu/BB-service/wt/audit/src/rooms/tools/server/tools.ts#L99-L250); [src/rooms/critique/code-critique.ts:13, 167-170](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/code-critique.ts#L13) и [critique-runs.ts:50-53](file:///home/ubuntu/BB-service/wt/audit/src/rooms/critique/server/critique-runs.ts#L50-L53); [src/rooms/front/server/index.ts:72, 90](file:///home/ubuntu/BB-service/wt/audit/src/rooms/front/server/index.ts#L72-L90) и [src/rooms/settings/server/rpc/settings.ts:62](file:///home/ubuntu/BB-service/wt/audit/src/rooms/settings/server/rpc/settings.ts#L62)** — `Hidden links`
   - **Почему это неверно**: Дублируются `CANCEL_CODES`, `REASONING_LEVEL`, 5-строчная проверка PM-треда в `tools.ts`, `stripAnsi`, `settingOff` и двойной каст `(bb.sdk as unknown as { hosts: ... }).hosts.list()`.
   - **Исправление**: Вынести каждый из этих фрагментов в один общий хелпер.

5. **[src/rooms/runs/failure-class-model.ts:102](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/failure-class-model.ts#L102) и [src/rooms/runs/way-out.ts:59](file:///home/ubuntu/BB-service/wt/audit/src/rooms/runs/way-out.ts#L59)** — `Surplus`
   - **Почему это неверно**: На строке `failure-class-model.ts:102` вычисляется мёртвое выражение `code[verdict === "done" ? "1" : ""]` с `void compared;`, а в `way-out.ts:59` принимается неиспользуемый параметр `state: string` (`void state;`).
   - **Исправление**: Удалить мёртвую строку `102` и неиспользуемый параметр `state`.

---

### R10. Очистить `sma-map` и тестовый набор от проверок по подстрокам исходного кода (`readFileSync`) и 423 пустых `.todo` (завершение F4 и F9)
**Рычаг**: Переводит верификацию архитектуры с хрупкого поиска подстрок в исходниках на проверку реального поведения и публичных экспортов.

**Единое исправление (The one fix)**:
1. В [src/rooms/sma-map/model.ts:108-118](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/model.ts#L108-L118) проверять якоря `entries.ts` через таблицу реальных экспортов (или AST публичных символов), а не через `readFileSync(full, "utf8").includes(symbol)` по внутренним строкам функций, и выводить `TABLE_CLOCKS` в [sma-map/live.ts:191-227](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/live.ts#L191-L227) автоматически из `PRAGMA table_info(...)`.
2. Заменить `readFileSync("src/...")` в 85 тестовых файлах на вызовы тестируемых функций, удалить или реализовать 423 заглушки `it.todo(...)` в `tests/sma/*.todo.test.ts` и объединить [scripts/room-graph.mjs](file:///home/ubuntu/BB-service/wt/audit/scripts/room-graph.mjs#L1-L97) с AST-графом [scripts/refactor/graph.ts](file:///home/ubuntu/BB-service/wt/audit/scripts/refactor/graph.ts#L1-L240).

#### Находки, которые закрывает R10:

1. **[src/rooms/sma-map/model.ts:108-118](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/model.ts#L108-L118), [src/rooms/sma-map/entries.ts:347-1809](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/entries.ts#L347-L1809), [src/rooms/sma-map/live.ts:191-227](file:///home/ubuntu/BB-service/wt/audit/src/rooms/sma-map/live.ts#L191-L227)** — `Hidden links`
   - **Почему это неверно**: Вопреки заявлению F4 в `decision-log.md`, `brokenProof` всё ещё читает файлы через `readFileSync` и ищет в них буквальные строки локального кода (`#if (waiting.length) return waiting;`, `#sha256: sha256(hashes.join`). Любое переименование локальной переменной или перенос функции при декомпозиции ломает `sma-map`. А `TABLE_CLOCKS` вручную дублирует список из 110+ таблиц SQLite.
   - **Исправление**: Привязать `entries.ts` к публичным экспортам модулей, а `TABLE_CLOCKS` строить по схеме SQLite.

2. **85 тестовых файлов, читающих исходники `src/` через `readFileSync`, 1 `it.skip` и 423 `it.todo` в `tests/`** (например, [tests/plugin.test.ts:1825](file:///home/ubuntu/BB-service/wt/audit/tests/plugin.test.ts#L1825) (`it.skip`), `tests/sma/*.todo.test.ts` (423 `it.todo`)) — `Special cases` и `Hidden links`
   - **Почему это неверно**: Тесты проверяют наличие текста в файле вместо поведения кода, а 423 `.todo`-теста создают иллюзию покрытия SMA.
   - **Исправление**: Проверять поведение вызовом функций и удалить пустые `.todo`-файлы.

---

## 3. Полная покомнатная таблица подавленных исключений (`.catch(() => …)` и `catch {}`) и `db.prepare` в `src/rooms`

Ниже приведены точные числа по всем узлам `src/rooms` на коммите `3b87083f`:
- **`.catch(() => …)`**: `977` в `src/rooms` (`990` включая `packages/`)
- **Тривиальные `catch { return … }` / пустые `catch {}`**: `202` в `src/rooms` (из них `12` абсолютно пустых `catch {}` и `169` без переменной ошибки)
- **Прямые вызовы `.prepare(...)`**: `910` в `src/rooms` (`1 121` включая `packages/`)

| Комната / узел (`src/rooms`) | `.catch(() => …)` | Тривиальные `catch` (из них пустых `catch {}`) | Всего подавленных `catch` | Вызовы `db.prepare(...)` |
| :--- | ---: | ---: | ---: | ---: |
| `writer` | 145 | 15 (3 пустых) | **160** | 44 |
| `verification` | 115 | 5 (1 пустой) | **120** | 7 |
| `workflow` | 64 | 14 (0 пустых) | **78** | 24 |
| `docs` | 68 | 2 (0 пустых) | **70** | 3 |
| `wall` | 40 | 10 (0 пустых) | **50** | 65 |
| `self-repair` | 38 | 6 (0 пустых) | **44** | 31 |
| `native-agent` | 29 | 12 (1 пустой) | **41** | 10 |
| `critique` | 35 | 6 (1 пустой) | **41** | 7 |
| `phase` | 31 | 8 (0 пустых) | **39** | 26 |
| `stability` | 36 | 1 (0 пустых) | **37** | 17 |
| `bench` | 29 | 2 (0 пустых) | **31** | 44 |
| `core` | 23 | 8 (0 пустых) | **31** | 4 |
| `relay` | 28 | 2 (0 пустых) | **30** | 1 |
| `native-install` | 17 | 12 (2 пустых) | **29** | 0 |
| `runs` | 24 | 3 (0 пустых) | **27** | 62 |
| `schedule` | 19 | 5 (0 пустых) | **24** | 31 |
| `baseline` | 20 | 2 (0 пустых) | **22** | 20 |
| `lead` | 12 | 9 (0 пустых) | **21** | 42 |
| `learning` | 18 | 3 (0 пустых) | **21** | 38 |
| `anamnesis` | 8 | 12 (0 пустых) | **20** | 5 |
| `validators` | 18 | 0 (0 пустых) | **18** | 0 |
| `host-worker` | 14 | 2 (0 пустых) | **16** | 0 |
| `night-graphs` | 12 | 2 (0 пустых) | **14** | 12 |
| `memory` | 9 | 4 (0 пустых) | **13** | 12 |
| `council` | 6 | 7 (2 пустых) | **13** | 1 |
| `usage` | 10 | 2 (0 пустых) | **12** | 24 |
| `ui-shell` | 11 | 1 (0 пустых) | **12** | 0 |
| `errands` | 5 | 6 (0 пустых) | **11** | 17 |
| `harness` | 9 | 1 (0 пустых) | **10** | 22 |
| `checkers` | 7 | 1 (0 пустых) | **8** | 10 |
| `cockpit` | 8 | 0 (0 пустых) | **8** | 10 |
| `qa` | 7 | 1 (0 пустых) | **8** | 4 |
| `settings` | 4 | 4 (0 пустых) | **8** | 0 |
| `tools` | 7 | 0 (0 пустых) | **7** | 4 |
| `outage` | 7 | 0 (0 пустых) | **7** | 3 |
| `permits` | 7 | 0 (0 пустых) | **7** | 0 |
| `pm-replay` | 3 | 3 (0 пустых) | **6** | 12 |
| `front` | 6 | 0 (0 пустых) | **6** | 0 |
| `rollback` | 4 | 1 (0 пустых) | **5** | 8 |
| `owner-waiting` | 2 | 2 (0 пустых) | **4** | 20 |
| `tasks` | 2 | 2 (1 пустой) | **4** | 7 |
| `session-hooks` | 0 | 4 (0 пустых) | **4** | 0 |
| `storage` | 0 | 3 (0 пустых) | **3** | 139 |
| `improvement` | 1 | 2 (0 пустых) | **3** | 6 |
| `capability` | 3 | 0 (0 пустых) | **3** | 5 |
| `forge` | 1 | 2 (1 пустой) | **3** | 0 |
| `wiring` | 3 | 0 (0 пустых) | **3** | 0 |
| `memory-eval` | 0 | 2 (0 пустых) | **2** | 13 |
| `rule-forms` | 1 | 1 (0 пустых) | **2** | 13 |
| `deferral` | 1 | 1 (0 пустых) | **2** | 6 |
| `stage-return` | 1 | 1 (0 пустых) | **2** | 4 |
| `world` | 0 | 2 (0 пустых) | **2** | 4 |
| `pilot` | 0 | 2 (0 пустых) | **2** | 3 |
| `owner-presence` | 2 | 0 (0 пустых) | **2** | 0 |
| `memory-tiers` | 0 | 1 (0 пустых) | **1** | 10 |
| `backlog` | 1 | 0 (0 пустых) | **1** | 7 |
| `hypotheses` | 0 | 1 (0 пустых) | **1** | 7 |
| `work-graph` | 1 | 0 (0 пустых) | **1** | 5 |
| `acceptance` | 1 | 0 (0 пустых) | **1** | 2 |
| `money` | 0 | 1 (0 пустых) | **1** | 1 |
| `conveyor` | 1 | 0 (0 пустых) | **1** | 0 |
| `@dirt-snapshot.ts` | 0 | 1 (0 пустых) | **1** | 0 |
| `@failure-class.ts` | 0 | 1 (0 пустых) | **1** | 0 |
| `night` | 1 | 0 (0 пустых) | **1** | 0 |
| `project-life` | 1 | 0 (0 пустых) | **1** | 0 |
| `secrets` | 0 | 1 (0 пустых) | **1** | 0 |
| `world-assets` | 1 | 0 (0 пустых) | **1** | 0 |
| `receipts` | 0 | 0 (0 пустых) | **0** | 10 |
| `policy` | 0 | 0 (0 пустых) | **0** | 8 |
| `memory-probe` | 0 | 0 (0 пустых) | **0** | 5 |
| `run-goal` | 0 | 0 (0 пустых) | **0** | 4 |
| `sma-map` | 0 | 0 (0 пустых) | **0** | 4 |
| `forecast` | 0 | 0 (0 пустых) | **0** | 3 |
| `self-improve` | 0 | 0 (0 пустых) | **0** | 3 |
| `jev` | 0 | 0 (0 пустых) | **0** | 1 |
| **ИТОГО (`src/rooms`)** | **977** | **202 (12 пустых)** | **1 179** | **910** |

---

## 4. Что НЕ стоит исправлять и почему (Not Worth Fixing)

1. **Двухуровневое разделение `packages/contracts` (`@lane-pilot/contracts`) и `src/rooms/contracts`**:
   - *Почему не трогать*: `@lane-pilot/contracts` содержит чистые доменные схемы задач и стадий (`taskV2Schema`, `STAGE_CONTRACT`, `STAGE_PROOF`, `STAGE_INPUTS`), которые переиспользуются изолированными пакетами (`@lane-pilot/workflow-engine`, `@lane-pilot/gates`, `@lane-pilot/critique`) без зависимости от RPC/Host-протокола плагина. Сливать их в одну папку не нужно — нужно лишь убрать из `src/rooms/contracts` восходящие импорты в `anamnesis` и `schedule` (R1).
2. **Внутреннее разделение `src/rooms/phase/server/driver*.ts` (`driver.ts`, `driver-methods.ts`, `driver-steps.ts`, `driver-docs.ts`, `driver-journal.ts`, `driver-wiring.ts`) и `src/rooms/host-worker/handlers/*.ts`**:
   - *Почему не трогать*: В волнах F5 (U8) и F6 эти два бывших монолита (1 545 LOC и 1 265 LOC) были разделены по реальным осям изменений: команды PM, автоматический шаг фазы, файловый ввод-вывод книги, проверка независимости и 10 независимых доменов RPC хоста (`git`, `stack`, `docs`, `writes`, `fs`, `machine`, `jobs`, `judges`, `exec`, `desktop`). Их внутренняя модульная граница чистая.
3. **Разделение публичных точек входа комнаты на `index.ts` (изоморфный/клиентский) и `server/index.ts` (серверный)**:
   - *Почему не трогать*: Браузерный бандл (`app.tsx`) импортирует `src/rooms/<room>`, а `server/index.ts` изолирует `better-sqlite3` и серверные SDK-вызовы от попадания в UI-бандл (проверяется тестом [boundaries.test.ts:81-105](file:///home/ubuntu/BB-service/wt/audit/tests/architecture/boundaries.test.ts#L81-L105)).
4. **Генерация плоской JSON-схемы `flatParameters` в [src/rooms/core/server/action-schema.ts:47-61](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/action-schema.ts#L47-L61)**:
   - *Почему не трогать*: Хост-платформа BB отбрасывает ветки top-level `discriminatedUnion` при публикации схемы инструмента модели, поэтому генерация плоской JSON-схемы для регистрации + строгая проверка `checkArguments` по полной Zod-схеме ветки при вызове — оправданный адаптер к платформе.
5. **Централизованный перехват `bb.log` в [src/rooms/core/server/core.ts:39-47](file:///home/ubuntu/BB-service/wt/audit/src/rooms/core/server/core.ts#L39-L47)**:
   - *Почему не трогать*: Единая точка редактирования секретов (`redactText`) гарантирует, что ни один токен не попадёт в логи даже при прямом вызове `bb.log.*`.
6. **Ленивое монтирование вкладок через `visited.current.has(id)` в [src/rooms/ui-shell/ui/page.tsx:108-113](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/page.tsx#L108-L113) и сериализация `queueSelection` в [use-lp-page.tsx:487-503](file:///home/ubuntu/BB-service/wt/audit/src/rooms/ui-shell/ui/use-lp-page.tsx#L487-L503)**:
   - *Почему не трогать*: Первое предотвращает одновременный рендер ~25 000 DOM-узлов на крупных проектах, а второе защищает от двойного `onChange` внешнего компонента `ProviderModelPicker` (провайдер + модель в одном тике), который без очереди вызывает ложный CAS-конфликт версий настроек.
7. **Исторический порядок DDL-шагов в `migrations.ts`**:
   - *Почему не трогать*: Порядок уже выпущенных версий схемы в существующих SQLite-базах пользователей менять нельзя (можно лишь перенести сам модуль миграций внутрь `src/rooms/storage/` и не добавлять в него бизнес-парсинг текста для новых колонок).
