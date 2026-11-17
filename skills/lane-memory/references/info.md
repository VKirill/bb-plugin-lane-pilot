lane-memory — факты проекта, которые нельзя вывести из кода

Зачем
- Правила «всегда так» сидят в ядре и грузятся каждую сессию (не поиск).
- Остальное — по запросу: `bb lane-pilot memory search "<question>" [--project P]`.
- Факт пишет `bb lane-pilot memory write "<fact>" [--project P]` (одна дверь). Урок в Lane Pilot PM пишет `lane_pilot_memory` с `action: "lesson"`; терминальная lesson-команда здесь не определена.

Раскладка
- Один корпус на хабе BB (Lane Pilot): факты читаются и пишутся через `bb lane-pilot memory search` / `bb lane-pilot memory write`.
- В чате Lane Pilot PM контекст и уроки идут через `lane_pilot_memory` (`action: "context"` / `"lesson"`).
- Локального корпуса или fallback-файлов нет; записи `sensitive` тоже идут на хаб.

Спросить корпус
bb lane-pilot memory search "почему сводку не по шаблону" --project <project-id>
bb lane-pilot memory search "handoff" --project <project-id>

Записать факт
сформулировать одну factual claim →
bb lane-pilot memory write "<fact>" --project <project-id>

Урок = правило для хаба в чате Lane Pilot PM:
инструмент `lane_pilot_memory`, `action: "lesson"` (runId, rule, audience)

Не класть сюда
структуру репо, git-историю, PROGRESS, YAML рана — у них свои файлы.
