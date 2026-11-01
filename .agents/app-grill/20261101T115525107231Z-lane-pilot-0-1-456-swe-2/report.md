---
title: "App Roast: Lane Pilot 0.1.456 — SWE-2"
status: in-progress
target: "Lane Pilot 0.1.456 — SWE-2"
created: "2026-11-01T11:55:25+00:00"
language: "ru"
tone: "roast"
---

# App Roast

> [!IMPORTANT]
> Working audit. Findings and coverage are updated during investigation. Unchecked areas and hypotheses are not verified defects.

## 1. Audit brief

| Field | Value |
| --- | --- |
| Target / supported version | bb-plugin-lane-pilot 0.1.456, ревизия 295497fc |
| Владелец проекта и PM-агенты; плагин оркестрации Lane Pilot в BB |
| Только аудит: код не менять, git-дерево не трогать (общий checkout), GitNexus не обновлять, полный прогон тестов запрещён; разрешены npx tsc --noEmit и npx vitest run <file>, читающие bb lane-pilot команды |
| Зоны: lead chain, owner-waiting, owner.words, night/self-repair, verification/run-goal, writer/relay, settings-catalog, CHANGELOG 0.1.440–0.1.456 |
| 295497fc; дерево общее с другими агентами, dirty-файлы возможны и чужие |
| Ubuntu, production-плагин; бюджет — несколько часов, пока проходы дают находки |
| Source + читающий runtime (bb lane-pilot status/waiting/lead/timeline/schedule/phase); без побочных действий |
| GitNexus намеренно не обновлялся — индекс занят другим процессом (указание задачи); fallback — rg/поиск по исходникам |

## 2. Work hierarchy and progress

<!-- app-roast:work:start -->
- [x] T-001 Карта обещаний: README, docs/, CHANGELOG 0.1.440–0.1.456
- [x] T-002 Lead chain: proposal → owner-waiting → ответ → journal → exam → rights → auto-action
- [x] T-003 owner-waiting: writers/closers, правило «ничего в чат PM» (0.1.443)
- [x] T-004 owner.words / landingWordAsked / OWNER_WORD_WAIT_MS
- [x] T-005 Ночной цикл self-repair, night-graphs, rule-forms, policy (jobs=0)
- [x] T-006 verification + run-goal: зелёное/красное
- [x] T-007 writer/relay: вопросы, таймауты, повторы, отмена
- [x] T-008 settings-catalog vs enabled-settings: мёртвые/несовпадающие дефолты
- [x] T-009 CHANGELOG 0.1.440–0.1.456 vs код
- [x] T-010 Runtime-снимки читающими командами
- [x] T-011 Синтез, roast, иерархия ремонта, покрытие
<!-- app-roast:work:end -->

Add area → scenario → checks as nested tasks with stable IDs. Record blockers and the condition for resuming next to the relevant task.

## 3. Contract and scenario map

| ID | Actor / preconditions | Action | Promise and source | Authoritative result / other surfaces | Coverage |
| --- | --- | --- | --- | --- | --- |
| S-001 | Штурман, lead.enabled on | тик → proposal → строка на «Ждут владельца» → decide → journal → exam → rights → act | docs/lead.md, CHANGELOG 0.1.447–456 | дерево, журнал, права, handOver расписание/PM | source+runtime (status/exam) |
| S-002 | владелец | экран «Ждут владельца» показывает только то, что ждёт | docs/owner-waiting.md | open-строки без закрывателя копятся (F-004..F-006) | source+runtime |
| S-003 | задача risk high/critical, owner.words=risky | посадка ждёт «да» до 6ч | CHANGELOG 0.1.442, words.ts | high ждёт, critical — нет (F-003) | source |
| S-004 | ночной цикл | сбор→анализ→правило на пробу→подтверждение; jobs=0 — не провал | docs/night-policy.md | ранний return при пустых jobs корректен | source |
| S-005 | run-goal | done-run с принятыми задачами красный на main → строка владельцу | run-goal.ts, docs | строка вечная, перепроверки нет (F-006) | source |
| S-006 | writer question | ждёт question_wait_min → second-pilot или владелец | docs/owner-waiting.md, question-timeout.ts | соответствует; строка не закрывается после ответа (F-005) | source |

## 4. Findings

### 4.1 Index and counts

