import { afterEach, describe, expect, it } from "vitest";
import { builtinWorkflows } from "../../src/workflow/builtin";
import { MAX_QUESTIONS, MIN_CONFIDENCE, TOP_N, normalizeText, routeIntent, setRouterModel, stateProblem, stems } from "../../src/workflow/router";
import type { RouterModel, RouterState } from "../../src/workflow/router";
import { publishedCatalog } from "./router-catalog";

const catalog = publishedCatalog();
const route = (intent: string, extra: Partial<Parameters<typeof routeIntent>[0]> = {}) => routeIntent({ intent, workflows: catalog, ...extra });
afterEach(() => setRouterModel(null));

describe("text search", () => {
  it("ignores case, diacritics and punctuation, and trims Russian and English endings", () => {
    expect(normalizeText("Ёлка, ЙОД!  «Тест»")).toBe("елка иод тест");
    expect(stems("тестами")).toEqual(stems("ТЕСТЫ"));
    expect(stems("страницу")).toEqual(stems("страницы"));
    expect(stems("reviewing")).toEqual(stems("reviews"));
    expect(stems("Сделай, пожалуйста, ревью the pages")).toEqual([...stems("ревью"), "page"]);
  });
});

describe("what is offered", () => {
  it("never offers a draft, a deprecated, an internal or the per-task workflow", async () => {
    // A catalog of drafts offers nothing; the per-task pipeline is published but is never a choice.
    const drafts = await routeIntent({ intent: "Add pagination to the orders list and cover it with tests", workflows: builtinWorkflows().map((workflow) => (workflow.id === "lp-task-pipeline" ? workflow : { ...workflow, status: "draft" as const })) });
    expect(drafts.decision).toBe("clarify");
    expect(drafts.candidates).toEqual([]);
    const published = await route("Build the lp.build fragment tasks waves and run the task pipeline for an attempt", {});
    const ids = new Set(published.candidates.map((candidate) => candidate.id));
    for (const id of ["lp-task-pipeline", "lp.build", "lp.plan", "lp.analyze", "lp.review", "lp.close", "lp.brainstorm", "ins.post"]) expect(ids.has(id)).toBe(false);
    const deprecated = catalog.map((workflow) => (workflow.id === "deploy" ? { ...workflow, status: "deprecated" as const } : workflow));
    const result = await routeIntent({ intent: "Вывези релиз на прод", workflows: deprecated });
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain("deploy");
  });

  it("returns at most five candidates, each with its score and the rules that fired", async () => {
    const result = await route("Take ticket LP-210 from the tracker and resolve it, with a proper review");
    expect(result.candidates.length).toBeLessThanOrEqual(TOP_N);
    expect(result.candidates[0]).toMatchObject({ id: "issue-full", rules: ["tracker-ref"] });
  });
});

describe("priority rules (chains spec, section 1)", () => {
  it("a tracker id or URL picks an issue workflow over the generic one, the weight from the wording", async () => {
    expect((await route("Resolve LP-12 properly, with a thorough review")).workflowId).toBe("issue-full");
    expect((await route("Закрой LP-12, просто опечатка")).workflowId).toBe("issue-quick");
    expect((await route("Do https://tasks.example.com/tasks/ab12cd34 and ship it, with a proper review")).workflowId).toBe("issue-full");
    // Full or quick is not told by the wording: that is a question, between those two.
    const unsure = await route("Do https://tasks.example.com/tasks/ab12cd34 and ship it");
    expect(unsure.candidates.slice(0, 2).map((candidate) => candidate.id).sort()).toEqual(["issue-full", "issue-quick"]);
    // UTF-8 is not a ticket.
    expect((await route("Switch the exporter to UTF-8 output and add a test")).workflowId).toBe("analyze-plan-execute");
  });

  it("UI words alone do not pick the UI build; a from-scratch design ask does, and an evaluation picks the audit", async () => {
    expect((await route("Add a dark mode switch to the settings screen")).workflowId).toBe("analyze-plan-execute");
    expect((await route("Design the checkout page from scratch with a design system")).workflowId).toBe("impeccable-build");
    expect((await route("Оцени, насколько удобна страница оформления заказа")).workflowId).toBe("ui-audit");
  });

  it("external areas go to their own chain", async () => {
    expect((await route("Collect tweets about Rust and post the digest to Telegram")).workflowId).toBe("x-to-telegram-digest");
    expect((await route("Build a semantic cocoon for a tea shop")).workflowId).toBe("seo-cocoon");
    expect((await route("Cut this video into reels")).workflowId).toBe("reels");
    expect((await route("Deploy the site to production")).workflowId).toBe("deploy");
  });

  it("a failure without a request to fix goes to debug; with a fix request it does not", async () => {
    expect((await route("Why does the export crash on empty files?")).workflowId).toBe("debug");
    const withFix = await route("The export crashes on empty files, fix it and add a test");
    expect(withFix.workflowId).not.toBe("debug");
  });

  it("a request that forbids changes keeps the writing chains down and becomes a constraint", async () => {
    const asked = await route("Look at the payment module and tell me what is risky, do not change anything");
    expect(["analyze-plan-execute", "full-lifecycle", "refactor", "companion", "quality-loop"]).not.toContain(asked.workflowId);
    expect(asked.evidence.rules.map((rule) => rule.id)).toContain("read-only");
    const explained = await route("Объясни, как у нас устроено кэширование, без правок");
    expect(explained.workflowId).toBe("analyze-code");
    expect(explained.boundary_contract!.constraints).toContain("read-only: no file may change");
  });

  it("«continue» is not a workflow", async () => {
    const result = await route("Давай продолжим");
    expect(result).toMatchObject({ decision: "clarify", workflowId: null, stateContinue: true });
    expect(result.evidence.rules[0]!.id).toBe("state_continue");
  });
});

