---
title: "App Roast: Lane Pilot 0.1.456 — Gemini 4 Argon"
status: complete
target: "Lane Pilot 0.1.456 — Gemini 4 Argon"
created: "2026-11-01T11:55:22+00:00"
language: "ru"
tone: "roast"
---

# App Roast: Lane Pilot 0.1.456 — Gemini 4 Argon

> [!IMPORTANT]
> Полный аудиторский отчёт по ревизии `295497fc` (v0.1.456). Все приоритетные комнаты и логические цепочки проверены по исходникам и read-only runtime-срезам. Подтверждено **16 дефектов** (`CONFIRMED-CODE` / `CONFIRMED-RUNTIME`), **2 гипотезы** (`HYPOTHESIS`) и **2 UX-суждения** (`UX-JUDGMENT`).

## 1. Паспорт аудита (Audit brief)

| Поле | Значение |
| --- | --- |
| Цель / поддерживаемая версия | Плагин `bb-plugin-lane-pilot` v0.1.456 |
| Ожидаемый результат и роль | Аудит несостыковок между обещаниями (доки, тексты UI, CHANGELOG, каталог настроек, брифы агентов) и реальным кодом + логических цепочек между комнатами |
| Ограничения пользователя | Режим **только аудит**: код не менять, git-операции с модификацией не делать, настройки/состояния не менять, полный прогон тестов не запускать |
| Исключения и допущения | Общее рабочее дерево с другими агентами; только читающие CLI-команды `bb lane-pilot ...` |
| Ревизия / сборка / чистота | `295497fc` (v0.1.456) |
| Окружение / данные / бюджет | Linux 6.8.0-100-generic, живая БД хаба + исходники `/home/ubuntu/BB-service/bb-plugin-lane-pilot`, бюджет — полное покрытие всех 8 приоритетных зон |
| Доступные инструменты | Исходники (`read`, `grep`, `find_file_by_name`) + read-only runtime CLI (`bb lane-pilot waiting`, `lead status|road|exam|rights|journal`, `schedule list`, `phase list`) |
| GitNexus | Индекс не пересобирался и не трогался по прямому запрету задания (индекс занят другим процессом); использован полный поиск по исходникам (`grep`/`find_file_by_name`) |

## 2. Иерархия работ и прогресс

<!-- app-roast:work:start -->
- [x] T-001 Снять контракты, runtime-состояние и карту сценариев
- [x] T-002 Исследовать приоритетные комнаты и логические цепочки
  - [x] T-002.1 Штурман (`src/rooms/lead`, `docs/lead.md`, `policy/lead-policy.json`, `workflows/lead-tick.json`)
  - [x] T-002.2 «Ждут владельца» (`src/rooms/owner-waiting`), правило 0.1.443 (тишина в PM) и Слово владельца (`owner.words`, `OWNER_WORD_WAIT_MS`)
  - [x] T-002.3 Ночной цикл и служебные графы (`self-repair`, `night-graphs`, `rule-forms`, `policy`)
  - [x] T-002.4 Ворота интеграции (`verification`), `run-goal` и Жизнь задачи писателя (`writer`, `tasks`, `relay`)
  - [x] T-002.5 Каталог настроек (`packages/settings-catalog`, `docs/enabled-settings.md`) и CHANGELOG 0.1.440–0.1.456
- [x] T-003 Свести доказательства, написать прожарку, приоритизировать бэклог ремонта и зафиксировать покрытие
<!-- app-roast:work:end -->

## 3. Карта контрактов и сценариев

| ID | Актор / предусловия | Действие | Обещание и источник | Авторитетный результат / связанные поверхности | Покрытие |
| --- | --- | --- | --- | --- | --- |
| S-001 | Штурман / ночной экзамен и прокси-ответы | Ответ на решение (`decide`, `word`, `lane_pilot_lead`) и расчёт `examEligible` | Прокси-ответы агентов не должны попадать в экзамен и разметку (`CHANGELOG.md:20`, `docs/lead.md:91`, `logic.ts:21-22`) | `lane_pilot_decision.answered_by` vs `PROXY_ANSWERERS` в `logic.ts:22` | Runtime + Source |
| S-002 | Штурман / приёмка ветки `later` и повторный показ | Владелец нажимает «Потом» (`later`), следующий тик снова предлагает ветку | Каждое предложение в списке получает свежий прогноз и вердикт (`docs/lead.md:83`, `tick.ts:201-215`) | `openDecision` (`INSERT OR IGNORE`), `predictDecision`, `answerDecision` в `journal.ts` | Source |
| S-003 | Штурман / разметка владельцем (`label`) и таблица `lane_pilot_lead_label` | Владелец размечает строки через UI/CLI (`lead label`) | Метки хранятся в `lane_pilot_lead_label` (`docs/lead.md:64`, `migrations.ts:12,85`), а `deferred` не размечается (`docs/lead.md:93`) | `journal.ts:139`, `cli.ts:147`, `lane_pilot_lead_label` | Source |
| S-004 | Штурман / тик и расписание (`lp.lead_act`, `createLeadSchedule`) | Предложение класса `schedule` или `next_step` при открытом праве `decides` | В `propose` проверяется `mayAct`, в `act` создаётся расписание или передаётся в PM; дока `docs/lead.md:84` vs `95` | `tick.ts:216-280`, `docs/lead.md:84,95` | Source |
| S-005 | «Ждут владельца» / жизненный цикл карточек | Публикация (`postOwnerItem`) и закрытие (`closeOwnerItem`) строк со всех комнат | Каждая строка либо имеет кнопку/команду закрытия, либо автоматически закрывается, когда причина ушла (`docs/owner-waiting.md:44-61`) | `items.ts`, `driver.ts`, `question-timeout.ts`, `second-pilot.ts`, `integration-gate.ts`, `run-goal.ts` | Runtime + Source |
| S-006 | Правило 0.1.443 / тишина в чатах PM | Фоновые службы, кроны, расписания, послеслиятельные проверки | «No event of the plugin's own is sent into a PM chat» (`CHANGELOG.md:60`) | `learning/service.ts:295`, `schedule-service.ts:50`, `backlog/scanner.ts:52`, `finish.ts:1041` | Source |
| S-007 | Слово владельца и риск (`owner.words`, `landingWordAsked`, `OWNER_WORD_WAIT_MS`) | Задача проходит валидацию при `owner.words = on` или `risky` (`risk: high`) и ждёт 6 часов | Заявлено: ответ даётся через экран «Ждут владельца», при `yes` в течение 6 ч задача приземляется сама без переотправки (`docs/owner-waiting.md:29,34`, `finish.ts:829-838`) | `finish.ts:822-844`, `words.ts:36`, `queue-tool.ts:43`, `items.ts` | Source |
| S-008 | Ночной цикл и правила (`rules-scan`, `insights`, `night-policy.json`) | Сбор → анализ → принятие правила на пробу → подтверждение (`confirmed`) | `policy/night-policy.json:96-100` относит `rule_adopt` к `night_proposes`; PM-правила и правила писателей проходят испытание и подтверждаются или снимаются через 60 дней (`rules.ts:614-621`) | `rule-scan.ts:458-501`, `insights.ts:49-143`, `rules.ts:551-621`, `live-exam.ts:60-130` | Runtime + Source |
| S-009 | Служебные графы (`lp.rules-scan`, `lp.model-rebench`, `lp.critic-edit`) | Прогон при `jobs=0`, `origin: "schedule"`, учёт побед `evaluateModelRouting` | `lp.rules-scan` при `fallback`/`jobs=0` не зовёт модель; `lp.model-rebench` и `lp.critic-edit` молчат на списке владельца (`CHANGELOG.md:8`) | `lp.rules-scan.json`, `model-rebench-graph.ts:53,272`, `critic-edit-graph.ts:45,67` | Source |
| S-010 | Ворота интеграции (`integration-gate`) и `run-goal` | Поиск виновника, отправка `fix turn` писателю, перепроверка на `main` | Писатель чинит упавший тест и результат возвращается как результат задачи (`CHANGELOG.md:60`, `integration-gate.ts:628`) | `integration-gate.ts:623-631` vs `finish.ts:996`, `reopen-attempt.ts:99-123` | Source |
| S-011 | Жизнь задачи писателя (`writer`, `second-pilot`, `question-timeout`) | Вопрос без ответа (`NEEDS_HUMAN`) → второй пилот (`narrow` / `owner`) → возврат/уведомление | При `owner` пишется в тёплый чат PM или на список владельца (`second-pilot.ts:228-234`); при `narrow` создаётся суженная задача | `second-pilot.ts:207,230`, `question-timeout.ts:37-44`, `pm-notice.ts:11-16` | Source |
| S-012 | Каталог настроек (`settings-catalog`, `docs/enabled-settings.md`, `CHANGELOG` 0.1.440–0.1.456) | Наследование дефолтов, валидация, документация настроек и обещания релизов | Дефолты каталога совпадают с кодом (`docs/self-improvement-settings.md:75`), а релизы 0.1.440–0.1.456 соответствуют коду на `295497fc` | `lp-defaults.ts:64-68`, `channels.ts:300-306`, `docs/enabled-settings.md:261`, `docs/relay.md:31` | Source |

## 4. Находки (Findings)

### 4.1 Индекс и счётчики