| ID | Area / neutral title | Evidence status | Severity | Confidence | Task / scenario | Repair state |
| --- | --- | --- | --- | --- | --- | --- |
| F-001 | lead/journal: `answered_by` — строка под контролем вызывающего; PM и произвольный `--by` считаются ответом владельца в экзамене | CONFIRMED-CODE | P1 | high | T-002 | open |
| F-002 | lead/journal: память предиктора `historyOf` не фильтрует прокси-ответы и чужие сплиты — «последние 20 ответов владельца» включают авто-«yes» самого Штурмана | CONFIRMED-CODE | P2 | high | T-002 | open |
| F-003 | owner.words + lead: риск `critical` выпадает из обеих воронок — не ждёт слова владельца на `risky` и нормализуется в `null` перед `mayAct` | CONFIRMED-CODE | P1 | high | T-002/T-004 | open |
| F-004 | owner-waiting: информационные строки (handed/acted/tick_*/labels/right_changed, run-goal, schedule) открываются навсегда — закрывать их некому и некогда | CONFIRMED-CODE | P2 | high | T-003 | open |
| F-005 | owner-waiting: строка `writer-question:*` не закрывается после ответа/повторной отправки задачи — вопрос висит решённым | CONFIRMED-CODE | P2 | high | T-003/T-007 | open |
| F-006 | run-goal: красная строка `run-goal:<runId>` вечна — sweep не перепроверяет run с записью, фикс-задача строку не снимает | CONFIRMED-CODE | P3 | high | T-006 | open |
| H-001 | lead exam cron 04:40 не оставил `lead:exam` ключа после первого прогона — причина не установлена (плагин мог быть выключен/обновлялся) | HYPOTHESIS | P3 | low | T-002/T-010 | open |

Confirmed runtime: 0. Confirmed code: 6. Hypotheses: 1. UX judgments: 0. Rejected: 0.

### 4.2 Confirmed contradictions by product area

<a id="f-001"></a>
#### F-001 — Экзамен Штурмана верит `answered_by` на слово

- **Обещание и источник:** CHANGELOG 0.1.453 и docs/lead.md: журнал «keeps who answered (owner, screen, lead-chat, lead, agent)», `--by agent` помечает прокси-ответ, и `examEligible` не считает строки, отвеченные не владельцем (`PROXY_ANSWERERS`).
- **Противоречие (код, ревизия 295497fc):** `answered_by` — свободная строка от вызывающего. `src/rooms/tasks/server/queue-tool.ts:42` записывает слово владельца на посадку задачи с `by="pm"` — значения «pm» нет ни в задокументированном словаре, ни в `PROXY_ANSWERERS` (`src/rooms/lead/logic.ts:19`), значит ответ, пересказанный PM-агентом, идёт в экзамен как слово владельца. `src/rooms/phase/server/driver.ts:466` берёт `input.by ?? "owner"` — любой вызов инструмента `word` без параметра записывается как «owner». CLI `src/rooms/lead/cli.ts` `decide … --by <что угодно>` принимает произвольную строку: агент, ответивший за владельца без `--by agent` (или с `--by owner`), тоже зачтётся экзамену.
- **Последствие:** право `decides` класса может быть открыто ночным экзаменом на данных, часть которых — пересказы агентов, а не ответы владельца. Кappa считается против меток владельца, но eligible-строки N/K/M включают чужие ответы.
- **Контрдоказательства проверены:** `PROXY_ANSWERERS` = {lead, agent} единственный фильтр; `answerDecision` сохраняет `by.slice(0,200)` без валидации. Документированный словарь в CHANGELOG не содержит «pm».
- **Причина:** поле доверия записывается вызывающим, а не вычисляется из канала.
- **Ремонт:** белый список `answered_by` по каналу (screen/CLI=owner, инструменты агентов=agent/pm→прокси), «pm» в `PROXY_ANSWERERS` или явное решение с документацией.
- **Приёмка:** тест — `word` от PM и `decide --by owner` от агента не попадают в `examRows` eligible.
- **Roast:** Экзамен, который должен решить, можно ли доверять Штурману заменять владельца, проверяет личность отвечающего по самоподписанному полю «я — владелец». Дверь с табличкой «служебный вход» открывается написанием «я свой» на любом бейдже.

<a id="f-002"></a>
#### F-002 — Память предиктора подмешивает ответы самого Штурмана