describe("the decision", () => {
  it("a broad request gets up to three questions and no choice", async () => {
    for (const intent of ["Help me with the project", "Сделай что-нибудь с сайтом", "ok"]) {
      const result = await route(intent);
      expect(result.decision).toBe("clarify");
      expect(result.workflowId).toBeNull();
      expect(result.confidence).toBeLessThan(MIN_CONFIDENCE);
      expect(result.questions.length).toBeGreaterThan(0);
      expect(result.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    }
    expect((await route("Сделай что-нибудь с сайтом")).questions[0]).toMatch(/[а-я]/i);
  });

  it("a short request is read together with its context", async () => {
    const result = await route("Do it", { context: "We agreed to deploy the new version to production today" });
    expect(result.workflowId).toBe("deploy");
  });

  it("a weak match asks which of the two top workflows is meant and for the missing required input", async () => {
    const result = await route("Look into the orders thing");
    expect(result.decision).toBe("clarify");
    expect(result.workflowId).toBeNull();
    expect(result.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("a chosen workflow carries evidence, a boundary contract, goals and the inputs the request fills", async () => {
    const result = await route("Go over PR 517 and list what's wrong with it; do not change anything");
    expect(result).toMatchObject({ decision: "route", workflowId: "code-review", inputs: { pr: "517" } });
    expect(result.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(result.evidence.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["pr-review", "read-only"]));
    expect(result.evidence.pattern).toContain("code-review");
    expect(result.evidence.rejected.length).toBeGreaterThan(0);
    expect(result.boundary_contract!.in_scope[0]).toContain("PR 517");
    expect(result.boundary_contract!.out_of_scope.join(" ")).toContain("do not change anything");
    expect(result.boundary_contract!.constraints).toContain("read-only: no file may change");
    expect(result.goals[0]).toMatchObject({ id: "request", guess: true });
    expect(result.goals.length).toBeGreaterThan(1);
    expect(result.goals.every((goal) => goal.done_when && goal.evidence)).toBe(true);
  });

  it("reads tracker ids, files and links from the request and marks the text-derived inputs as guesses", async () => {
    const issue = await route("Take ticket LP-210 and resolve it, with a proper review");
    expect(issue.inputs).toEqual({ task_ref: "LP-210" });
    expect(issue.missingInputs).toEqual([]);
    const research = await route("Какие бывают подходы к ценообразованию SaaS? Нужен обзор с источниками");
    expect(research.inputs.question).toContain("ценообразованию");
    expect(research.guessedInputs).toContain("question");
  });

  it("lists required inputs the request does not fill", async () => {
    const result = await route("Take the next ticket from the tracker and resolve it, with a proper review", { model: async ({ candidates }) => ({ choice: candidates.find((c) => c.id === "issue-full")!.id, confidence: 90, pattern: "tracker work", rejected: [], questions: [] }) });
    expect(result.workflowId).toBe("issue-full");
    expect(result.missingInputs).toEqual(["task_ref"]);
  });

  it("warns before closing a milestone while tasks are open", async () => {
    const result = await route("Этап завершён, оформи закрытие и сохрани выводы для следующих", { state: { openTasks: () => 2 } });
    expect(result.workflowId).toBe("milestone-close");
    expect(result.warnings.join(" ")).toContain("2 tasks");
  });
});

describe("state checks", () => {
  it("unknown means available: a state that knows nothing excludes nothing", async () => {
    const result = await route("Design and build the settings page UI from scratch, with states and responsive layout", { state: {} });
    expect(result.workflowId).toBe("impeccable-build");
  });

  it("a known-missing skill excludes the workflow and says why", async () => {
    const state: RouterState = { skill: (name) => (name === "impeccable-ui" ? false : undefined) };
    const result = await route("Design and build the settings page UI from scratch, with states and responsive layout", { state });
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain("impeccable-build");
    expect(result.workflowId).not.toBe("impeccable-build");
    expect(result.evidence.rejected).toContainEqual({ id: "impeccable-build", reason: "skill impeccable-ui is not installed" });
    expect(result.warnings.join(" ")).toContain("impeccable-build is not available");
  });

  it("checks plugins, secrets and project facts; optional secrets and prose machines never exclude", () => {
    const find = (id: string) => catalog.find((workflow) => workflow.id === id)!;
    expect(stateProblem(find("issue-full"), { plugin: (name) => (name === "tasks" ? false : undefined) })).toBe("plugin tasks is not available");
    expect(stateProblem(find("web-research"), { secret: (name) => (name === "TAVILY_API_KEY" ? false : undefined) })).toBe("secret TAVILY_API_KEY is not set");
    expect(stateProblem(find("code-review"), { project: (key) => (key === "git" ? false : undefined) })).toBe("the project has no git");
    expect(stateProblem(find("brainstorm-driven"), { secret: () => false, machine: () => false })).toBeNull();
    expect(stateProblem(find("code-review"), undefined)).toBeNull();
  });
});

describe("the model port", () => {
  const phrase = "Add a rate limiter to the login endpoint";

  it("calls a plugged model with the top five cards, and its choice wins", async () => {
    let seen: Parameters<RouterModel>[0] | null = null;
    const model: RouterModel = async (input) => {
      seen = input;
      return { choice: "quality-loop", confidence: 88, pattern: "a bounded change", rejected: [{ id: "analyze-plan-execute", reason: "too heavy" }], questions: [] };
    };
    const result = await route(phrase, { model, context: "login is in src/auth.ts" });
    expect(seen!.intent).toBe(phrase);
    expect(seen!.context).toBe("login is in src/auth.ts");
    expect(seen!.candidates.length).toBe(TOP_N);
    expect(seen!.candidates[0]).toMatchObject({ id: "analyze-plan-execute", name: { en: expect.any(String), ru: expect.any(String) }, score: expect.any(Number), rules: expect.any(Array) });
    expect(seen!.candidates[0]!.examples.en.length).toBeGreaterThan(0);
    // The router hands the model cards, not graphs.
    expect(seen!.candidates[0]).not.toHaveProperty("nodes");
    expect(result).toMatchObject({ decision: "route", workflowId: "quality-loop", confidence: 88 });
    expect(result.evidence).toMatchObject({ pattern: "a bounded change", model: "external", rejected: expect.arrayContaining([{ id: "analyze-plan-execute", reason: "too heavy" }]) });
  });

  it("a plugged model is used by default through setRouterModel, and unplugging goes back to the scorer", async () => {
    setRouterModel(async () => ({ choice: "quality-loop", confidence: 91, pattern: "plugged", rejected: [], questions: [] }));
    expect((await route(phrase)).workflowId).toBe("quality-loop");
    setRouterModel(null);
    const back = await route(phrase);
    expect(back.workflowId).toBe("analyze-plan-execute");
    expect(back.evidence.model).toBe("deterministic");
  });

  it("a null choice means questions, and they are the model's, at most three", async () => {
    const result = await route(phrase, { model: async () => ({ choice: null, confidence: 0, pattern: "unclear", rejected: [], questions: ["a?", "b?", "c?", "d?"] }) });
    expect(result).toMatchObject({ decision: "clarify", workflowId: null, questions: ["a?", "b?", "c?"] });
  });

  it("a model confidence under 60 means questions, whatever it chose", async () => {
    const result = await route(phrase, { model: async () => ({ choice: "quality-loop", confidence: 59, pattern: "unsure", rejected: [], questions: [] }) });
    expect(result.decision).toBe("clarify");
    expect(result.workflowId).toBeNull();
    expect(result.suggested).toBe("quality-loop");
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it("a model that names an id outside the candidates, or throws, is replaced by the scorer and the fall back is recorded", async () => {
    const off = await route(phrase, { model: async () => ({ choice: "lp.build", confidence: 99, pattern: "x", rejected: [], questions: [] }) });
    expect(off.workflowId).toBe("analyze-plan-execute");
    expect(off.evidence.modelFallback).toContain("not among the candidates");
    const broken = await route(phrase, { model: async () => { throw new Error("rate limit"); } });
    expect(broken.workflowId).toBe("analyze-plan-execute");
    expect(broken.evidence.modelFallback).toContain("rate limit");
  });

  it("a state-excluded workflow is never in the cards the model sees", async () => {
    let ids: string[] = [];
    await route(phrase, { state: { project: () => false }, model: async (input) => { ids = input.candidates.map((card) => card.id); return { choice: null, confidence: 0, pattern: "", rejected: [], questions: [] }; } });
    expect(ids).not.toContain("analyze-plan-execute");
  });
});
