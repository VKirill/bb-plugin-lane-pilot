import { describe, expect, it } from "vitest";
import { MIN_CONFIDENCE, routeIntent } from "../../src/workflow/router";
import { publishedCatalog } from "./router-catalog";

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

const outcome = async (phrase: string) => {
  const decision = await routeIntent({ intent: phrase, workflows: publishedCatalog() });
  return { decision, id: decision.workflowId ?? "clarify" };
};

describe("router evaluation set (chains spec 6.2)", () => {
  it("picks the expected workflow for at least 27 of the 30 phrases with the deterministic scorer", async () => {
    const rows: Array<{ n: number; expected: string; got: string; confidence: number; top: string }> = [];
    for (const [n, phrase, expected] of EVAL_SET) {
      const { decision, id } = await outcome(phrase);
      rows.push({ n, expected, got: id, confidence: decision.confidence, top: decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ") });
    }
    const wrong = rows.filter((row) => row.got !== row.expected);
    const correct = rows.length - wrong.length;
    if (process.env.ROUTER_EVAL_VERBOSE || wrong.length > 3) console.log(`router eval ${correct}/30\n${rows.map((r) => `${r.n}. ${r.got === r.expected ? "ok " : "BAD"} expected ${r.expected} got ${r.got} (${r.confidence}) ${r.top}`).join("\n")}`);
    expect(correct).toBeGreaterThanOrEqual(27);
    // The clarify phrase never starts anything.
    expect(rows.find((row) => row.n === 30)).toMatchObject({ got: "clarify" });
    expect(rows.find((row) => row.n === 30)!.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("keeps the right workflow in the top 5 before the choice (recall at 5)", async () => {
    const missed: number[] = [];
    for (const [n, phrase, expected] of EVAL_SET.filter(([, , id]) => id !== "clarify")) {
      const { decision } = await outcome(phrase);
      if (!decision.candidates.some((candidate) => candidate.id === expected)) missed.push(n);
    }
    expect(missed.length).toBeLessThanOrEqual(1);
  });

  it("routes the reserve phrases (single-step chains) on the same scorer", async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const [phrase, expected] of RESERVE_SET) {
      const { id, decision } = await outcome(phrase);
      if (id === expected) correct += 1;
      else rows.push(`${phrase} -> ${id} (expected ${expected}) ${decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ")}`);
    }
    if (process.env.ROUTER_EVAL_VERBOSE || rows.length > 2) console.log(`reserve ${correct}/${RESERVE_SET.length}\n${rows.join("\n")}`);
    expect(correct).toBeGreaterThanOrEqual(6);
  });

  it("also routes most of the held-out paraphrases", async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const [phrase, expected] of HELD_OUT_SET) {
      const { id, decision } = await outcome(phrase);
      if (id === expected) correct += 1;
      else rows.push(`${phrase} -> ${id} (expected ${expected}, ${decision.confidence}) ${decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ")}`);
    }
    if (process.env.ROUTER_EVAL_VERBOSE) console.log(`held-out ${correct}/${HELD_OUT_SET.length}\n${rows.join("\n")}`);
    expect(correct / HELD_OUT_SET.length).toBeGreaterThanOrEqual(0.75);
  });

  it("never lists an eval phrase among the catalog examples", () => {
    const examples = new Set(publishedCatalog().flatMap((workflow) => [...workflow.examples.en, ...workflow.examples.ru]).map((text) => text.trim().toLowerCase()));
    for (const [, phrase] of EVAL_SET) expect(examples.has(phrase.trim().toLowerCase())).toBe(false);
    for (const [phrase] of RESERVE_SET) expect(examples.has(phrase.trim().toLowerCase())).toBe(false);
  });
});
