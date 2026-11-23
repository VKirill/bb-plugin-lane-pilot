project-life — туду, план, память. Не ран.

Цепочка
idea → todo → plan → run → merge
                 status: PROGRESS · decisions; memory: facts/lessons→hub

Как открыть шпаргалку
- Открой SKILL.md навыка project-life и соседние файлы references/

Фразы → действие
- «запиши / туду / потом / не теряй»     → .agents/todos/ + INDEX
- «покажи туду»                         → прочитай INDEX, ответь по-русски
- «закрой / сделано / не надо»          → status done/dropped
- «планируем / не запускай / обсудим»   → .agents/plans/items/<slug>/, ран НЕ открывать
- «архитектор / новое приложение / сервис» → skill app-architect, artifacts/ в том же плане
- «делай / реализуй / в работу»         → выход в ран (Lane Pilot: lane_pilot_dispatch_writer; standalone terminal harness: see its current docs)
- `ASK_PM:` от писателя                   → machine answer via `lane_pilot_answer_writer`; owner only for secret, money, irreversible act or product decision
- `owner.words = sensitive`               → owner wait only for money, database migration or production deploy; other pauses are decided by Lane Pilot
- «где мы / продолж»                    → это project-resume, не этот скилл

План без рана
1) .agents/plans/items/<YYYY-MM-DD-slug>/  status: draft
2) Решения в PLAN.md + History. Чат не хранилище.
3) UI: в Links должен быть docs/DESIGN.md (или spawn design-lead).
4) Запрещено до «делай»: запускать ран, спавнить писателей, писать task contract / owns_paths, Claude Plan mode, ~/.claude/plans/

Файлы
- .agents/todos/   .agents/plans/   .agents/PROGRESS.md   (facts: `bb lane-pilot memory search "<question>"` / `bb lane-pilot memory write "<fact>"`; lessons in a Lane Pilot PM: `lane_pilot_memory`, on the hub)
- .agents/tasks/<task-id>/manifest.json   .agents/runs/<run-id>/manifest.json   (Lane Pilot execution records)
- .agents/decisions/ = черновики решений; docs/decisions.md публикует ночной проход документации
- .agents/plans/ = interactive planning space, not a Lane Pilot task/run home
- docs/ = только документация кода (её ведёт ночной проход: Lane Pilot или docs-maintain); вход — PROJECT.md → docs/index.md

На диск — English. В чат — русский. Секреты не писать.
