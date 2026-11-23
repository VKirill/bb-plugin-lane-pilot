docs-maintain — живые docs/: пакеты + функциональность систем (docs/features/).

Когда
- «обнови документацию / nightly docs / INIT docs».
- После дневных коммитов. Не wiki/, не TODO/, не .agents/ (и не устаревший docs/plans/). В чате Lane Pilot эту работу делает его ночной проход docs (см. врезку в SKILL.md); команды ниже — терминальный харнесс.

Как открыть шпаргалку
- Открой SKILL.md навыка lp-docs и соседние файлы references/

Запуск в BB Lane Pilot
- Ночной проход графа `lp.docs-night` обновляет `docs/` автоматически по расписанию (или вручную через `bb lane-pilot docs-nightly`)
- Настройки: `docs.enabled`, `docs.maintain`, `docs.since`, `docs.page_cap`, `docs.hour`, `docs.review`

Как работает
1) Паспорт тонкий — ночной раннер зовёт project-onboard, потом wiki (не BLOCKED).
2) docs-web: шапки / stubs / web.yaml / INDEX + stubs docs/features/ из apps/*/modules. Без LLM.
3) docs-stale: owns ∪ цитаты ∪ stub/thin. Luna пишет wiki и product spec фич (Business rules). Не коммитит.
   Отчёт: .agents/session-log/DOCS-YYYY-MM-DD.md
   Daylog: .agents/session-log/DOCS-DAY-YYYY-MM-DD.md
