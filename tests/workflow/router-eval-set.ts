// The phrases of the router evaluation (chains spec 6.2); shared by the vitest suite and scripts/jev-router-eval.ts.

/** The 30 required phrases of the chains spec (section 6.2): the expected workflow, or `clarify` (no choice, confidence below 60). */
export const EVAL_SET: Array<[number, string, string]> = [
  [1, "Добавь пагинацию в список заказов и покрой тестами", "analyze-plan-execute"],
  [2, "Implement dark mode toggle in the settings screen", "analyze-plan-execute"],
  [3, "Сделай фичу экспорта в PDF от плана до приёмки, с ревью и прогоном тестов", "full-lifecycle"],
  [4, "Walk the invoice export feature through plan, implementation, review and testing", "full-lifecycle"],
  [5, "Упрости модуль уведомлений, структуру почисти, поведение не трогай", "refactor"],
  [6, "Распиши план перехода на TypeScript 6 по задачам, запускать ничего не надо", "plan-only"],
  [7, "Критик нашёл проблемы в последней задаче, исправь их и прогони ревью заново", "review-fix"],
  [8, "Проведи общую проверку качества репозитория и всё найденное исправь", "quality-loop"],
  [9, "Take ticket LP-210 from the tracker and resolve it, with a proper review", "issue-full"],
  [10, "Закрой тикет LP-211, там просто неверный текст в подсказке", "issue-quick"],
  [11, "Interrogate my caching-layer design against the codebase first, and implement it afterwards", "grill-driven"],
  [12, "Хочу придумать, как будет работать реферальная программа — обсудим варианты и потом сделаем", "brainstorm-driven"],
  [13, "We have a big set of requirements for the marketplace; cut it into releases and ship them one after another", "roadmap-driven"],
  [14, "Оформи PRD, архитектуру и эпики для нового сервиса, и только затем кодим", "blueprint-driven"],
  [15, "Design and build the settings page UI from scratch, with states and responsive layout", "impeccable-build"],
  [16, "Почему сборка иногда падает по таймауту? Нужна только причина", "debug"],
  [17, "Users get a blank page after login — find the root cause", "debug"],
  [18, "Замени двойные кавычки на одинарные в файле config.ts", "companion"],
  [19, "Bump the version in package.json to 1.4.0", "companion"],
  [20, "Этап завершён, оформи закрытие и сохрани выводы для следующих", "milestone-close"],
  [21, "Pull the latest tweets about Rust and send me a digest in Telegram", "x-to-telegram-digest"],
  [22, "Посмотри, что пишут в X про AI-кодинг за три дня, итог — мне в телегу", "x-to-telegram-digest"],
  [23, "Разбери обсуждения в Instagram про семейные финансы и подготовь материал для статьи", "insights-post"],
  [24, "Turn this long podcast video into short vertical clips", "reels"],
  [25, "Нужен кокон страниц для интернет-магазина чая, с исследованием аудитории", "seo-cocoon"],
  [26, "Какие бывают подходы к ценообразованию SaaS? Нужен обзор с источниками", "web-research"],
  [27, "Вывези релиз на прод", "deploy"],
  [28, "Go over PR 517 and list what's wrong with it; do not change anything", "code-review"],
  [29, "Нет ли в репозитории дыр в безопасности? Просто посмотри, править не надо", "security-audit"],
  [30, "Сделай что-нибудь с сайтом", "clarify"],
];

/** The reserve phrases (section 6.3), checked on the same scorer; the last one is «continue», answered from state. */
export const RESERVE_SET: Array<[string, string]> = [
  ["Объясни, как у нас устроено кэширование, без правок", "analyze-code"],
  ["Допиши тесты на модуль подсчёта налога", "test-gen"],
  ["Poke holes in my rollout plan using the code, nothing more", "grill-plan"],
  ["Проведи ретро по прошлой неделе работы", "retrospective"],
  ["Find problems in the billing module and file tickets", "issue-discover"],
  ["Оцени, насколько удобна страница оформления заказа", "ui-audit"],
  ["Fix the typo in the footer and the broken link in README", "companion"],
  ["Давай продолжим", "clarify"],
];

/**
 * Paraphrases written after the first run on the 30 phrases, one or two per chain: a guard against rules that only fit
 * those phrases. On first contact 23 of 28 were right; the five misses were then fixed in the rules by principle (feature
 * verbs, behaviour-preserving wording, plan criticism, staged releases), so this set no longer measures generalization
 * and is not part of the acceptance numbers. A new paraphrase that fails is a catalog or rule gap to fix, not a test to loosen.
 */
export const HELD_OUT_SET: Array<[string, string]> = [
  ["Добавь в профиль пользователя поле с аватаркой и обработку загрузки", "analyze-plan-execute"],
  ["Make the CSV importer skip empty rows and add tests", "analyze-plan-execute"],
  ["Проведи всю фичу уведомлений через планирование, реализацию, ревью и тесты", "full-lifecycle"],
  ["Reorganize the billing package so it is easier to read, nothing should change for users", "refactor"],
  ["Составь план миграции на новую базу, ничего не запускай", "plan-only"],
  ["Ревью выявило три замечания, поправь их и проверь ещё раз", "review-fix"],
  ["Run a quality pass over the whole codebase and fix everything you find", "quality-loop"],
  ["Возьми задачу BB-482 из очереди и доведи до конца с полной проверкой", "issue-full"],
  ["Fix ticket PRJ-77 — just a wrong label on the button", "issue-quick"],
  ["Сначала раскритикуй мой план кэша по коду, а потом реализуй", "grill-driven"],
  ["I have a rough idea for a loyalty program, let's brainstorm it and then build it", "brainstorm-driven"],
  ["Требований много: разбей их на релизы и выкатывай поочерёдно", "roadmap-driven"],
  ["Prepare a PRD, architecture and epics first, code only after that", "blueprint-driven"],
  ["Собери с нуля интерфейс личного кабинета: дизайн-система, состояния, адаптив", "impeccable-build"],
  ["Why does the nightly job occasionally hang? I only want the cause", "debug"],
  ["Поправь опечатку в README.md", "companion"],
  ["Milestone is done — wrap it up and store the lessons for next time", "milestone-close"],
  ["Собери свежие посты из Twitter про нейросети и пришли дайджест в телеграм", "x-to-telegram-digest"],
  ["Analyze the Reddit discussions about remote work and prepare material for a blog post", "insights-post"],
  ["Нарежь это длинное интервью на короткие вертикальные ролики", "reels"],
  ["Build a semantic cocoon for a coffee shop website", "seo-cocoon"],
  ["Найди в интернете, какие есть подходы к онбордингу, и дай обзор с источниками", "web-research"],
  ["Roll the new version out to production", "deploy"],
  ["Посмотри PR 88 и перечисли замечания, ничего не меняй", "code-review"],
  ["Check the repository for security holes, report only", "security-audit"],
  ["Объясни, как работает очередь задач в проекте, без правок", "analyze-code"],
  ["Help me with the project", "clarify"],
  ["Сделай лучше", "clarify"],
];