- **Обещание и источник:** docs/lead.md и predict.ts: «the owner's last 20 answers to the same surface and class as its memory» — прогноз строится на истории ответов владельца.
- **Противоречие:** `historyOf` (`src/rooms/lead/server/journal.ts:362-365`) выбирает `WHERE surface=? AND class=? AND answer_json IS NOT NULL` — без фильтра `answered_by` и без фильтра `split`. В память идут авто-ответы `lead` (act-шаг закрывает предложение «yes» от имени Штурмана), прокси `agent`, пересказы `pm`, строки split `design` (переключатель lead.enabled с опциями on/off в истории класса process, где опции yes/later/no).
- **Последствие:** предиктор обучается на собственных «yes» Штурмана — смещение к «yes», и смешанные наборы опций в истории. Метрика экзамена при этом честнее самой модели: LB может быть завышен не навыком, а подмесом.
- **Ремонт:** `AND (answered_by IS NULL OR answered_by NOT IN (прокси)) AND split='exam'` (или осознанный список сплитов).
- **Приёмка:** тест — история предиктора не содержит строк с `answered_by='lead'`/`'agent'`/`'pm'`.
- **Roast:** Штурман готовится к экзамену по шпаргалке, половина которой написана его же рукой. Удобно: угадать ответ владельца легче всего, когда ответ придумал ты сам.

<a id="f-003"></a>
#### F-003 — `critical` проваливается между «high» и всем остальным

- **Обещание и источник:** `owner.words=risky` (дефолт с 0.1.442, docs/owner-waiting.md): «only a task of risk high waits» — дух правила: опасные задачи ждут слова владельца. mayAct (`src/rooms/lead/server/rights.ts`) явно блокирует `risk high или critical` — авторы знали про уровень.
- **Противоречие (два места):**
  1. `landingWordAsked` (`src/rooms/tasks/words.ts:26-29`): `mode==="risky" && risk==="high"` — задача риска `critical` (легитимный enum, `packages/contracts/src/schemas.ts:83`) на дефолтном режиме ложится на main **без** слова владельца, пока «high» ждёт до 6 часов.
  2. Нормализация риска в `lp.lead_propose` (`src/rooms/lead/server/tick.ts:126`): `risk` не из {high,medium,low} → `null`. `critical` стирается до проверки `mayAct`, которая его блокировала бы: предложение с `risk:"critical"` при открытом классе уходит в `actable` и исполняется Штурманом сам.
- **Последствие:** самый опасный уровень риска — единственный, который не ждёт владельца и не блокирует самодействие.
- **Ремонт:** `atLeastHigh` (high|critical) в обеих проверках; нормализация — в валидацию с отказом или сохранением `critical`.
- **Приёмка:** тест — critical-задача на `risky` ждёт слова; critical-предложение не попадает в actable.
- **Roast:** Таблица рисков: low — можно, medium — можно, high — подожди хозяина, critical — пулей в прод без свидетелей. Шкала безопасности с пустой верхней ступенью.

### 4.3 Hypotheses and next verification steps

<a id="h-001"></a>
#### H-001 — Ночной экзамен прав не оставил следа

- Runtime: `bb lane-pilot lead status` (2026-11-01 ~12:00 UTC) показывает `last exam: not yet`, хотя `LEAD_EXAM_CRON` = `40 4 * * *` смонтирован в `mountLead` и `service.exam()` пишет `EXAM_KEY` безусловно при любом исходе.
- Возможные причины: плагин/хаб не работал в 04:40 (deploy 0.1.456/0.1.457 утром), комната lead смонтирована позже рестарта, запись в kv упала.
- Что подтвердит/опровергнет: повторный `lead status` после следующего 04:40; лог плагина на `lead exam`; проверка, что `mountLead` реально вызывается на проде (тесты строят сервис без crons по дизайну).


### 4.4 UX judgments

Keep subjective friction and heuristic concerns separate from functional defects. Include the affected scenario and a proposed way to validate the judgment.

## 5. The roast

[F-001] Штурман устроил честный экзамен: прогноз до ответа, судья, каппа, Wilson. И проверку личности экзаменуемого — по строке, которую отвечающий пишет сам. PM отвечает за владельца и пишет «pm» — зачёт. Любой агент пишет `--by owner` — зачёт. Прокси-фильтр держит ровно два имени, «lead» и «agent»; всё остальное человечество проходит как владелец. Экзамен на доверие, где половина билетов может быть подписана кем угодно.