| ID | Зона / технический заголовок | Статус доказательства | Серьёзность | Уверенность | Задача / сценарий | Статус ремонта |
| --- | --- | --- | --- | --- | --- | --- |
| [F-001](#f-001) | Lead / Обход фильтра `PROXY_ANSWERERS` прокси-ответами PM и чата Штурмана (`pm`, `owner via pm`, `lead-chat`) | `CONFIRMED-CODE` | P1 | Высокая | T-002.1 / S-001 | Открыт |
| [F-002](#f-002) | Lead / Ветка со статусом `later` при повторном предложении навсегда блокирует новый прогноз и ответ в журнале | `CONFIRMED-CODE` | P1 | Высокая | T-002.1 / S-002 | Открыт |
| [F-003](#f-003) | Lead / Тик создаёт открытую карточку «Ждут владельца» до шага `lp.lead_act`, оставляя дубль или мусор при сбое передачи | `CONFIRMED-CODE` | P2 | Высокая | T-002.1 / S-004 | Открыт |
| [F-004](#f-004) | Lead / Мёртвая таблица `lane_pilot_lead_label`, рассинхрон CLI `deferred` и противоречие в `docs/lead.md` про расписания и `server/exam.ts` | `CONFIRMED-CODE` | P2 | Высокая | T-002.1 / S-003, S-004 | Открыт |
| [F-005](#f-005) | Lead / Утечка из будущего в `historyOf` при `backtest` и отсутствие `refineVerdict` (`partial`) в бэктесте и экзамене памяти | `CONFIRMED-CODE` | P2 | Высокая | T-002.1 / S-001 | Открыт |
| [F-006](#f-006) | Owner-waiting / Восемнадцать видов строк `postOwnerItem` не имеют ни кнопок `actions`, ни автоматического `closeOwnerItem` и висят вечно | `CONFIRMED-RUNTIME` | P1 | Высокая | T-002.2 / S-005 | Открыт |
| [F-007](#f-007) | Owner-waiting & PM / Нарушение правила 0.1.443: ежедневный дайджест обучения, сбои расписаний, сканер бэклога и `second-pilot` будят чаты PM | `CONFIRMED-CODE` | P1 | Высокая | T-002.2 / S-006 | Открыт |
| [F-008](#f-008) | Owner words / Ожидание слова владельца (`OWNER_WORD_WAIT_MS`) вообще не попадает на экран «Ждут владельца», держит слот писателя 6 часов и противоречит `queue-tool.ts` | `CONFIRMED-CODE` | P1 | Высокая | T-002.2 / S-007 | Открыт |
| [F-009](#f-009) | Night policy & Rules / Прямое противоречие `night-policy.json` (`rule_trial_apply` = `night_proposes`) с `adoptRuleProposal`, `STRICT_PROOF_ENTRIES` и оборванным `collectAndAppend` | `CONFIRMED-RUNTIME` | P1 | Высокая | T-002.3 / S-008 | Открыт |
| [F-010](#f-010) | Rules trial / Правила с `audience: "pm"` никогда не получают `applied > 0`, никогда не подтверждаются (`confirmed`) и гарантированно удаляются как `unused` через 60 дней | `CONFIRMED-RUNTIME` | P1 | Высокая | T-002.3 / S-008 | Открыт |
| [F-011](#f-011) | Night graphs / Картезианский взрыв в SQL-запросе `evaluateModelRouting` (`lp.model-rebench`) и мёртвый `bench: ""` в `lp.critic-edit` | `CONFIRMED-CODE` | P2 | Высокая | T-002.3 / S-009 | Открыт |
| [F-012](#f-012) | Rules scan / Расхождение `workflows/lp.rules-scan.json` с кодом при `state === "fallback"` и `jobs=0`: граф идёт в `analyze` и `apply`, пропуская `evaluateRules` | `CONFIRMED-CODE` | P2 | Высокая | T-002.3 / S-009 | Открыт |
| [F-013](#f-013) | Verification / `integration-gate.ts` шлёт `fix turn` в тред писателя уже закрытой (`accepted`) попытки без `reopenAttempt` и без живого worktree | `CONFIRMED-CODE` | P1 | Высокая | T-002.4 / S-010 | Открыт |
| [F-014](#f-014) | Writer & Second pilot / `sendPmNotice` возвращает `true` при проглоченной ошибке отправки, а `second-pilot` при `narrow` оставляет исходную попытку в `blocked` вместо `superseded` | `CONFIRMED-CODE` | P2 | Высокая | T-002.4 / S-011 | Открыт |
| [F-015](#f-015) | Settings catalog / Хаос настроек: дефолт писателя в каталоге (`kimi` / `low` / `standard`) противоречит `inheritProjectValues` (`codex` / `gpt-6-luna` / `high` / `fast`), дубль `night_review.model` и пропуски `owner.words` / `phase.rails` | `CONFIRMED-CODE` | P2 | Высокая | T-002.5 / S-012 | Открыт |
| [F-016](#f-016) | Settings & CHANGELOG / Релиз 0.1.445 забыл `reset_project_settings`, а `docs/relay.md` на ревизии `295497fc` (0.1.456) ссылается на несуществующий релиз `0.1.458` | `CONFIRMED-CODE` | P2 | Высокая | T-002.5 / S-012 | Открыт |

Confirmed runtime: 3. Confirmed code: 13. Hypotheses: 2. UX judgments: 2. Rejected: 0.

### 4.2 Подтверждённые несостыковки по зонам продукта

<a id="f-001"></a>
#### F-001. Обход фильтра `PROXY_ANSWERERS`: ответы агентов через `lane_pilot_queue word`, `lane_pilot_phase word` и `lane_pilot_lead decide` засчитываются в экзамен как личные ответы владельца

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.1 / S-001 | **Область:** `src/rooms/lead`, `src/rooms/tasks`, `src/rooms/phase`
- **Обещание и источник:** В `CHANGELOG.md:20` (0.1.453), `docs/lead.md:71,91,93` и `src/rooms/lead/logic.ts:21-22,59` заявлено, что в экзамен (`examEligible`) и в очередь разметки (`pendingLabels`) попадают только ответы самого владельца, а ответы-прокси от агентов отсеиваются множеством `PROXY_ANSWERERS`.
- **Обнаруженное противоречие:** `PROXY_ANSWERERS` в `src/rooms/lead/logic.ts:22` содержит ровно две строки: `new Set(["lead", "agent"])`. Однако в коде есть ещё три пути, где решение записывается вызовом инструмента агента, а не кнопкой экрана или CLI владельца:
  1. PM вызывает `lane_pilot_queue {action: "word"}` (`src/rooms/tasks/server/queue-tool.ts:42`) → вызывает `answerTaskWord(..., "pm")` → записывает `answered_by = "pm"`.
  2. PM вызывает `lane_pilot_phase {action: "word"}` (`src/rooms/phase/server/tool.ts:135`) → вызывает `api.word(..., by: "owner via pm")` → записывает `answered_by = "owner via pm"`.
  3. Сам агент Штурман в своём чате вызывает свой инструмент `lane_pilot_lead {action: "decide"}` (`src/rooms/lead/server/tool.ts:85`) → вызывает `lead.decide(..., "lead-chat")`. Никакой технической проверки, что владелец действительно дал согласие в чате, в `tool.ts:84-88` нет — это обычный tool call агента `lead`.
  4. Даже в CLI `bb lane-pilot lead decide <id> yes --by claude` (`src/rooms/lead/cli.ts:83`) флаг `--by` принимает любую строку, и любое значение кроме буквально `"agent"` или `"lead"` проходит фильтр `PROXY_ANSWERERS.has(row.answered_by)`.
- **Последствия для пользователя:** Агент PM или сам Штурман может закрывать решения на поверхностях `words`, `phase` и `lead`, и все эти строки беспрепятственно входят в `examEligible` (`logic.ts:60-68`) и `pendingLabels` (`journal.ts:126`), накручивая выборку экзамена `N` и открывая права класса `decides` без реального нажатия владельца.
- **Воспроизведение:**
  1. Открыть решение через `askTaskWord(db, ...)` или `openDecision(db, ...)`.
  2. Ответить через `answerTaskWord(db, runId, family, "yes", "ok", "pm")` (как делает `queue-tool.ts:42`) или `answerPhaseWord(..., "owner via pm")` (как делает `phase/server/tool.ts:135`).
  3. Вызвать `examEligible(row)` из `src/rooms/lead/logic.ts:60` — возвращает `true` вместо `false`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/lead/logic.ts:22,60-68`
  - `src/rooms/tasks/server/queue-tool.ts:42`
  - `src/rooms/phase/server/tool.ts:135`
  - `src/rooms/lead/server/tool.ts:84-88`
  - `src/rooms/lead/cli.ts:82-85`
- **Проверка контрпримеров:** В `driver.ts:456` для `word` есть проверка `isWholeConsent(input.text)`, но она проверяет лишь длину и отсутствие «но/если» в строке `text`, которую передал сам PM в аргументах тула (`tool.ts:135`), не сверяя её ни с каким реальным сообщением владельца в треде.
- **Минимальный ремонт:** Заменить чёрный список `PROXY_ANSWERERS` на белый список подтверждённых каналов владельца (`OWNER_ANSWERERS = new Set(["owner", "screen"])`) либо требовать проверяемый `owner_msg` (`threadId#seq`), а в CLI `lead decide` ограничить `--by` значениями `owner | agent`.
- **Проверка приёмки:** Тест в `tests/lead/logic.test.ts`: для `answered_by: "pm"`, `"owner via pm"` и `"claude"` функция `examEligible(row)` возвращает `false`.
- **Прожарка:** Поставили фейсконтроль на две таблички «`lead` и `agent` не пускать», а когда PM заходит через боковую дверь с бейджиком `"pm"` или `"owner via pm"`, вахтёр `examEligible` почтительно засчитывает его голос как личное слово владельца.

<a id="f-002"></a>
#### F-002. Повторное предложение ветки после ответа «Потом» (`later`) намертво ломает запись прогноза и нового ответа в журнале решений

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.1 / S-002 | **Область:** `src/rooms/lead/server/tick.ts`, `journal.ts`, `service.ts`
- **Обещание и источник:** В `docs/lead.md:75,83` и `DEFAULT_LEAD_MD` (`src/rooms/lead/server/identity.ts:41`) описан штатный цикл: владелец отвечает «Потом» (`later`), ветка переходит в состояние `later`, а через неделю с новым доказательством Штурман снова предлагает эту же ветку (`proposeRoad` в `road.ts:93-95` специально разрешает переход `open | later → proposed`), создавая запись в журнале с прогнозом и принимая новое решение владельца.
- **Обнаруженное противоречие:** В `src/rooms/lead/server/tick.ts:210` ID решения в журнале жёстко привязан к ID ветки без номера тика или попытки: `const decisionId = proposalDecisionId(row.id)` (`"lead:" + roadId`).
  Когда ветка предлагается во второй раз (из состояния `later`):
  1. `openDecision(db, { id: "lead:<roadId>", ... })` (`tick.ts:211`, `journal.ts:34`) делает `INSERT OR IGNORE` — старая строка (у которой `predicted_at` и `answered_at` уже заполнены первым ответом `"later"`) остаётся нетронутой.
  2. `predictDecision(db, decisionId)` (`tick.ts:213`, `journal.ts:55`) видит `row.predicted_at !== null || row.answered_at !== null` и молча выходит (`return null`), не делая прогноз.
  3. Когда владелец отвечает на повторное предложение («Да» или «Нет»), `service.decide` (`service.ts:190-191`) вызывает `answerDecision(db, "lead:<roadId>", ...)`, который в `journal.ts:89` видит `row.answered_at !== null` (от старого `"later"`) и молча возвращает старую строку (`return row`), игнорируя новый ответ!
- **Последствия для пользователя:** Любая ветка, отложенная кнопкой «Потом» (`later`), при повторном выходе в утренний список превращается в зомби для журнала: ни новый прогноз Штурмана, ни финальное «Да»/«Нет» владельца никогда не запишутся в `lane_pilot_decision`, в журнале навсегда останется первый ответ `"later"`. То же самое происходит с `wordDecisionId(runId, family)` (`surfaces.ts:12`), если задачу одного семейства в одном запуске приземляют повторно.
- **Воспроизведение:**
  1. Предложить ветку `road_1` в тике 1 → `decide("road_1", "later", undefined, "owner")` (ветка в состоянии `later`, решение `lead:road_1` закрыто с `option: "later"`).
  2. В тике 2 снова передать `road_id: "road_1"` в `proposals` → ветка переходит в `proposed`.
  3. Вызвать `decide("road_1", "yes", undefined, "owner")` → ветка переходит в `accepted`, но в `lane_pilot_decision` у `lead:road_1` остаётся старый `answer_json: '{"option":"later"}'`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/lead/server/tick.ts:30,201-215`
  - `src/rooms/lead/server/road.ts:93-98`
  - `src/rooms/lead/server/journal.ts:32-38,53-55,87-95`
  - `src/rooms/lead/server/service.ts:185-197`
- **Минимальный ремонт:** Включать `tickId` (например, `lead:${row.id}:${tickId}`) в `decisionId` при повторном предложении ветки; `proposeRoad` (`road.ts:96`) уже сохраняет актуальный `decision_id` на строке ветки, а `service.decide` (`service.ts:190`) уже читает `row.decision_id`.
- **Проверка приёмки:** Тест в `tests/lead/service.test.ts`: цикл `propose → later → propose → yes` создаёт вторую запись в `lane_pilot_decision` с ответом `yes`.
- **Прожарка:** Кнопка «Потом» работает как граната с отложенным взрывом: ветка честно возвращается через неделю, но журнал решений затыкает уши и кричит «я уже записал "потом" в прошлый вторник, твоё нынешнее "да" меня не интересует».

<a id="f-003"></a>
#### F-003. Тик Штурмана публикует карточку «Ждут владельца» на шаге `propose` до выполнения `act`, оставляя ложный вопрос при сбое передачи или дублируя закрытую строку

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.1 / S-004 | **Область:** `src/rooms/lead/server/tick.ts`, `workflows/lead-tick.json`
- **Обещание и источник:** В `workflows/lead-tick.json:124` и `docs/lead.md:49,84` обещано: в классах `proposes` предложения идут в утренний список с кнопками «Да / Потом / Нет», а в классах, открытых экзаменом (`decides`), Штурман действует сам без вопроса владельцу и ставит перед фактом (`kind: "acted"`). В диаграмме `2026-11-01-lead-agent-roadmap.md:72-74` `propose` и `act` — альтернативные ветки (`proposes → lead.propose`, `decides → lead.act`).
- **Обнаруженное противоречие:** В реальном графе `workflows/lead-tick.json:174-184` шаги идут последовательно: `think → propose → act → receipt`. На шаге `lp.lead_propose` (`src/rooms/lead/server/tick.ts:216-227`) код **безусловно** для каждого предложения (даже если `mayAct(db, proposal.class!, risk).ok === true`) вызывает `postOwnerItem` с `kind: "proposal"` и кнопками «Да / Потом / Нет». Только на следующем шаге `lp.lead_act` (`tick.ts:258,274`), если передача в PM или создание расписания прошли успешно, он закрывает `lead:<roadId>` и создаёт вторую строку `lead-acted:<roadId>`. А если в проекте нет открытого чата PM (`!pm` в `tick.ts:266`) или `handOver` вернул `started: false`, шаг `lp.lead_act` записывает причину в `deferred`, но **оставляет открытыми** ветку в состоянии `proposed`, карточку `kind: "proposal"` на «Ждут владельца» и открытое решение в журнале.
- **Последствия для пользователя:** Если класс открыт экзаменом (`decides`), но в проекте в момент тика нет живого PM-чата, Штурман тихо превращает невыполненное самостоятельное действие обратно в вопрос владельцу, а когда владелец нажимает «Да», получает ошибку `handover_blocked` («Вы ответили да, но работа не началась: в проекте нет открытого чата Lane Pilot»).
- **Проверенные файлы и строки (`295497fc`):**
  - `workflows/lead-tick.json:174-184`
  - `src/rooms/lead/server/tick.ts:216-227,244-280`
- **Минимальный ремонт:** Не вызывать `postOwnerItem` с `kind: "proposal"` внутри `lp.lead_propose` для элементов из `actable`, либо явно обрабатывать отказ `act` отдельно от `propose`.
- **Проверка приёмки:** Тест в `tests/lead/tick.test.ts`: при открытом праве `decides` и отсутствии PM-чата не создаётся открытая карточка `kind: "proposal"` с кнопками голосования.
- **Прожарка:** Штурман сдал экзамен на самостоятельность, попробовал сам завести мотор, обнаружил, что ключей от PM-чата нет, и не моргнув глазом подложил владельцу бланк «Разрешите завести мотор?», чтобы при нажатии «Да» радостно сообщить: «А ключей-то всё равно нет!».

<a id="f-004"></a>
#### F-004. Мёртвая таблица `lane_pilot_lead_label`, рассинхрон валидации метки `deferred` между UI/док и CLI, и устаревшие утверждения в `docs/lead.md`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.1 / S-003, S-004 | **Область:** `src/rooms/lead/migrations.ts`, `cli.ts`, `docs/lead.md`, `policy/lead-policy.json`
- **Обещание и источник:**
  1. `docs/lead.md:64`, `CHANGELOG.md:44` и `src/rooms/lead/migrations.ts:12,85-93` объявляют таблицу `lane_pilot_lead_label` хранилищем ручных вердиктов владельца (`kind: 'judge' | 'novelty'`) для расчёта каппы судьи.
  2. `docs/lead.md:93` утверждает: «`bb lane-pilot lead label <decision-id> exact|partial|miss`, ... a deferred row has nothing to label».
  3. `docs/lead.md:84` утверждает: «Classes that act through schedules are not wired yet and stay proposals», а `policy/lead-policy.json:5` ссылается на `src/rooms/lead/server/exam.ts`.
- **Обнаруженное противоречие:**
  1. Таблица `lane_pilot_lead_label` создаётся в миграции (`migrations.ts:85`), но **ни разу не читается и не пишется** во всём репозитории (0 вхождений вне `migrations.ts` и доков). Вместо неё `labelDecision` (`journal.ts:139`) пишет прямо в колонку `lane_pilot_decision.owner_label`, а `novelty`-метки не реализованы вовсе.
  2. Вопреки `docs/lead.md:93` и RPC `lead_label` (`service.ts:246`, где тип `Exclude<Verdict, "deferred">`), CLI в `src/rooms/lead/cli.ts:23,147` разрешает `deferred` и вызывает `labelDecision(ctx.db, id, "deferred")` на любой отвеченной строке (даже на `split='backtest'`, `split='design'`, прокси-ответах и `deferred`-строках). Если владелец через CLI пометит строку как `deferred`, она попадёт в `cohenKappa` (`logic.ts:94`) как четвёртая категория и исказит каппу против судьи, который на решённых строках никогда не ставит `deferred`.
  3. В `docs/lead.md:84` остался абзац «Classes that act through schedules are not wired yet and stay proposals», который прямо противоречит соседнему абзацу `docs/lead.md:95` и коду `tick.ts:252-264` (0.1.455 уже подключил `createLeadSchedule`). А файл `src/rooms/lead/server/exam.ts`, указанный в `policy/lead-policy.json:5` и роадмапе, не существует.
- **Последствия для пользователя:** Схема БД возит с собой мёртвую таблицу `lane_pilot_lead_label`, документация `docs/lead.md` противоречит сама себе через 11 строк, а CLI `lead label` позволяет записать `deferred`-метку и метки на не-экзаменационные строки, ломая расчёт `cohenKappa`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/lead/migrations.ts:85-93`
  - `src/rooms/lead/server/journal.ts:139-141`
  - `src/rooms/lead/cli.ts:23,145-149`
  - `src/rooms/lead/server/service.ts:246-248`
  - `docs/lead.md:64,84,93,95`
  - `policy/lead-policy.json:5`
- **Минимальный ремонт:** Запретить `deferred` в `cli.ts:147` (привести к `exact | partial | miss`, как в `service.ts:246`) и проверять в `labelDecision`, что `judge_verdict IN ('exact','partial','miss')`; удалить мёртвую таблицу или писать в неё историю меток; поправить строку 84 в `docs/lead.md` и ссылку в `policy/lead-policy.json:5`.
- **Проверка приёмки:** Вызов `runLeadCli(ctx, ["label", id, "deferred"])` возвращает `exitCode: 2`, а `grep "are not wired yet" docs/lead.md` пуст.
- **Прожарка:** В документации таблице `lane_pilot_lead_label` посвящена отдельная графа архитектуры, в базе под неё вырыт котлован с индексом, но код в неё даже не плюнул — а `docs/lead.md` в пункте 4 клянётся, что расписания ещё не подключены, и через два абзаца в красках расписывает, как они подключены.

<a id="f-005"></a>
#### F-005. Утечка данных из будущего в `backtest` (`historyOf` без фильтра по времени) и игнорирование модельного судьи (`refineVerdict`) в бэктесте и экзамене памяти

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.1 / S-001 | **Область:** `src/rooms/lead/server/journal.ts`, `backtest.ts`, `memory-exam.ts`
- **Обещание и источник:** В `docs/lead.md:71,103` и `src/rooms/lead/server/memory-exam.ts:34-39` подчёркнуто, что предсказатель опирается на прошлые ответы владельца («no peeking forward») и что несовпадения проверяются модельным судьёй `lead.judge` (`partial`).
- **Обнаруженное противоречие:**
  1. В `src/rooms/lead/server/journal.ts:43-47` функция `historyOf(db, row)` делает запрос `SELECT situation_json, answer_json FROM lane_pilot_decision WHERE surface=? AND class=? AND id<>? AND answer_json IS NOT NULL ORDER BY answered_at DESC LIMIT 20` **без условия `answered_at < row.created_at`**. Когда запускается `bb lane-pilot lead backtest` (`src/rooms/lead/server/backtest.ts:20-49`), исторические задачи и фазы перебираются в порядке обхода `Object.entries(words)` / `listPhases` (от новых к старым!). Поэтому при предсказании старого решения в `predictDecision` (`backtest.ts:26`) в `historyOf` передаются ответы владельца из **будущих** задач и даже из сегодняшнего `split='exam'`. (При этом в `memory-exam.ts:35-38` автор вспомнил про утечку и написал отдельную функцию `historyBefore` с `answered_at < ?`, а в `journal.ts:43` — забыл).
  2. Ни `backtest.ts:26-27`, ни `memory-exam.ts:75-81` не вызывают `refineVerdict` (`lead.judge`) и считают только точное совпадение `exact`, хотя основной экзамен (`logic.ts:83`) и живой поток (`service.ts:193`, `surfaces.ts:28,43`) оценивают ответы через `refineVerdict` с весом `partial = 0.5`.
- **Последствия для пользователя:** Бэктест (`bb lane-pilot lead backtest`) завышает точность предсказателя за счёт подглядывания в будущие ответы владельца (на текущем хабе 37 из 38 в `backtest` получили `exact`), но одновременно не умеет считать `partial`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/lead/server/journal.ts:43-47`
  - `src/rooms/lead/server/backtest.ts:23-28,43-49`
  - `src/rooms/lead/server/memory-exam.ts:35-39,75-81`
- **Минимальный ремонт:** Добавить фильтр `AND answered_at <= ?` (по `row.created_at`) в `historyOf` (`journal.ts:44`) и сортировать входы `backtest` по возрастанию `word.at`.
- **Проверка приёмки:** Тест в `tests/lead/journal.test.ts`: при двух ретроспективных записях с `created_at: 100` и `created_at: 200` (отвеченной в `200`), вызов `predictDecision` для первой (`100`) не получает в `history` ответ второй (`200`).
- **Прожарка:** В `memory-exam.ts` специально написали комментарий `// no peeking forward`, а в соседнем `journal.ts` оставили `ORDER BY answered_at DESC` без фильтра даты — поэтому на бэктесте Штурман предсказывает прошлогодние ответы, держа перед глазами вчерашнюю шпаргалку.

<a id="f-006"></a>
#### F-006. Кладбище на экране «Ждут владельца»: 18 из 20 видов карточек создаются без кнопок и без автоматического закрытия (`closeOwnerItem`), оставаясь висеть вечно

- **Статус:** `CONFIRMED-RUNTIME` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.2 / S-005 | **Область:** `src/rooms/owner-waiting`, `phase`, `writer`, `verification`, `run-goal`, `lead`
- **Обещание и источник:** В `CHANGELOG.md:7` (0.1.456) и `docs/owner-waiting.md:44-68` обещано, что экран «Ждут владельца» создан для человека, который не программирует: у каждой карточки есть кнопка действия (когда у плагина есть RPC) или точная команда, а когда вопрос решён или потерял актуальность, вызывается `closeOwnerItem` (`src/rooms/owner-waiting/items.ts:112`).
- **Обнаруженное противоречие (код + живой runtime хаба):** На весь репозиторий (`src/**`) есть **16 вызовов `postOwnerItem`** и всего **4 вызова `closeOwnerItem`** (`driver.ts:467`, `lead/server/service.ts:194`, `lead/server/tick.ts:258,274`, `workflow-answer.ts:29`):
  1. **Повороты фаз (`phase-word:<phaseId>:<turn>`, `src/rooms/phase/server/driver.ts:392,1050`):** Создаются вообще **без `actions`** (на экране нет ни кнопок «Да / Нет», ни CLI-команды!). Хуже того, `closeOwnerItem` вызывается **только** внутри `word()` (`driver.ts:467`). Когда фаза закрывается (`close`), останавливается (`stop`), откатывается назад (`returnTo`) или пересматривается (`revise`) (`driver.ts:517,573,584,608`), `closeOwnerItem` **не вызывается**. Runtime-доказательство в живом журнале хаба (`bb lane-pilot lead journal --json`, запись `lead:road_4ca8132d51`): фаза `ph_97edc5c189` была закрыта ещё 31.10 (`bb lane-pilot phase list`: `ph_97edc5c189 closed`), а её строка `phase-word:ph_97edc5c189:design` продолжала висеть открытой на «Ждут владельца» и заставила Штурмана сгенерировать по ней предложение в тике `tick_5c725067`!
  2. **Вопросы писателей (`writer-question:<runId>:<taskId>`, `question-timeout.ts:49`, `second-pilot.ts:231`):** Публикуются без `actions`, а когда писателю отвечают через `answerWriter` (`src/rooms/writer/server/answer.ts`), перезапускают задачу (`dispatch.ts`) или отменяют её (`cancel`), `closeOwnerItem` нигде не вызывается — карточка висит вечно.
  3. **Интеграционные ворота и цель запуска (`gate-red:<runId>:<startedAt>` в `integration-gate.ts:663`, `run-goal:<runId>` в `run-goal.ts:34`):** Когда следующий прогон ворот (`integration-gate.ts:455` чистит только `this.episodes.delete(runId)`, но не вызывает `closeOwnerItem`!) или `run-goal` становится зелёным (`passed`), старая красная карточка на «Ждут владельца» не закрывается.
  4. **Уведомления и ошибки Штурмана, стены, расписаний, сбоев и графов (`lead-handed:*`, `lead-acted:*`, `lead-tick:*`, `lead-right:*`, `lead-labels:*`, `wall:*`, `schedule-failure:*`, `schedule-agent:*`, `outage:*`, `workflow-end:*`):** Все они создаются со `state = 'open'` без единой кнопки `actions` (даже без кнопки «Прочитано / Закрыть» на экране `owner-waiting-board.tsx:60-97`), а `lead-labels:<week>` не закрывается даже тогда, когда владелец разметил все 20 строк в блоке «Разметка» (`service.ts:246`).
  5. **Строки обучения (`learning:<id>`, `items.ts:66-75`):** В `learningItems` указаны `actions` без `rpc`, поэтому на экране для не-программиста вместо кнопок «Принять / Отклонить» рисуется совет скопировать консольную команду `bb lane-pilot learning accept <id>`.
- **Последствия для пользователя:** Экран «Ждут владельца», переписанный в 0.1.456 «для человека, а не программиста», на деле не даёт человеку ни одной кнопки закрытия для 90 % карточек и накапливает мёртвые строки от закрытых фаз, перезапущенных задач, починенных ворот и информационных справок, которые в 0.1.456 уже пришлось вычищать руками («The 24 stale lines on the hub were closed by hand»).
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/owner-waiting/items.ts:66-76,102-114`
  - `src/rooms/owner-waiting/ui/owner-waiting-board.tsx:60-98`
  - `src/rooms/phase/server/driver.ts:392,467,573-640,1050`
  - `src/rooms/writer/server/question-timeout.ts:49-53`
  - `src/rooms/writer/server/second-pilot.ts:231-234`
  - `src/rooms/verification/server/integration-gate.ts:455,661-668`
  - `src/rooms/run-goal/server/run-goal.ts:33-36`
  - `src/rooms/lead/server/service.ts:112,124,143,206,217,229,246,264`
- **Минимальный ремонт:** (1) Добавить универсальную кнопку «Убрать из списка» (`owner_waiting_close` RPC → `closeOwnerItem`) для информационных карточек в `owner-waiting-board.tsx`; (2) закрывать `phase-word:${phase.id}:*` при `close`/`stop`/`returnTo`/`revise` фазы; (3) закрывать `writer-question:${runId}:${taskId}` при `answerWriter`, переотправке и отмене задачи; (4) закрывать `gate-red:${runId}:*` и `run-goal:${runId}` при успешном прохождении ворот/цели; (5) закрывать `lead-labels:*`, когда `pendingLabelCount(db) === 0`.
- **Проверка приёмки:** Закрытие фазы `api.setState({ phaseId, state: "close", words: "done" })` переводит все открытые `phase-word:${phaseId}:*` в `state='closed'`.
- **Прожарка:** В 0.1.456 торжественно перевели заголовки карточек на человеческий русский, чтобы владелец «всё понял», но забыли приделать к ним кнопку «Закрыть» и хуки очистки — получился музей вечных табличек на понятном русском языке, который раз в два дня приходится чистить лопатой через SQL.

<a id="f-007"></a>
#### F-007. Четыре прямых нарушения правила 0.1.443 («Ни одно событие плагина не отправляется в чат PM»)

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.2 / S-006 | **Область:** `src/rooms/learning`, `src/rooms/schedule`, `src/rooms/backlog`, `src/rooms/writer`
- **Обещание и источник:** `CHANGELOG.md:60` (0.1.443): «**No event of the plugin's own is sent into a PM chat.** A PM chat gets only what its run needs to go on: task results, writers' questions, permits, the owner's orders, the end of a workflow or council it started.»
- **Обнаруженное противоречие:** На ревизии `295497fc` (v0.1.456) в коде остались активными четыре фоновых механизма плагина, которые сами шлют сообщения в `pm_thread_id` (в том числе в холодные чаты, простоявшие часами и днями, сжигая prompt-кэш):
  1. **Ежедневный дайджест обучения (`src/rooms/learning/service.ts:146,295-299` и `src/rooms/learning/digest.ts:61-80`):** Крон `learning-digest` каждый вечер в `18:20` обходит все проекты и вызывает `bb.sdk.threads.send({ threadId: pmThread, ... })` с отчётом «Lane Pilot learned from the owner's own messages... Tell the owner briefly...», будя открытые чаты PM ради фоновой сводки плагина.
  2. **Сбой любого расписания проекта (`src/rooms/schedule/server/schedule-service.ts:44-56`):** При падении задачи расписания (`onFailure`) плагин ищет `workflowTriggers.pmOf(schedule.project_id)` и вызывает `ctx.ownerAsk?.sendToThread(pm.pmThreadId, notice)` (внутри это `bb.sdk.threads.send` в `owner-ask.ts:144`), отправляя ошибку фонового крона прямо в чат PM вместо «Ждут владельца» (на «Ждут владельца» она попадает только если в проекте вообще нет чата PM, строка 54!).
  3. **Ежечасный сканер бэклога (`src/rooms/backlog/server/scanner.ts:40-57,65`):** Крон `backlog-scan` каждый час в `:41` находит любой чат PM проекта, обновлявшийся за последние 14 дней (`now - 14 * DAY`), и без спроса отправляет в него `bb.sdk.threads.send({ threadId: pm, text: issueMessage(next) })`, заставляя холодный чат PM проснуться и начать планировать задачу из `.agents/todos`.
  4. **Пост-мерж проверка окружения и `mainfix` (`src/rooms/writer/server/finish.ts:1031-1049`):** Фоновая `checkMainAfterMerge` (запускается через `void checkMainAfterMerge(...)` после того, как задача уже `accepted`!) при ошибке окружения (`EACCES`, `EPERM`) или повторном падении `mainfix` (`finish.ts:1041,1048`) вызывает `tell(...)` → `bb.sdk.threads.send({ threadId: input.pmThreadId, ... })`. *(Примечание: в `docs/relay.md:31` уже кто-то авансом написал «and since 0.1.458 the four sends the grills of 0.1.456 still found...», но в самих файлах `learning/service.ts:297`, `schedule-service.ts:50`, `backlog/server/scanner.ts:52` и `finish.ts:1031` на коммите `295497fc` эти вызовы `threads.send` по-прежнему стоят в коде!).*
- **Последствия для пользователя:** Заявленная в 0.1.443 защита чатов PM от фоновых побудок плагина дырявая: ровно в 18:20 `learning-digest`, в `:41` каждого часа `backlog-scan`, а также любой упавший скрипт расписания или фоновый `checkMainAfterMerge` будят спящий чат PM и прогоняют полный контекст модели.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/learning/service.ts:144-147,295-299`
  - `src/rooms/learning/digest.ts:61-80`
  - `src/rooms/schedule/server/schedule-service.ts:44-56`
  - `src/rooms/backlog/server/scanner.ts:19-28,40-57,65`
  - `src/rooms/writer/server/finish.ts:976,1031-1049`
  - `docs/relay.md:31`
- **Минимальный ремонт:** Перевести `schedule-service.ts` (`onFailure`), `learning-digest` и `finish.ts` (`checkMainAfterMerge`) на `postOwnerItem`, а `backlog-scan` публиковать предложением на список владельца вместо прямой отправки `threads.send` в чат PM.
- **Проверка приёмки:** При падении расписания `onFailure` создаёт запись `schedule-failure:<runId>` в `lane_pilot_owner_item` даже при наличии открытого PM-чата и не вызывает `threads.send` в `pmThreadId`.
- **Прожарка:** В релизе 0.1.443 написали манифест «Ни одно событие плагина больше не будит чат PM», а в `docs/relay.md:31` даже похвастались, что в будущем релизе `0.1.458` починят четыре забытых спамера — пока в реальном коде 0.1.456 все четыре продолжают исправно долбить в `threads.send`.

<a id="f-008"></a>
#### F-008. Слово владельца на приземление задачи (`owner.words` / `OWNER_WORD_WAIT_MS`): вопрос вообще не попадает на «Ждут владельца», держит слот писателя 6 часов и противоречит инструкции `lane_pilot_queue`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.2 / S-007 | **Область:** `src/rooms/writer/server/finish.ts`, `src/rooms/tasks/words.ts`, `queue-tool.ts`, `docs/owner-waiting.md`
- **Обещание и источник:**
  1. `docs/owner-waiting.md:29,34`: «With `owner.words` on, every verified task waits up to six hours for his «yes» before its merge; on `risky` (the default since 0.1.442) only a task of risk high waits, the rest land by themselves; **his answer comes through this same inbox.**»
  2. `src/rooms/writer/server/finish.ts:830`: сообщение PM-у гласит: «It waits up to 6 hours; **no need to resend it.**»
  3. `src/rooms/tasks/words.ts:36` и `src/rooms/tasks/server/queue-tool.ts:43`: после записи ответа `yes` возвращают прямо противоположное: «**send the task again: it lands without a new writer pass**».
- **Обнаруженное противоречие:**
  1. **Никакой строки на «Ждут владельца» не создаётся!** В `src/rooms/writer/server/finish.ts:826-838`, когда задача встаёт на 6-часовое ожидание `OWNER_WORD_WAIT_MS`, код вызывает `askTaskWord` (запись в журнал Штурмана) и `sendServiceMessage` (сообщение в чат PM с просьбой вызвать `lane_pilot_ask_owner`), но **НЕ вызывает `postOwnerItem`**. Если чат PM уже завершил ход или сообщение попало в очередь, на экране «Ждут владельца» и в Telegram-дайджесте (`planDigest`) этой задачи **нет вообще**!
  2. **Блокировка слота пула писателей и `owns_paths` на 6 часов:** В отличие от вопроса писателя (`NEEDS_HUMAN`), который переводит попытку в `blocked` и вызывает `dropLiveWriterKey()` (`start.ts:904`), ожидание `OWNER_WORD_WAIT_MS` крутится в `while`-цикле прямо внутри `finishAttempt` (`finish.ts:832-837`), пока попытка находится в состоянии `running` и удерживает слот `releaseWriterSlot` и `admitted` (`start.ts:447-457`). Все 6 часов ни одна задача в этой же `area` или `owns_paths` не может стартовать, хотя в 0.1.442 утверждалось, что проблема многочасового удержания `area` решена.
  3. **Рассинхрон контракта с PM:** `finish.ts:830` говорит PM-у «no need to resend it» (пока цикл `while` ждёт 6 часов, он действительно сам подхватывает `wordsOf()` раз в минуту), но сам инструмент `lane_pilot_queue {action: "word"}` (`queue-tool.ts:43`) отвечает PM-у: `next: "send the task again: it lands without a new writer pass"`, провоцируя PM тут же вызывать `dispatchWriter` поверх ещё живой `running`-попытки (и получать отказ `runningFamilyMember`).
- **Последствия для пользователя:** Рисковая задача (`risk: high`), прошедшая все проверки, не появляется на экране «Ждут владельца» (вопреки первой же плашке `docs/owner-waiting.md:29`), не имеет кнопок «Да / Нет» на экране `OwnerWaitingBoard`, 6 часов держит взаперти свою `area` и слот писателя, а инструмент `lane_pilot_queue word` даёт PM-у ложную команду переотправить уже бегущую задачу.
- **Проверенные файлы и строки (`295497fc`):**
  - `docs/owner-waiting.md:28-35`
  - `src/rooms/writer/server/finish.ts:69,819-844`
  - `src/rooms/tasks/words.ts:33-39`
  - `src/rooms/tasks/server/queue-tool.ts:40-44`
  - `src/rooms/owner-waiting/items.ts:89-97,134-141`
- **Минимальный ремонт:** Публиковать карточку `postOwnerItem` (`key: "task-word:" + runId + ":" + family`, `wake: true`, с кнопками RPC `task_word` `yes`/`no`) при входе в ожидание в `finish.ts:827` и закрывать её `closeOwnerItem` при получении ответа или истечении 6 часов; в `queue-tool.ts:43` проверять, жива ли попытка в `running`, прежде чем советовать «send the task again».
- **Проверка приёмки:** Когда задача с `risk: "high"` доходит до `finish.ts:826`, вызов `collectOwnerWaiting(db)` возвращает карточку с `rpc.method === "task_word"`, а нажатие кнопки «Да» закрывает карточку и завершает слияние.
- **Прожарка:** В первой же врезке `docs/owner-waiting.md` крупным шрифтом написано: «Единственное, чего система реально ждёт 6 часов — это вашего "да" на слияние задачи через этот самый список». Открываем `finish.ts` — а вызова `postOwnerItem` там просто нет! Владелец смотрит в пустой экран «Ждут владельца», задача 6 часов втихую душит слот писателя, а когда PM всё-таки записывает «да», тул советует ему задиспатчить уже бегущую задачу заново.

<a id="f-009"></a>
#### F-009. Конституция ночи против реальности: `night-policy.json` относит принятие правил к `night_proposes`, но `applyScan` принимает их без `authorize` и маркирует `"owner-confirmed"`, а `collectAndAppend` вообще не подключён к ночи

- **Статус:** `CONFIRMED-RUNTIME` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.3 / S-008 | **Область:** `src/rooms/policy`, `src/rooms/self-repair/server/rule-scan.ts`, `insights.ts`, `src/rooms/wall/acceptance.ts`
- **Обещание и источник:**
  1. `policy/night-policy.json:96-106` и `docs/night-policy.md:58,97-106`: «`rule_trial_apply` moved from `night_decides` to `night_proposes` in version 2... Any rule goes into force, on trial or not... Version 2 proposes it: an accepted rule is core memory read by every writer».
  2. `docs/night-policy.md:139-150`: «At night `collectOwnerDecisions` turns the owner's new decisions into items and `appendLiveItems` adds them to the plugin store... `collectAndAppend` is the night step».
- **Обнаруженное противоречие:**
  1. **Ночной сканер правил вообще не вызывает `authorize` из `src/rooms/policy`!** В `src/rooms/self-repair/server/rule-scan.ts:486,494` шаг `applyScan` напрямую вызывает `adoptRuleProposal(db, projectId, id)`. На живом хабе (`bb lane-pilot waiting --json`) за последние 24 часа `rulesAdopted: 27` правил были приняты автоматически в обход `rule_trial_apply` (`night_proposes`).
  2. Внутри `adoptRuleProposal` → `acceptRuleProposal(db, projectId, id, proposal.rule, "auto", now)` (`src/rooms/self-repair/server/insights.ts:58,128`) правило **сразу записывается в `core`-память** с концептом `concepts: ["rule", "owner-confirmed"]`, даже когда `by === "auto"` (и попутно вытесняет до 5 конвенций памяти `unusedConvention`, строка 134)!
  3. В `src/rooms/wall/acceptance.ts:167-187` список `STRICT_PROOF_ENTRIES` переопределяет `night_proposes` и `owner_only` (`judge_gates`, `judge_thresholds`, `rule_trial_apply`, `rule_always_on`, `default_model_change`, `new_pipeline_stage`, `graph_edit`, `memory_core_edit`) обратно в `decision: "merge"` (`provisional: true`), если есть бенч и откат — то есть даже там, где `authorize` вызывается (`gateRepair`), запреты `night_proposes` и часть `owner_only` из `night-policy.json` обходятся.
  4. Функция `collectAndAppend` (`src/rooms/policy/live-exam.ts:129`) **нигде не вызывается по расписанию** — единственное место её вызова во всём коде это ручная CLI-команда `bb lane-pilot policy exam-collect` (`src/rooms/policy/cli.ts:50`). При этом сама `collectOwnerDecisions` (`live-exam.ts:77-90`) записывает правила, принятые ночью и простоявшие 7 дней, как `expected: "night_decides"`, тогда как `night-policy.json:96` классифицирует их как `night_proposes`, гарантируя, что каждое автоматически принятое правило становится промахом (`miss`) на экзамене политики!
- **Последствия для пользователя:** Политика ночи (`night-policy.json`) и реальный код живут в параллельных вселенных: политика торжественно запрещает авто-принятие правил без предложения, код каждую ночь принимает десятки правил напрямую с клеймом `"owner-confirmed"` (на хабе за сутки `rulesAdopted: 27`), а растущий экзамен `exam-v2` во-первых никогда не собирается ночью автоматически, а во-вторых имеет взаимоисключающую разметку с самой политикой.
- **Проверенные файлы и строки (`295497fc`):**
  - `policy/night-policy.json:96-106`
  - `docs/night-policy.md:97-106,143-150,186-188`
  - `src/rooms/self-repair/server/rule-scan.ts:486,494`
  - `src/rooms/self-repair/server/insights.ts:49-72,97-143`
  - `src/rooms/policy/live-exam.ts:64-91,129-131`
  - `src/rooms/wall/acceptance.ts:167-188`
- **Минимальный ремонт:** Не маркировать авто-принятые правила (`by === "auto"`) концептом `"owner-confirmed"` в `insights.ts:58` (использовать `"auto-adopted"`, как при `rewordAdoptedRule` на строке 186); подключить `collectAndAppend` к ночному крону; устранить противоречие между `night-policy.json` (`rule_trial_apply: night_proposes`) и `live-exam.ts:89` (`expected: "night_decides"`).
- **Проверка приёмки:** Вызов `acceptRuleProposal(db, projectId, id, rule, "auto")` создаёт запись в `lane_pilot_memory` с концептом `"auto-adopted"`, а не `"owner-confirmed"`.
- **Прожарка:** В `night-policy.json` три абзаца доказывают со ссылками на владельца, почему ночной цикл больше не имеет права сам ставить правила на пробу; тем временем `rule-scan.ts` каждую ночь без спроса штампует по 27 правил прямо в `core`-память и подписывает их фальшивой печатью `"owner-confirmed"`.

<a id="f-010"></a>
#### F-010. Ловушка для правил PM: правила с `audience === "pm"` никогда не получают `applied > 0`, никогда не могут стать `confirmed` и гарантированно уничтожаются через 60 дней как `unused`

- **Статус:** `CONFIRMED-RUNTIME` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.3 / S-008 | **Область:** `packages/run-insights/src/rules.ts`, `src/rooms/self-repair/server/rule-scan.ts`, `insights.ts`
- **Обещание и источник:** В `src/rooms/self-repair/ui/rule-proposals.tsx:138-150` и `src/rooms/learning/service.ts:272-278` правила делятся на пулы `writer`, `pm` и `both`. Обещано, что принятые на испытание (`trial`) правила проверяются в работе и либо подтверждаются (`confirmed`), либо снимаются (`retired`), если они не работают.
- **Обнаруженное противоречие:**
  1. В `packages/run-insights/src/rules.ts:551-566` статистика испытания `ruleTrialStats` считает `applied` исключительно по таблице попыток писателей `lane_pilot_attempt_reasoning` (`$.dispatchContext.rulesPicked.picked`), куда попадают только правила писателей (`spawn.ts:501`). Применение правил PM (`pmResumeInstructions` в `learning/service.ts:277`) никуда не записывается (о чём вскользь упомянуто в комментарии `insights.ts:81`: `for the PM (no usage is recorded there)`).
  2. Однако в `src/rooms/self-repair/server/rule-scan.ts:365-388` функция `evaluateRules` гонит **все** авто-принятые правила (включая `audience === "pm"`) через `decideRuleTrial(rule, stats, now)` (`packages/run-insights/src/rules.ts:614-622`)!
  3. В `decideRuleTrial` (`rules.ts:618-620`):
     - для подтверждения (`confirm`) требуется `stats.applied >= 5` (`RULE_TRIAL.confirmAfterApplied`), но у любого правила с `audience === "pm"` `stats.applied` **всегда равен 0** — оно **никогда** не может стать `confirmed`!
     - зато на строке 618-619 проверяется `if (now - since >= RULE_TRIAL.unusedAfterMs) return { action: "retire", reason: "unused" }`. Так как `stats.lastAppliedAt` у PM-правила всегда `null`, ровно через 60 дней после принятия (`revisionStartedAt`) **каждое** авто-принятое правило PM безоговорочно удаляется как `"unused"`, сколько бы раз PM ни читал его в чатах!
- **Последствия для пользователя:** На живом хабе (`bb lane-pilot waiting --json`) `rulesConfirmed` равен `0` (при `rulesAdopted: 27`). Ни одно правило с `audience: "pm"` в принципе не способно пройти испытание, в UI (`rule-proposals.tsx:135`) у него вечно горит `Применено: 0`, оно первым идёт под нож в `weakestTrialRule` (`insights.ts:87`) и гарантированно списывается в утиль через 60 дней.
- **Проверенные файлы и строки (`295497fc`):**
  - `packages/run-insights/src/rules.ts:551-566,614-622`
  - `src/rooms/self-repair/server/rule-scan.ts:365-389`
  - `src/rooms/self-repair/server/insights.ts:81-90`
  - `src/rooms/learning/service.ts:274-278`
- **Минимальный ремонт:** В `evaluateRules` (`rule-scan.ts:367`) не списывать правила с `audience === "pm"` по `unused` (или записывать факт доставки PM-правил в `pmResumeInstructions` / `activation.ts` и учитывать их в `ruleTrialStats`).
- **Проверка приёмки:** Тест в `packages/run-insights/tests/rules.test.ts`: правило с `audience: "pm"` не получает `{ action: "retire", reason: "unused" }` при отсутствии записей в `lane_pilot_attempt_reasoning`.
- **Прожарка:** Для правил PM забыли сделать счётчик применений, честно написали об этом в комментарии `// no usage is recorded there`, а через 200 строк подключили их к общему трибуналу `decideRuleTrial`, который приговаривает любое правило с нулём применений к расстрелу за тунеядство.

<a id="f-011"></a>
#### F-011. Служебные графы `lp.model-rebench` и `lp.critic-edit`: картезианский взрыв в SQL-запросе `evaluateModelRouting` и мёртвый параметр `bench: ""`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.3 / S-009 | **Область:** `src/rooms/night-graphs/server/model-rebench-graph.ts`, `critic-edit-graph.ts`
- **Обещание и источник:**
  1. `src/rooms/night-graphs/server/model-rebench-graph.ts:37-40`: «Evaluates Jev model routing choices ('writer.model' and 'route.workflow') against actual task/workflow outcomes over the past 30 days.»
  2. `src/rooms/night-graphs/server/critic-edit-graph.ts:39-41`: месячный крон `lp.critic-edit` сравнивает базовый критик и предложение на эталонном наборе (`bench`).
- **Обнаруженное противоречие:**
  1. **Картезианский взрыв и битый JOIN в `evaluateModelRouting` (`src/rooms/night-graphs/server/model-rebench-graph.ts:50-63`):** Запрос делает `FROM lane_pilot_jev_receipt r LEFT JOIN lane_pilot_attempt a ON a.task_id = r.subject`. Во-первых, у одной задачи (`task_id`) в `lane_pilot_attempt` бывает несколько попыток (например, 2 упавших и 1 `accepted`), поэтому `LEFT JOIN` размножает одну квитанцию Jev на все попытки задачи и считает каждую попытку как отдельное решение Jev (`evaluated++`, `byModel[modelKey].total++`), занижая `winRate` даже у задач, которые в итоге были приняты! Во-вторых, для `r.judgment = 'route.workflow'` в `r.subject` вообще лежит не `task_id` (там `"workflow-route"` или `runId`), поэтому `a.state` всегда `null`, а `r.outcome` у `route.workflow` не ставится — все вызовы `route.workflow` засчитываются как `agreed = false` (промах)!
  2. **Мёртвый запуск бенча в `critic-edit-monthly` (`src/rooms/night-graphs/server/critic-edit-graph.ts:39,68`):** На строке 39 условие запуска бенча проверяет `if (criticEditTrialOn(stored) && input(c, "bench") === "on" && proposal)`, но сам же месячный крон на строке 68 запускает граф с `inputs: { project_id: project.id, bench: "" }`! В результате `criticEditTrial` в ежемесячном прогоне **не вызывается никогда**, `verdict` всегда `null`, `judgeSharedTrial([], ...)` всегда возвращает `wait`, и граф каждый месяц вхолостую завершается со статусом `waiting_bench`.
- **Последствия для пользователя:** Ежемесячный `lp.model-rebench` считает фальшивую статистику из-за некорректного `LEFT JOIN` один-ко-многим, а ежемесячный `lp.critic-edit` никогда не запускает испытание на бенче, потому что сам передаёт себе `bench: ""` вместо `"on"`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/night-graphs/server/model-rebench-graph.ts:49-106,257-275`
  - `src/rooms/night-graphs/server/critic-edit-graph.ts:38-49,53-71`
- **Минимальный ремонт:** В `evaluateModelRouting` связывать с финальным состоянием задачи (`EXISTS (SELECT 1 FROM lane_pilot_attempt a WHERE a.task_id = r.subject AND a.state = 'accepted')`) вместо `LEFT JOIN`; в `critic-edit-graph.ts:68` передавать `bench: "on"`.
- **Проверка приёмки:** Задача с двумя попытками (`validation_failed`, затем `accepted`) даёт в `evaluateModelRouting` ровно `evaluatedDecisions: 1, agreedOutcomes: 1, winRate: 1`.
- **Прожарка:** В `critic-edit-graph.ts` на строке 39 поставили замок `if (input(c, "bench") === "on")`, а через 29 строк в том же файле в кроне заботливо передали `inputs: { bench: "" }` — идеальная энергосберегающая калибровка: раз в месяц проснуться, проверить, что сам себе не разрешил работать, и лечь спать дальше.

<a id="f-012"></a>
#### F-012. Рассинхрон графа `workflows/lp.rules-scan.json` с кодом при `state === "fallback"` и `jobs=0`: граф не останавливается на `collect`, а при `fallback` пропускает `evaluateRules`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.3 / S-009 | **Область:** `workflows/lp.rules-scan.json`, `src/rooms/self-repair/server/rule-scan.ts`
- **Обещание и источник:** В `workflows/lp.rules-scan.json:51` в правиле узла `collect` написано: «Without System One the text-grouping fallback runs **and the scan ends here**». А при обычном прогоне без новых групп (`jobs=0`) ночной скан должен оценить уже действующие правила на испытании (`evaluateRules`).
- **Обнаруженное противоречие:**
  1. В `workflows/lp.rules-scan.json:123-140` у рёбер `collect → analyze → apply → done` нет ни одного условия `when` или `skip_when`! Поэтому при `collect.state === "fallback"` (и при `collect.jobs.length === 0`) граф **не заканчивается на `collect`**, а безусловно выполняет узел `analyze` (записывая шаг агента с 0 вызовов) и узел `apply`.
  2. Хуже того, в `src/rooms/self-repair/server/rule-scan.ts:459` первая же строка `applyScan` гласит: `if (plan.state === "fallback") return { proposals: 0, adopted: 0, errors: 0, reason: null };` — **до** вызова `adoptRuleProposal` для ожидающих правил (строка 492) и **до** вызова `evaluateRules(projectId, rewrites)` (строка 497)! То есть когда Jev недоступен (`fallback`), ночной скан вообще перестаёт подтверждать (`confirm`) или снимать (`retire`) правила, уже находящиеся на испытании, хотя для `decideRuleTrial` (кроме `revise`) никакой анализатор и никакой Jev не нужны!
- **Последствия для пользователя:** При недоступном Jev (`fallback`) скан вопреки описанию узла `collect` проходит все шаги графа, но при этом пропускает `evaluateRules` и `adoptWaitingRules`.
- **Проверенные файлы и строки (`295497fc`):**
  - `workflows/lp.rules-scan.json:51,123-140`
  - `src/rooms/self-repair/server/rule-scan.ts:425-430,458-501`
  - `src/rooms/night-graphs/server/rules-scan-graph.ts:44-80`
- **Минимальный ремонт:** В `applyScan` (`rule-scan.ts:459`) при `plan.state === "fallback"` всё равно выполнять `evaluateRules(projectId, new Map())` для уже принятых правил; в `lp.rules-scan.json` добавить `skip_when: "collect.jobs.length == 0"` на шаг `analyze`.
- **Проверка приёмки:** При `plan.state === "fallback"` правило на испытании с 5 успешными применениями всё равно переводится в `trialState = "confirmed"`.
- **Прожарка:** Узел `collect` в JSON-паспорте гордо заявляет «при fallback скан заканчивается здесь», но рёбра графа об этом не предупредили — поэтому граф топает до конца через `analyze` и `apply`, чтобы в `apply` сделать `return` ровно перед проверкой действующих правил.

<a id="f-013"></a>
#### F-013. Черная дыра интеграционных ворот: `integration-gate.ts` шлёт `fix turn` в тред писателя уже закрытой (`accepted`) попытки без `reopenAttempt`, без живого worktree и без цикла проверки/слияния

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P1 | **Уверенность:** Высокая | **Сценарий:** T-002.4 / S-010 | **Область:** `src/rooms/verification/server/integration-gate.ts`, `src/rooms/writer/server/finish.ts`
- **Обещание и источник:** `CHANGELOG.md:60` (0.1.443) и `src/rooms/verification/server/integration-gate.ts:628`: «the culprit's fix turn goes to the writer alone, **its fix coming back as the task's result, like any other turn.**» Также в `docs/run-goal.md:22` для `run-goal` до сих пор написано: «`failed`: a red check that counts, with the culprit commit and task, **and one message to the PM**», хотя `run-goal.ts:34` больше не шлёт ничего в PM.
- **Обнаруженное противоречие:** Проследим путь, когда `integration-gate.ts` находит задачу-виновника (`culprit`) после слияния:
  1. Интеграционные ворота запускаются **после** того, как попытка задачи (`culprit.attemptId`) уже прошла `gitIntegrate` (при котором её worktree был **удалён**!), перешла в терминальное состояние `accepted` (`finish.ts:996`), а цикл `startWriterTask` для неё **завершился**.
  2. В `src/rooms/verification/server/integration-gate.ts:623-629` ворота делают буквально два вызова:
     ```ts
     if (culprit.attemptId) await saveFollowUp(bb.storage.kv, culprit.attemptId, Date.now());
     await sendServiceMessage(bb, { threadId: culprit.threadId, text: prompt, senderThreadId: pmThreadId });
     ```
  3. И всё! В отличие от `checkMainAfterMerge` (`finish.ts:1106`), которая создаёт и диспатчит новую задачу `-mainfix` через `services.dispatchWriter`, и в отличие от `answerWriter` (`reopen-attempt.ts:99-123`), который переводит попытку в `running` и вызывает `services.startWriterTask`, `integration-gate.ts` **не вызывает ни `reopenAttempt`, ни `startWriterTask`, ни `dispatchWriter`**!
  4. Что происходит в реальности, когда `sendServiceMessage` будит старый тред писателя (`culprit.threadId`):
     - его worktree уже удалён при слиянии (`gitIntegrate`), либо если писатель начинает править файлы, то никто не ждёт окончания его хода (`waitThreadIdle` не запущен), никто не запускает `finishWriterAttempt`, никто не проверяет и **не сливает** его правки в `main`, и никакое уведомление «as that task's result» в чат PM никогда не приходит, потому что попытка уже давно в терминальном состоянии `accepted`!
- **Последствия для пользователя:** Когда интеграционные ворота (`integration-gate`) падают и находят виновную задачу (`culprit`), проблема **теряется полностью**: на экран «Ждут владельца» ничего не пишется (так как виновник найден!), в чат PM ничего не пишется (по правилу 0.1.443!), а сообщение улетает в сиротский тред писателя без worktree и без оркестратора, который бы проверил и влил фикс в `main`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/verification/server/integration-gate.ts:615-633`
  - `src/rooms/writer/server/finish.ts:971-980,996,1100-1108`
  - `src/rooms/writer/server/reopen-attempt.ts:85-124`
  - `docs/run-goal.md:22`
- **Минимальный ремонт:** В `integration-gate.ts:623-631` вместо голой отправки сообщения в закрытый тред писателя диспатчить задачу починки (`-mainfix`) через `services.dispatchWriter` (как это делает `checkMainAfterMerge` в `finish.ts:1106`), либо при невозможности — публиковать строку на «Ждут владельца» (`this.noteRed`); обновить `docs/run-goal.md:22`.
- **Проверка приёмки:** Тест в `tests/verification/integration-gate.test.ts`: при найденном `culprit` создаётся новая попытка/задача починки или запись на «Ждут владельца», а не безответный `sendServiceMessage` в завершённый тред.
- **Прожарка:** Чтобы не будить PM, интеграционные ворота решили поручить починку напрямую писателю: крикнули задание в закрытую дверь уволенного сотрудника, у которого уже отобрали верстак (`worktree`), не поставили приёмщика на выходе и с гордостью записали в лог «fix turn sent, the fix will come back as the task's result».

<a id="f-014"></a>
#### F-014. Двойной обман во втором пилоте (`second-pilot.ts`): `sendPmNotice` возвращает `true` при упавшей отправке (теряя вопрос владельцу), а исходная попытка при `narrow` остаётся `blocked` вместо `superseded`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.4 / S-011 | **Область:** `src/rooms/core/server/pm-notice.ts`, `src/rooms/writer/server/second-pilot.ts`, `question-timeout.ts`
- **Обещание и источник:**
  1. `docs/relay.md:31`: «`sendPmNotice` (`src/rooms/core/server/pm-notice.ts`) **returns false when the send is refused**, so a caller falls back to the list instead of counting a warm chat as delivery.»
  2. `src/rooms/writer/server/second-pilot.ts:24-25`: «`narrow` — a human is needed for part of the task, the rest is doable: a new task with the narrowed contract is dispatched and **the original attempt ends as superseded**».
- **Обнаруженное противоречие:**
  1. Открываем `src/rooms/core/server/pm-notice.ts:11-16`:
     ```ts
     export async function sendPmNotice(bb: Pick<BbPluginApi, "sdk">, threadId: string, text: string, now = Date.now(), freshMs = PM_NOTICE_FRESH_MS): Promise<boolean> {
       const thread = await Promise.resolve().then(() => bb.sdk.threads.get({ threadId })).catch(() => null) as { updatedAt?: unknown } | null;
       const updatedAt = Number(thread?.updatedAt ?? 0);
       if (!thread || !Number.isFinite(updatedAt) || now - updatedAt > freshMs) return false;
       await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
       return true;
     }
     ```
     Вопреки прямому утверждению в `docs/relay.md:31`, `sendPmNotice` **проглатывает ошибку `threads.send` через `.catch(() => undefined)` и безусловно возвращает `true`**! В результате `leaveToOwner` в `second-pilot.ts:230` (`if (pmThreadId && await sendPmNotice(bb, pmThreadId, text, now)) return;`) считает, что сообщение доставлено, и **не вызывает `postOwnerItem`**!
  2. В `src/rooms/writer/server/second-pilot.ts:207` при `outcome === "narrow"` вызывается `await doors.end("superseded by ...")`. Но `doors.end` в `question-timeout.ts:37-44` переводит попытку вовсе не в состояние `"superseded"`, а обратно в состояние **`"blocked"`** с префиксом `verdict_block: question_unanswered: superseded by ...`! Из-за этого исходная попытка остаётся в состоянии `blocked` и через сутки попадает в `dead_letters` (`queue-tool.ts:35-37`: задачи, чья последняя попытка закончилась `blocked`), требуя от PM-а чинить или отменять задачу, которую второй пилот уже заменил суженной копией `.n`!
- **Последствия для пользователя:** При сбое отправки в тёплый чат PM вопрос писателя теряется (не попадая ни в чат, ни на «Ждут владельца»), а каждая суженная вторым пилотом задача (`narrow`) оставляет свою старую версию в `blocked` и засоряет `dead_letters`.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/core/server/pm-notice.ts:11-16`
  - `src/rooms/writer/server/second-pilot.ts:24-26,206-208,228-234`
  - `src/rooms/writer/server/question-timeout.ts:37-44,75-81`
  - `docs/relay.md:31`
- **Минимальный ремонт:** В `pm-notice.ts:15` возвращать `false` в `.catch(() => false)`; в `question-timeout.ts` при `narrow` переводить попытку в состояние `"superseded"` вместо `"blocked"`.
- **Проверка приёмки:** Если `bb.sdk.threads.send` бросает исключение, `sendPmNotice` возвращает `false`, а `leaveToOwner` создаёт запись в `lane_pilot_owner_item`.
- **Прожарка:** Документация `docs/relay.md` гордо рассказывает, что `sendPmNotice` возвращает `false` при отказе отправки, а в самом `pm-notice.ts` из 6 строк кода две последние — это `.catch(() => undefined); return true;`. Хоть трактор на сервер урони — доставка всегда успешна!

<a id="f-015"></a>
#### F-015. Шизофрения каталога настроек: дефолт писателя в каталоге (`kimi` / `low` / `standard`) противоречит коду (`codex` / `gpt-6-luna` / `high` / `fast`), дубль `night_review.model` и невидимые `owner.words` / `phase.rails`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.5 / S-012 | **Область:** `packages/settings-catalog`, `docs/enabled-settings.md`, `src/rooms/front/logic.ts`
- **Обещание и источник:** В `docs/self-improvement-settings.md:75` и `docs/enabled-settings.md:26-28` заявлено, что каталог настроек (`UI_CATALOG`, `SETTING_CATALOG`) и сгенерированная страница `docs/enabled-settings.md` показывают реальные дефолты, которые использует код.
- **Обнаруженное противоречие:**
  1. **Тройное расхождение дефолта писателя:** В `packages/settings-catalog/src/ui-catalog.ts:34,52,53` и `docs/enabled-settings.md:261,263,267` указано: `writer.provider = kimi`, `writer.reasoning_effort = low`, `writer.service_tier = standard`. Однако реальная функция наследования `inheritProjectValues` в том же пакете (`packages/settings-catalog/src/lp-defaults.ts:63-68`) при отсутствии выбранного писателя подставляет совсем другое: `writer.provider = "codex"`, `writer.model = "gpt-6-luna"`, `writer.reasoning_effort = "high"`, `writer.service_tier = "fast"`.
  2. **Дубликат ключа `night_review.model` с противоположными каналами в `SETTING_CATALOG` (`packages/settings-catalog/src/channels.ts:300-306`):** На строке 300 записано `{ key: "night_review.model", channel: "OWN", ... }`, а ровно через две строки (строки 303-306) — `{ key: "night_review.model", channel: "NONE", reason: UNAPPLIED_REASON.nightReviewModel }`! При этом в `channels.ts:296-298` прямо написано, что `night_review.enabled`, `night_review.auto_merge` и `night_review.max_fix_tasks` не читаются ни одной стадией (`no stage reads it yet`), но в UI (`src/rooms/ui-shell/ui/tab-work.tsx:71-79` и `ui-catalog.ts:35-37`) они рендерятся как рабочие редактируемые переключатели и слайдеры!
  3. **Ключевые настройки `owner.words` и `phase.rails` вообще отсутствуют в `UI_CATALOG` и `SETTING_CATALOG` (`docs/enabled-settings.md`):** Хотя в 0.1.442 дефолт `owner.words` сменили на `"risky"`, в каталоге настроек его нет, `validateSettingValue` (`setting-validation.ts`) его не валидирует (в `save_setting` можно записать любую опечатку, и `ownerWordsMode` в `words.ts:21` молча превратит любую строку кроме `"off"` и `"on"` в `"risky"`!), а мастер первого запуска (`src/rooms/front/logic.ts:13,36`) до сих пор знает только бинарный вопрос «yes/no» и перезаписывает `owner.words` в `"on"` или `"off"`, не зная про `"risky"`.
  4. **Несвязанные настройки в `docs/self-improvement-settings.md:68,96-97`:** Документация утверждает, что `harness.probe.token_budget` и `harness.graph_edits` являются настройками в каталоге и на экране Self-improvement, но в `src/rooms/improvement/keys.ts:28-49` и `packages/settings-catalog/src/ui-catalog.ts` этих ключей **нет вообще** (0 вхождений).
- **Последствия для пользователя:** Документация и UI показывают пользователю одни дефолты (`kimi` / `low` / `standard`), код запускает другие (`codex` / `gpt-6-luna` / `high` / `fast`), на вкладке «Работа» висит мёртвая секция переключателей `night_review.*`, которая ничего не включает, а настройки `owner.words`, `phase.rails`, `harness.probe.token_budget` и `harness.graph_edits` отсутствуют в каталоге и валидаторе.
- **Проверенные файлы и строки (`295497fc`):**
  - `packages/settings-catalog/src/ui-catalog.ts:34-37,52-53`
  - `packages/settings-catalog/src/lp-defaults.ts:63-68`
  - `packages/settings-catalog/src/channels.ts:296-306`
  - `src/rooms/ui-shell/ui/tab-work.tsx:71-79`
  - `src/rooms/front/logic.ts:13,35-37`
  - `src/rooms/tasks/words.ts:19-22`
  - `docs/self-improvement-settings.md:68,96-97`
  - `docs/enabled-settings.md:148-153,261-267`
- **Минимальный ремонт:** Удалить дубль `night_review.model` из `channels.ts:303-306`; синхронизировать дефолт `writer.*` между `ui-catalog.ts` и `lp-defaults.ts`; добавить `owner.words` (`on | risky | off`) и `phase.rails` (`on | off`) в каталог и валидатор `setting-validation.ts`.
- **Проверка приёмки:** `validateSettingValue("owner.words", "invalid")` возвращает ошибку `invalid_choice`, а в `SETTING_CATALOG` нет дублирующихся `key`.
- **Прожарка:** Каталог настроек клянётся, что дефолтный писатель — это неторопливый `kimi` на `low` и `standard`, а `lp-defaults.ts` из соседнего файла того же пакета втихаря подсовывает `codex / gpt-6-luna` на `high` и `fast`; зато для несуществующего ночного ревьюера на вкладке «Работа» заботливо нарисовали тумблер «Автослияние» и ползунок от 1 до 10, которые подключены в пустоту.

<a id="f-016"></a>
#### F-016. Несостыковки CHANGELOG 0.1.440–0.1.456 с кодом: забытый `reset_project_settings` в 0.1.445 и фантомный релиз `0.1.458` в `docs/relay.md`

- **Статус:** `CONFIRMED-CODE` | **Серьёзность:** P2 | **Уверенность:** Высокая | **Сценарий:** T-002.5 / S-012 | **Область:** `src/rooms/settings/server/rpc/settings.ts`, `CHANGELOG.md`, `docs/relay.md`
- **Обещание и источник:**
  1. `CHANGELOG.md:52` (0.1.445): «**A global model pick is judged against every connected machine, not one of them.** ... On the global level the twelve selection saves ... now check the provider and the model against the merged catalog of all connected machines through one helper... The owner asked that the machine not matter for a global pick.»
  2. `CHANGELOG.md:5` фиксирует текущую версию `0.1.456` (`package.json` = `0.1.456`).
- **Обнаруженное противоречие:**
  1. В 0.1.445 перевели `selectionsRpc` (`src/rooms/settings/server/rpc/selections.ts`) на `services.selectionCatalog(projectId, hostId, providerId)`, который для `projectId === "*"` берёт объединённый каталог всех машин. Но в `reset_project_settings` (`src/rooms/settings/server/rpc/settings.ts:311-329`) **оставили старый код**: он вызывает `services.selectionCatalogHost(projectId)` и затем напрямую дёргает `bb.sdk.providers.list({ hostId: host.hostId })` и `bb.sdk.providers.models({ hostId: host.hostId, providerId })` на **одной** машине! Поэтому если владелец на глобальном уровне (`*`) сохранил модель, которая есть на второй машине, но отсутствует на первой (`host.hostId`), то при попытке сбросить настройку (`reset_project_settings`) сервер проверит унаследованную модель только по одной машине и вернёт ошибку `"inherited selection is unavailable in this host catalog"`!
  2. В `docs/relay.md:31` на текущем коммите `295497fc` (версия `0.1.456`) написано: «**and since 0.1.458 the four sends the grills of 0.1.456 still found**: the learning room's evening digest (`src/rooms/learning/service.ts`), a schedule's failed run (`src/rooms/schedule/server/schedule-service.ts`), the backlog scanner's hourly work order (`src/rooms/backlog/server/scanner.ts`: it offers on the list, the owner's button sends the order) and the post-merge machine/mainfix notes (`src/rooms/writer/server/finish.ts`).» При этом сам `CHANGELOG.md` заканчивается на `0.1.456`, а три из четырёх перечисленных файлов (`learning/service.ts`, `schedule-service.ts`, `backlog/server/scanner.ts`) в рабочем дереве всё ещё содержат старый код, который шлёт сообщения в чат PM (см. [F-007](#f-007))!
- **Последствия для пользователя:** Сброс настроек модели (`reset_project_settings`) падает из-за проверки по одной машине вопреки обещанию 0.1.445, а документация `docs/relay.md` описывает фиксы из несуществующего будущего релиза `0.1.458`, которых нет в коде.
- **Проверенные файлы и строки (`295497fc`):**
  - `src/rooms/settings/server/rpc/settings.ts:311-330`
  - `src/rooms/writer/server/writer-host.ts:128-144`
  - `docs/relay.md:31`
  - `CHANGELOG.md:5,52`
- **Минимальный ремонт:** В `reset_project_settings` (`src/rooms/settings/server/rpc/settings.ts:315,321`) вызывать `services.selectionCatalog(projectId, host.hostId, providerId)` вместо прямых вызовов `bb.sdk.providers.list/models`; синхронизировать `docs/relay.md:31` с реальным кодом.
- **Проверка приёмки:** `reset_project_settings` для проекта с глобальной моделью со второй машины проходит через `services.selectionCatalog` и не падает с `"inherited selection is unavailable in this host catalog"`.
- **Прожарка:** В 0.1.445 починили сохранение модели, чтобы одна капризная машина не блокировала выбор, но забыли починить кнопку «Сбросить» в соседнем файле — так что зайти в настройку со всех машин можно, а выйти обратно нельзя; зато в `docs/relay.md` уже написали мемуары про то, как в далёком 0.1.458 победили баги, найденные на сегодняшней прожарке 0.1.456.

---

### 4.3 Гипотезы и следующие шаги проверки

- **H-001 (`HYPOTHESIS` — гонка `openForms` в `workflow-executors.ts:400-442` при перезапуске плагина):** В `src/rooms/workflow/server/workflow-executors.ts:401` множество открытых форм `openForms` хранится в оперативной памяти, а карточка `postOwnerItem` с `key: workflowQuestionKey(runId, stepKey)` при отсутствии PM-чата пишется в SQLite (`INSERT OR IGNORE`). Если шаг `builtin:human` перезапускается после релоада плагина в проекте с PM-чатом, `openForms` пуст, и `askInBackground` вызовется повторно, создав дублирующую форму в треде PM. *Как проверить:* запустить граф с узлом `human` в проекте с PM-чатом, перезагрузить плагин до ответа и проверить число форм в треде.
- **H-002 (`HYPOTHESIS` — пропуск папки при отказе `opencode2` в ночном `rules-scan`):** Как отмечено в `CHANGELOG.md:28` (0.1.451), когда старт треда анализатора падает на ночном пути без PM-чата, событие BB содержит только `"Command thread.start failed"`, поэтому `readProviderFolderBlock` не пополняется автоматически, если отказ впервые произошёл ночью, а не в дневном графе. *Как проверить:* воспроизвести отказ `vk_required_session_policy_unenforceable_mcp_servers` на новой папке только через `rules-nightly` и проверить запись в KV `provider-folder-block:*`.

---

### 4.4 UX-суждения

- **U-001 (`UX-JUDGMENT` — слепые плашки доказательств в «Подробностях» на экране «Ждут владельца»):** В `src/rooms/owner-waiting/ui/owner-waiting-board.tsx:85` плашки `evidence` (`attempt`, `task`, `run`, `file`, `note`) рендерятся как некликабельные `<span>`, обрезающие ID попытки до 8 символов (`shortRef`), без кнопки копирования и без перехода к запуску/задаче. Владельцу или разработчику приходится доставать полный ID из `title`-тултипа наведением мыши (на телефоне тултип недоступен вовсе). *Как валидировать:* проверить сценарий открытия «Подробностей» на мобильном экране (375px), где `title`-атрибут не читается.
- **U-002 (`UX-JUDGMENT` — технический жаргон `exact / partial / miss` на кнопках блока «Разметка» Штурмана):** В `src/rooms/lead/ui/lead-section.tsx:125-127` на экране «Самоулучшение» (который в 0.1.456 специально переводили на русский язык без английских идентификаторов) три кнопки оценки судьи подписаны сырыми английскими кодами `{verdict}` (`exact`, `partial`, `miss`) вместо русских подписей «Совпал / Отчасти / Мимо», хотя в уведомлении `service.ts:267` владельцу обещают именно русские слова «(совпал / отчасти / нет)». *Как валидировать:* сверить текст в `service.ts:267` с рендером кнопок в `lead-section.tsx:126`.

---

## 5. Прожарка (The roast)

Lane Pilot 0.1.456 — это грандиозный памятник бюрократической автоматизации, где каждая комната обвешана конституциями, экзаменами Вильсона, каппой Коэна и манифестами «Владелец больше не в цикле», но стоит проследить любую цепочку через две двери подряд, как выясняется, что первая дверь заколочена фанерой, а вторая ведёт в лифтовую шахту.

1. **«Экзамен зрелости Штурмана», который сдают за него его же подчинённые ([F-001](#f-001), [F-002](#f-002), [F-003](#f-003), [F-004](#f-004), [F-005](#f-005)).** Вся философия комнаты `lead` держится на том, что Штурман получает право решать сам только после 20 честных угадываний личных ответов владельца. Для защиты от накрутки в 0.1.453 сделали грозный фильтр `PROXY_ANSWERERS = new Set(["lead", "agent"])`. Беда в том, что когда PM записывает слово через `lane_pilot_queue word` (`answered_by = "pm"`) или `lane_pilot_phase word` (`answered_by = "owner via pm"`), или сам Штурман жмёт кнопку в своём чате (`"lead-chat"`), вахтёр `examEligible` пропускает их всех за личную подпись владельца ([F-001](#f-001)). Если же настоящий владелец нажмёт честную кнопку «Потом» (`later`), то через неделю при повторном показе этой же ветки журнал решений молча проигнорирует и новый прогноз, и новый ответ владельца, потому что ID решения прибили гвоздями к ID ветки через `INSERT OR IGNORE` ([F-002](#f-002)). А чтобы статистика на бэктесте выглядела красиво (37 из 38 угаданных!), функция `historyOf` в `journal.ts` просто забыла отфильтровать будущие ответы по дате и даёт предсказателю подглядывать в завтрашний день ([F-005](#f-005)), пока специально созданная таблица `lane_pilot_lead_label` стоит в БД абсолютно пустой декорацией ([F-004](#f-004)).

2. **Экран «Ждут владельца»: вход рубль, выход — через SQL ([F-006](#f-006), [F-007](#f-007), [F-008](#f-008)).** В 0.1.456 заголовки карточек бережно переписали для «человека, а не программиста». Вот только из 16 мест в коде, которые пишут в `lane_pilot_owner_item`, автоматическое закрытие (`closeOwnerItem`) есть лишь у четырёх, а кнопки действий на экране — вообще у двух ([F-006](#f-006)). Закрыли фазу? Карточка `phase-word` остаётся висеть вечно (именно об этот труп закрытой фазы `ph_97edc5c189` споткнулся живой Штурман на хабе!). Ответили писателю или перезапустили задачу? Карточка `writer-question` висит вечно. Починили красные ворота или `run-goal`? Старая красная карточка висит вечно. Зато единственное решение, которого система реально ждёт 6 часов и о котором кричит первая же плашка `docs/owner-waiting.md` — слово владельца на приземление рисковой задачи (`OWNER_WORD_WAIT_MS` в `finish.ts:826`) — вообще забыли отправить в `postOwnerItem` ([F-008](#f-008))! Задача 6 часов невидимкой держит в заложниках слот писателя и свою `area`, а в это время четыре фоновых крона (`learning-digest`, `schedule-service`, `backlog-scan` и `checkMainAfterMerge`) наплевали на закон 0.1.443 о тишине и продолжают будить чаты PM ([F-007](#f-007)).

3. **Ночной суд Кафки и фальшивые печати ([F-009](#f-009), [F-010](#f-010), [F-011](#f-011), [F-012](#f-012)).** В `policy/night-policy.json` написано целое эссе о том, почему ночной цикл не смеет сам принимать правила в `core`-память (`rule_trial_apply` = `night_proposes`). Но `rule-scan.ts` эту политику даже не импортирует: каждую ночь он сам пихает десятки правил в `core`-память, выкидывая оттуда старые конвенции и ставя на авто-правила концепт `"owner-confirmed"` ([F-009](#f-009)). Ещё смешнее судьба правил для PM (`audience: "pm"`): для них забыли сделать учёт применений (`applied` всегда `0`), поэтому они никогда не могут стать `confirmed`, а через 60 дней ночной судья `decideRuleTrial` гарантированно казнит каждое из них как `"unused"` ([F-010](#f-010)). На соседней полке месячный граф калибровки критиков `lp.critic-edit` проверяет `if (input(c, "bench") === "on")` и сам же вызывает себя из крона с `bench: ""`, гарантируя вечный холостой ход ([F-011](#f-011)).

4. **Починка в рельсу и настройки-призраки ([F-013](#f-013), [F-014](#f-014), [F-015](#f-015), [F-016](#f-016)).** Когда интеграционные ворота после слияния находят виновную задачу, они не открывают новую попытку и не создают `-mainfix`: они просто кидают текстовое сообщение в старый тред писателя уже закрытой (`accepted`) задачи, у которой при слиянии снесли `worktree`, и уходят, искренне веря, что «фикс вернётся как результат задачи» ([F-013](#f-013)). А в каталоге настроек дефолтный писатель одновременно числится как `kimi / low / standard` (в таблице и UI) и как `codex / gpt-6-luna / high / fast` (в `lp-defaults.ts`), пока `docs/relay.md` на полном серьёзе цитирует исправления из ещё не родившегося релиза `0.1.458` ([F-015](#f-015), [F-016](#f-016)).

---

## 6. Иерархия ремонта (Repair hierarchy)

| Порядок / ID | Находки | Ремонт и зависимости | Проверка приёмки (Acceptance check) | Статус |
| --- | --- | --- | --- | --- |
| **R-001** | [F-013](#f-013) | В `src/rooms/verification/server/integration-gate.ts:623-631` заменить отправку сообщения в закрытый тред `accepted`-попытки на диспатч `-mainfix` задачи через `services.dispatchWriter` (по аналогии с `checkMainAfterMerge` в `finish.ts:1106`), а при отказе диспатча — вызывать `this.noteRed(...)` | Тест в `tests/verification/integration-gate.test.ts`: падение ворот с найденным `culprit` вызывает `dispatchWriter` (или `postOwnerItem`), а не оставляет `accepted`-попытку без `startWriterTask` | Открыт |
| **R-002** | [F-008](#f-008) | В `src/rooms/writer/server/finish.ts:826-844` публиковать карточку `postOwnerItem` (`key: "task-word:" + runId + ":" + family`, `wake: true`, кнопки RPC `task_word`) при старте ожидания `OWNER_WORD_WAIT_MS` и вызывать `closeOwnerItem` при выходе из ожидания; в `queue-tool.ts:43` не советовать resend, пока попытка в `running` | Тест: при входе задачи с `risk: "high"` в `finish.ts:826` на `collectOwnerWaiting(db)` появляется карточка с `task_word`, а ответ `yes` закрывает её | Открыт |
| **R-003** | [F-006](#f-006) | Добавить RPC `owner_waiting_close` и кнопку «Убрать» для информационных карточек в `owner-waiting-board.tsx`; добавить вызовы `closeOwnerItem` при закрытии/остановке/возврате фазы (`driver.ts`), ответе/перезапуске/отмене задачи (`answer.ts`, `dispatch.ts`), зелёном прогоне `integration-gate.ts:455` и `run-goal.ts:32`, и обнулении `pendingLabelCount` (`lead/server/service.ts:246`) | Тест в `tests/owner-waiting.test.ts`: закрытие фазы закрывает `phase-word:*`, зелёный `integration-gate` закрывает `gate-red:*`, ответ писателю закрывает `writer-question:*` | Открыт |
| **R-004** | [F-001](#f-001), [F-002](#f-002) | В `src/rooms/lead/logic.ts:22,60` заменить `PROXY_ANSWERERS` на белый список `OWNER_ANSWERERS = new Set(["owner", "screen"])` (исключив `"pm"`, `"owner via pm"`, `"lead-chat"` и произвольные `--by`); в `src/rooms/lead/server/tick.ts:210` формировать `decisionId` с включением `tickId` (`lead:${row.id}:${tickId}`), чтобы повторное предложение после `later` создавало новую строку в `lane_pilot_decision` | Тесты в `tests/lead/logic.test.ts` и `tests/lead/service.test.ts`: `examEligible` отвергает `"pm"` и `"owner via pm"`; повторное предложение ветки после `later` записывает новый прогноз и новый ответ | Открыт |
| **R-005** | [F-007](#f-007), [F-014](#f-014) | В `learning/service.ts:295`, `schedule-service.ts:50`, `backlog/server/scanner.ts:52` и `finish.ts:1031` убрать прямые вызовы `threads.send` в чат PM (привести в соответствие с правилом 0.1.443 и тем, что уже заявлено в `docs/relay.md:31`); в `src/rooms/core/server/pm-notice.ts:15` возвращать `false` при ошибке `threads.send`; в `question-timeout.ts` при `narrow` ставить состояние `superseded` | Тест: `sendPmNotice` при ошибке `threads.send` возвращает `false`; `schedule-service` `onFailure` пишет в `postOwnerItem`, не вызывая `threads.send` | Открыт |
| **R-006** | [F-009](#f-009), [F-010](#f-010) | В `src/rooms/self-repair/server/insights.ts:58` ставить концепт `"auto-adopted"` при `by === "auto"`; в `rule-scan.ts:367` и `packages/run-insights/src/rules.ts:614` не списывать правила с `audience === "pm"` по `unusedAfterMs` (или записывать их применение); подключить `collectAndAppend` к ночному циклу и согласовать `expected` для `left_standing` с `night-policy.json` | Тест: авто-принятое правило получает `"auto-adopted"`, а правило с `audience: "pm"` не удаляется через 60 дней как `unused` | Открыт |
| **R-007** | [F-003](#f-003), [F-004](#f-004), [F-005](#f-005) | В `tick.ts:216` не публиковать карточку `kind: "proposal"` для элементов, идущих в `actable`; в `journal.ts:44` добавить `AND answered_at <= ?` в `historyOf`; в `cli.ts:147` убрать `deferred` из допустимых меток `lead label`; почистить `docs/lead.md:84` и мёртвую таблицу `lane_pilot_lead_label` | Тесты в `tests/lead/journal.test.ts` и `tests/lead/tick.test.ts`: `historyOf` не видит будущие ответы; `lead label <id> deferred` возвращает код 2 | Открыт |
| **R-008** | [F-011](#f-011), [F-012](#f-012) | В `model-rebench-graph.ts:50-63` исправить `LEFT JOIN lane_pilot_attempt` на проверку агрегированного результата задачи; в `critic-edit-graph.ts:68` передавать `bench: "on"`; в `rule-scan.ts:459` не пропускать `evaluateRules` при `plan.state === "fallback"` | Тест в `tests/night-graphs/`: задача с 3 попытками считается в `evaluateModelRouting` один раз; `applyScan` при `fallback` вызывает `evaluateRules` | Открыт |
| **R-009** | [F-015](#f-015), [F-016](#f-016) | Удалить дубль `night_review.model` в `channels.ts:303`; синхронизировать дефолты `writer.*` между `ui-catalog.ts` и `lp-defaults.ts`; добавить `owner.words` и `phase.rails` в каталог и валидатор; перевести `reset_project_settings` (`settings.ts:315`) на `services.selectionCatalog` | `npx tsx scripts/generate-enabled-settings.ts --check` проходит, `SETTING_CATALOG` не имеет дублей ключей | Открыт |

---

## 7. Покрытие и ограничения (Coverage and limitations)

| Зона / сценарий | Runtime | Source | Результат / ограничение | Следующая проверка |
| --- | --- | --- | --- | --- |
| **1. Штурман (`src/rooms/lead`)** | Проверено (`lead status`, `road`, `exam`, `rights`, `journal`) | Проверено полностью (все 23 файла комнаты + `docs/lead.md` + `policy/lead-policy.json` + `workflows/lead-tick.json`) | Подтверждены [F-001](#f-001)..[F-005](#f-005), [U-002](#u-002) | После патча R-004 и R-007 прогнать `npx vitest run tests/lead/` |
| **2. «Ждут владельца» (`src/rooms/owner-waiting`) и правило 0.1.443** | Проверено (`waiting --json`) | Проверено полностью (все 16 `postOwnerItem`, 4 `closeOwnerItem`, все 88 `threads.send` / `sendServiceMessage` / `sendPmNotice`) | Подтверждены [F-006](#f-006), [F-007](#f-007), [U-001](#u-001) | После патча R-003 и R-005 прогнать `npx vitest run tests/owner-waiting.test.ts` |
| **3. Слово владельца и риск (`owner.words`, `OWNER_WORD_WAIT_MS`)** | Read-only (без запуска 6ч цикла) | Проверено полностью (`finish.ts`, `words.ts`, `queue-tool.ts`, `driver.ts`, `front/logic.ts`) | Подтверждены [F-008](#f-008), [F-015](#f-015) | После патча R-002 проверить карточку `task-word` на `OwnerWaitingBoard` |
| **4. Ночной цикл и служебные графы (`self-repair`, `night-graphs`, `rule-forms`, `policy`)** | Проверено (срез `overnight` в `waiting --json`) | Проверено полностью (`rule-scan.ts`, `insights.ts`, `rules.ts`, `live-exam.ts`, `exam.ts`, `wall/acceptance.ts`, `model-rebench-graph.ts`, `critic-edit-graph.ts`, `lp.rules-scan.json`) | Подтверждены [F-009](#f-009)..[F-012](#f-012), [H-002](#43-гипотезы-и-следующие-шаги-проверки) | После патча R-006 и R-008 прогнать `npx vitest run tests/night-graphs/ tests/policy/` |
| **5. Ворота интеграции (`verification`) и цель запуска (`run-goal`)** | Read-only | Проверено полностью (`integration-gate.ts`, `run-goal.ts`, `run-goal/logic.ts`, `baseline/server/regress.ts`, `docs/run-goal.md`) | Подтверждены [F-013](#f-013) и часть [F-006](#f-006) | После патча R-001 прогнать `npx vitest run tests/verification/` |
| **6. Жизнь задачи писателя (`writer`, `tasks`, `relay`)** | Read-only | Проверено полностью (`dispatch.ts`, `start.ts`, `finish.ts`, `question-timeout.ts`, `second-pilot.ts`, `answer.ts`, `reopen-attempt.ts`, `pm-notice.ts`, `docs/relay.md`) | Подтверждены [F-014](#f-014), [H-001](#43-гипотезы-и-следующие-шаги-проверки) | После патча R-005 прогнать `npx vitest run tests/writer/` |
| **7. Каталог настроек (`packages/settings-catalog`, `docs/enabled-settings.md`)** | Read-only скрипт сверки всех 238 `OWN`-ключей | Проверено полностью (`channels.ts`, `ui-catalog.ts`, `lp-defaults.ts`, `setting-validation.ts`, `improvement/keys.ts`) | Подтверждён [F-015](#f-015) | После патча R-009 запустить `npx tsx scripts/generate-enabled-settings.ts --check` |
| **8. CHANGELOG 0.1.440–0.1.456 против кода** | Read-only | Проверены все пункты релизов 0.1.440–0.1.456 против коммита `295497fc` | Подтверждён [F-016](#f-016) (+ пересечения с F-001, F-006, F-007, F-008, F-012) | После патча R-009 проверить `reset_project_settings` |

*Ограничения аудита:* В соответствии с правилами задания код и БД не модифицировались, мутирующие команды и полный прогон тестов (900 файлов) не запускались, индекс GitNexus не пересобирался (занят другим процессом).

---

## 8. Хронология расследования (Investigation timeline)

| Время (UTC) | Задача / сценарий / находка | Проверка / решение / доказательство | Результат / следующее действие |
| --- | --- | --- | --- |
| 2026-11-01 11:55 | T-001 | Инициализирован живой отчёт, сняты read-only срезы `waiting`, `lead status/road/exam/rights/journal`, `schedule list`, `phase list` | GitNexus пропущен по ограничению задания (индекс занят другим процессом); начат аудит `src/rooms/lead` |
| 2026-11-01 12:02 | T-002.1 → F-001..F-005 | Проверены все файлы `src/rooms/lead/**`, `docs/lead.md`, `policy/lead-policy.json`, `workflows/lead-tick.json` и места вызовов `answerTaskWord`/`answerPhaseWord` | Подтверждены 5 дефектов в комнате Штурмана; переход к `src/rooms/owner-waiting` и правилу 0.1.443 |
| 2026-11-01 12:12 | T-002.2 → F-006..F-008 | Проверены `docs/owner-waiting.md`, `src/rooms/owner-waiting/**`, все 16 вызовов `postOwnerItem` и 4 вызова `closeOwnerItem`, все 88 вхождений `threads.send`/`sendServiceMessage`/`sendPmNotice`, цепочка `owner.words` и `OWNER_WORD_WAIT_MS` в `finish.ts` и `words.ts` | Подтверждены 3 крупных дефекта (F-006..F-008); переход к T-002.3 |
| 2026-11-01 12:22 | T-002.3 → F-009..F-012 | Проверены `src/rooms/self-repair/**`, `src/rooms/night-graphs/**`, `src/rooms/rule-forms/**`, `src/rooms/policy/**`, `packages/run-insights/src/rules.ts`, `policy/night-policy.json`, `docs/night-policy.md`, `docs/rule-forms.md` | Подтверждены 4 дефекта (F-009..F-012); переход к T-002.4 |
| 2026-11-01 12:30 | T-002.4 & T-002.5 → F-013..F-016 | Проверены `integration-gate.ts`, `run-goal.ts`, `reopen-attempt.ts`, `second-pilot.ts`, `pm-notice.ts`, `docs/relay.md`, `packages/settings-catalog/**`, `docs/enabled-settings.md`, `CHANGELOG.md` 0.1.440–0.1.456 | Подтверждены ещё 4 дефекта (F-013..F-016), 2 гипотезы (H-001..H-002) и 2 UX-суждения (U-001..U-002); отчёт сведён и переведён в `complete` |

---

## 9. Handoff

- **Текущий статус:** `complete` (аудит всех 8 приоритетных зон завершён).
- **Последний завершённый шаг:** T-003 (сводка находок, прожарка, иерархия ремонта R-001..R-009 и таблица покрытия).
- **Следующее конкретное действие:** Начать ремонт с **R-001** (`integration-gate.ts:623-631`), **R-002** (`finish.ts:826-844` — карточка `task-word` на «Ждут владельца») и **R-003** (автозакрытие карточек `closeOwnerItem` и кнопка закрытия на `OwnerWaitingBoard`).
- **Неразрешённые вопросы / блокеры:** В R-006 требуется продуктовое решение владельца — должен ли ночной цикл ставить правила на испытание автоматически (тогда нужно исправить `night-policy.json` обратно на `night_decides` для `trial: true`) или только предлагать их (тогда нужно убрать авто-вызов `adoptRuleProposal` из `applyScan`).
- **Изменённые данные и очистка:** Никакие файлы репозитория, настройки или таблицы БД не изменялись; создан только этот отчёт в `.agents/app-grill/20261101T115522522320Z-lane-pilot-0-1-456-gemini-4-argon/report.md`.

## 10. Заметки сверки (2026-11-01, против 0.1.461 dd22dfdd, остатки закрыты в 0.1.462)

Перечитано по пунктам независимым читателем после правок; вердикт по коду, не по CHANGELOG. R-пункты наследуют худший вердикт своих находок.

| id | вердикт | где |
|---|---|---|
| F-001 | CLOSED (+1 осознанный остаток) | `lead/logic.ts` `OWNER_ANSWERERS`; `cli.ts` запрещает `--by screen`; RPC `task_word` пишет `screen` (0.1.458, 0.1.461). Остаток-выбор: CLI по умолчанию `--by owner`, пока хост не передаёт личность вызывающего. |
| F-002 | CLOSED | `tick.ts`: после ответа новая строка `lead:<road>:<tick>` (0.1.458). |
| F-003 | CLOSED | карточка только когда `mayAct` ложь или `act` не смог (0.1.458). |
| F-004 | CLOSED | таблица `lane_pilot_lead_label` снесена, `deferred` не принимается; `docs/lead.md` без `|deferred` (0.1.458, 0.1.462). |
| F-005.1 | CLOSED | `historyOf` до `created_at` строки (0.1.461; правка 0.1.458 эффекта не имела). |
| F-005.2 | PRODUCT-CHOICE | бэктест и экзамен памяти считают только `exact`: судью-модель не зовут, строка без прав не стоит его цены; записано в `docs/lead.md` (0.1.462). |
| F-006.1 | CLOSED | janitor закрывает `phase-word` по закрытому/остановленному этапу (0.1.458); урок-черновик (`:lesson`) он не трогает, а возврат этапа на раннюю стадию закрывает строки покинутого хода (0.1.462). |
| F-006.2 | CLOSED | `writer-question:*` уходит, когда задача пошла дальше (0.1.458, 0.1.461). |
| F-006.3 | CLOSED | зелёные ворота закрывают `gate-red:*`; цель запуска перепроверяется и закрывается (0.1.458, 0.1.461). |
| F-006.4 | CLOSED | «Прочитано», сроки фактов 3 и 7 дней (0.1.461). |
| F-006.5 | CLOSED | RPC `learning_decide`, кнопки (0.1.461). |
| F-007 | CLOSED | все четыре отправки стали строками списка (0.1.458). |
| F-008 | CLOSED | строка `task_word` с да/нет, место исполнителя отдаётся, очередь не велит пересылать (0.1.458, 0.1.461). |
| F-009.1 | CLOSED | ночной скан под `nightMayAdopt` (0.1.458); стартовый проход `adoptWaitingRules` под тем же гейтом (0.1.462). |
| F-009.2 | CLOSED | концепт `trial` вместо `owner-confirmed` (0.1.458). |
| F-009.3 | PRODUCT-CHOICE | строгие доказательства стены и условное слияние по комментарию в `wall/acceptance.ts`. |
| F-009.4 | CLOSED | `collectAndAppend` в ночи, крон 02:50 (0.1.459). |
| F-010.1–2 | PRODUCT-CHOICE | PM-правило остаётся на пробе до повтора или слова владельца (CHANGELOG 0.1.459). |
| F-010.3 | CLOSED | PM-правило не гибнет как `unused` (0.1.459). |
| F-011.1a | CLOSED | подзапрос вместо размножающего JOIN (0.1.459). |
| F-011.1b | INVALID | `sweepRouteWorkflowOutcomes` пишет исходы `route.workflow`. |
| F-011.2 | CLOSED | `bench: "on"` (0.1.459). |
| F-012 | CLOSED | `evaluateRules` на fallback; текст узла исправлен (0.1.459). |
| F-013 | CLOSED | `<task>-mainfix` вместо сообщения в закрытый тред (0.1.459). |
| F-014 | CLOSED | `sendPmNotice` честно возвращает false; `superseded` (0.1.458, 0.1.459). |
| F-015.1 | CLOSED | строки писателя исправлены (0.1.459); генератор страницы берёт первую редактируемую строку ключа, а не последнюю (0.1.462). |
| F-015.2 | CLOSED | один ряд `night_review.model`, переключатели убраны, строки `excluded` (0.1.459, 0.1.461). |
| F-015.3 | CLOSED | `owner.words`, `phase.rails` в каталоге (0.1.459). |
| F-015.4 | CLOSED | `harness.*` из доков убраны (0.1.459). |
| F-016 | CLOSED | `reset_project_settings` через каталог; релизы существуют (0.1.458, 0.1.459). |
| H-001 | PRODUCT-CHOICE | после перезагрузки форма спрашивается заново (комментарий в `workflow-executors.ts`, `recoverLost`). |
| H-002 | PRODUCT-CHOICE | событие BB несёт только «Command thread.start failed» (CHANGELOG 0.1.451). |
| U-001 | CLOSED | плашка доказательства копирует ссылку (0.1.461). Перехода к запуску нет: оставлено. |
| U-002 | CLOSED | кнопки «совпал / отчасти / мимо»; тост и строка разметки теми же словами (0.1.459, 0.1.462). |
| вне отчёта | CLOSED | красная цель закрытого запуска не ложится строкой и не перепроверяется (0.1.462). |
