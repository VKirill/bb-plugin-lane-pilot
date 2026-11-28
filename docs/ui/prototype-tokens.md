---
title: "Консоль Lane Pilot: токены и общие примитивы вида"
type: design
created: 2026-11-28
updated: 2026-11-28
status: current
tags: [ui, design-tokens, css]
sources:
  - app.css
  - src/rooms/pages/ui/console-shell.tsx
  - src/rooms/pages/ui/scope-switcher.tsx
  - packages/ui-kit/src/ui
---

# Токены и общие примитивы вида

Вид консоли берётся из прототипа Pencil (`lane-pilot-ui.pen`). Единственный дом токенов - начало `app.css`.

## Токены

| Переменная Pencil | CSS-переменная | Значение |
|---|---|---|
| bg, surface, ink, body, muted, line | `--lp-bg`, `--lp-surface`, `--lp-ink`, `--lp-body`, `--lp-muted`, `--lp-line` | #F6F6F3, #FFFFFF, #17181C, #4B4F58, #8B8F98, #E7E6E1 |
| side, sideInk, sideMuted | `--lp-side`, `--lp-side-ink`, `--lp-side-muted` | #1C1D21, #C9CBD1, #7C7F88 |
| (литералы сайдбара) | `--lp-side-raise`, `--lp-side-line`, `--lp-side-active` | #2A2B30, #2E2F35, #2E3036 |
| accent, accentSoft | `--lp-accent`, `--lp-accent-soft` | #3B5BDB, #E8EDFC |
| ok, warn, bad (+ Soft) | `--lp-ok`, `--lp-warn`, `--lp-bad` (+ `-soft`) | #2F9E66, #C77B0A, #C9372C |
| font | `--lp-font` | Inter, затем системный стек |

Палитра лежит на корне плагина. Класс `.lp-console` (корень оболочки) и оверлеи Lane Pilot (`[data-bb-portaled-overlay]`) переназначают на неё переменные темы BB (`--background`, `--foreground`, `--primary`, `--border`...) и семантические `--lp-card`, `--lp-hairline`, `--lp-well`, `--lp-success`..., поэтому все классы экранов следуют прототипу без правок. Правая панель чата и композер читают тему BB как раньше.

## Общие примитивы

| Что | Где |
|---|---|
| Сайдбар 248 px, бренд, карточка проекта, группа «Система» | `.lp-side*` в `app.css`, разметка в `console-shell.tsx` |
| Карточка | `.lp-panel` (+ `-head`, `-body`), `.lp-card`; `Surface`, `Card` |
| Заголовок страницы 26 px + подзаголовок | `.lp-page-head`, `.lp-page-title`, `.lp-page-sub`; `PageHeader` |
| Основная кнопка (чёрная) | `.lp-accent`; `Button` по умолчанию |
| Пилюля статуса | `.lp-pill-*`, `.lp-pill-dot`; `Badge`, `StatusPill` (`dot`) |
| KPI: число и подпись | `KpiTile` (подпись окрашена тоном, число - ink) |
| Сегментный контроль | `.lp-seg`; `Segments` (`size="sm"` для «Предлагает / Спрашивает / Сам», `"md"` для периода) |
| Полоса прогресса | `.lp-progress`; `ProgressBar` |

Нижняя строка сайдбара «Хаб · версия · работает» не выведена: версия хаба в данных интерфейса сейчас не приходит.