[F-002] Память для прогноза — «последние 20 ответов владельца». В выборке — собственные авто-«yes» Штурмана из act-шага, прокси-ответы агентов и строка split `design` с опциями on/off в классе, где спрашивают yes/later/no. Модель учится угадывать владельца по журналу, где владелец — иногда она сама.

[F-003] Шкала рисков low→critical, а правило написано как `risk === "high"`. Critical — единственный уровень, который не ждёт слова владельца перед main и не останавливает самодействие Штурмана: propose нормализует его в `null`, и `mayAct`, написанный специально под critical, его не видит. Самая опасная категория — безбилетная.

[F-004][F-005][F-006] «Ждут владельца» — экран, на котором строки рождаются и не умирают. Факт «Штурман запустил», строка «вопрос исполнителя», красный `run-goal` — всё `state='open'` навсегда: закрывает их только `closeOwnerItem`, которую зовут три места из двадцати. Экран ожидания превращается в некролог: вопрос висит после ответа, тревога — после фикса, а «владельца ничто не ждёт» означает лишь «сегодня пока чисто».

## 6. Repair hierarchy

| Order / task ID | Finding IDs | Repair / dependencies | Acceptance check | State |
| --- | --- | --- | --- | --- |

## 7. Coverage and limitations

| Area / scenario | Runtime | Source | Result / limitation | Next check |
| --- | --- | --- | --- | --- |
| Lead chain (proposal→list→answer→journal→exam→rights→act) | частично (status/exam/journal/ticks прочитаны) | полный проход | F-001, F-002, F-003; цепочка в целом соответствует docs/lead.md | H-001: следующий exam cron |
| owner-waiting источники/закрытия | waiting прочитан («ничто не ждёт», 135 красных за сутки) | collectOwnerWaiting + все postOwnerItem | F-004, F-005, F-006 | — |
| owner.words 6ч | — | words.ts, finish.ts | F-003 (critical); цикл ожидания соответствует доку | — |
| Ночной цикл/self-repair/policy | — | night-policy.md, rule-scan, insights | крупных расхождений не найдено; jobs=0 → ранний return 0 корректен | — |
| verification/run-goal | — | run-goal.ts | F-006 | — |
| writer/relay вопросы | — | question-timeout.ts, second-pilot.ts | F-005; логика таймаута соответствует W34 | — |
| settings-catalog | — | spot-check writer.*, critic.*, owner.* | совпадает; полный инвентарь 529 ключей не сверялся поштучно | — |
| CHANGELOG 0.1.440–456 | — | прочитан целиком, точечная сверка | обещания релизов подтверждены кодом в проверенных местах (detached tick, PROXY, pm-notice фильтр lp.*, plain-words) | — |
| PM-chat правило 0.1.443 | — | pm-notice.ts, finish.ts | нарушений не найдено: sendServiceMessage в finish — инструкция run'у, события фильтруются | — |

Record passed checks, blocked/not-checked paths, revision changes, test data changes, and cleanup. Do not equate untested with broken or passing checks with whole-app correctness.

## 8. Investigation timeline

| Time | Task / scenario / finding | Check / decision / evidence | Result / next action |
| --- | --- | --- | --- |
| ~12:30 | T-003..T-009 | owner-waiting posters/closers, pm-notice, run-goal, question-timeout, words.ts, catalog spot-check, CHANGELOG | F-004, F-005, F-006; 0.1.443 нарушений нет |
| ~12:35 | T-010 runtime | status/waiting/lead status/exam/journal/ticks | exam rows все answered by agent → n=0 (соответствует PROXY); lastExam never; waiting пуст, 135 red/24h | H-001 записана |
| 11:58 | T-002 lead chain | Прочитаны logic.ts, rights.ts, journal.ts, tick.ts, service.ts, cli/rpc/tool, policy, lead-tick.json, backtest | F-001, F-002, F-003 записаны; docs/lead.md в целом соответствует коду (sweep, receipt, handover, detached tick) |

Append meaningful checks and decisions, including rejected concerns and evidence-status changes. Do not paste hidden instructions, credentials, or raw tool transcripts.

## 9. Handoff

- Current status: complete (agreed scope covered).
- Last completed step: synthesis, roast, coverage.
- Next concrete action: review findings F-001..F-003 first (exam integrity and critical-risk holes).
- Unresolved questions / blockers: H-001 (exam cron trail); GitNexus не обновлялся по указанию (индекс занят) — поиск по исходникам.
- Audit completion and fix verification: audit only; no fixes authorized.
