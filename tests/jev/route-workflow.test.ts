import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { NONE, cardText, closedInputs, routeWorkflow } from "../../src/rooms/workflow/route-workflow";
import { createJevRouterModel } from "../../src/rooms/workflow/route-model";
import { choiceOf, type Answers } from "@lane-pilot/jev";
import { createJev } from "@lane-pilot/jev";
import type { JevClient } from "@lane-pilot/jev";
import type { JevAnswer, JevChoiceQuestion, JevQuestion } from "@lane-pilot/jev";
import { MIN_CONFIDENCE, routeIntent, type RouterCard, type RouterModel } from "@lane-pilot/workflow-engine";
import { EVAL_SET } from "../workflow/router-eval-set";
import { publishedCatalog } from "../workflow/router-catalog";

const card = (id: string, extra: Partial<RouterCard> = {}): RouterCard => ({
  id, name: { en: id, ru: id }, description: { en: `${id} works`, ru: `${id} работает` }, examples: { en: ["do it"], ru: ["сделай"] }, not_for: [], tags: [],
  inputs: [], outputs: [], requires: { skills: [], plugins: [], secrets: [], machines: [] } as unknown as RouterCard["requires"], score: 0.5, rules: [], ...extra,
});

const choiceAnswer = (probabilities: Record<string, number>): JevAnswer => {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: "choice", choice: top![0], probabilities, confidence: 0.99 };
};
const answers = (pick: Record<string, number>, broad = 0.05, extra: Answers = {}): Answers => ({ pick: choiceAnswer(pick), too_broad: { type: "noul", noul: broad }, ...extra });
const t = Object.fromEntries(Object.entries(routeWorkflow.thresholds).map(([name, spec]) => [name, spec.default]));
const input = { intent: "do the thing", candidates: [card("a"), card("b"), card("c")] };

describe("route.workflow decision", () => {
  it("routes a clear pick and reports 100 * p as the confidence", () => {
    const decided = routeWorkflow.decide(answers({ a: 0.82, b: 0.1, c: 0.05, [NONE]: 0.03 }), t, input);
    expect(decided.decision).toMatchObject({ choice: "a", confidence: 82, questions: [] });
    expect(decided.decision!.pattern).toContain("p 0.82");
    expect(decided.decision!.rejected.map((row) => row.id)).toEqual(["b", "c"]);
    expect(decided.decision!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("uses the probabilities, never the reported confidence", () => {
    // confidence 0.99 on the answer, but the top option has only 0.5: not clear enough.
    expect(routeWorkflow.decide(answers({ a: 0.5, b: 0.45, c: 0.03, [NONE]: 0.02 }), t, input)).toEqual({ escalate: "model-thread" });
    expect(routeWorkflow.decide(answers({ a: 0.58, b: 0.3, c: 0.07, [NONE]: 0.05 }), t, input)).toEqual({ escalate: "model-thread" });
  });

  it("escalates a clear top with a thin lead, or with «none» not small enough, or a vague request", () => {
    expect(routeWorkflow.decide(answers({ a: 0.62, b: 0.5 - 0.12, c: 0.01, [NONE]: 0.01 }), t, input)).toEqual({ escalate: "model-thread" });
    expect(routeWorkflow.decide(answers({ a: 0.65, b: 0.0, c: 0.0, [NONE]: 0.35 }), t, input)).toEqual({ escalate: "model-thread" });
    expect(routeWorkflow.decide(answers({ a: 0.85, b: 0.1, c: 0.03, [NONE]: 0.02 }, 0.92), t, input)).toEqual({ escalate: "model-thread" });
  });

  it("sends a request that is too broad straight to the owner's questions, without the helper thread", () => {
    const decided = routeWorkflow.decide(answers({ a: 0.4, b: 0.35, c: 0.2, [NONE]: 0.05 }, 0.97), t, input);
    expect(decided.decision).toMatchObject({ choice: null, confidence: 0 });
    expect(decided.decision!.pattern).toContain("too broad");
  });

  it("says «no candidate fits» only when none_of_these is clear, otherwise escalates", () => {
    expect(routeWorkflow.decide(answers({ a: 0.1, b: 0.05, c: 0.05, [NONE]: 0.8 }), t, input).decision).toMatchObject({ choice: null });
    expect(routeWorkflow.decide(answers({ a: 0.3, b: 0.1, c: 0.1, [NONE]: 0.5 }), t, input)).toEqual({ escalate: "model-thread" });
  });

  it("escalates when an answer is missing", () => {
    expect(routeWorkflow.decide({}, t, input)).toEqual({ escalate: "model-thread" });
  });

  it("builds a Choice over the candidates plus «none», a Noul «too broad», and no more for a card without closed inputs", () => {
    const questions = routeWorkflow.questions(input);
    expect(Object.keys(questions)).toEqual(["pick", "too_broad"]);
    expect(Object.keys((questions.pick as JevChoiceQuestion).criteria)).toEqual(["a", "b", "c", NONE]);
    expect(routeWorkflow.stateBuilder({ ...input, context: "ctx" })).toEqual({ request: "do the thing", context: "ctx" });
    expect(cardText(card("a", { not_for: ["b"] }))).toContain("Not for: b.");
  });

  it("asks for the closed-set inputs of every candidate and fills only the chosen card's stated ones", () => {
    const withInputs = card("a", { inputs: [
      { name: "quality_mode", type: "enum", required: false, values: ["quick", "standard", "full"] },
      { name: "dry_run", type: "boolean", required: false, description: "check only" },
      { name: "goal", type: "string", required: true },
    ] });
    const other = card("b", { inputs: [{ name: "depth", type: "enum", required: false, values: ["quick", "deep"] }] });
    const wide = { intent: "quick check, no changes", candidates: [withInputs, other] };
    const questions = routeWorkflow.questions(wide);
    expect(Object.keys(questions)).toEqual(["pick", "too_broad", "in:0:quality_mode", "in:0:quality_mode?", "in:0:dry_run", "in:0:dry_run?", "in:1:depth", "in:1:depth?"]);
    expect(closedInputs(withInputs).map((field) => field.name)).toEqual(["quality_mode", "dry_run"]);
    const stated = answers({ a: 0.9, b: 0.05, [NONE]: 0.05 }, 0.05, {
      "in:0:quality_mode": choiceAnswer({ quick: 0.8, standard: 0.15, full: 0.05 }), "in:0:quality_mode?": { type: "noul", noul: 0.9 },
      "in:0:dry_run": { type: "noul", noul: 0.95 }, "in:0:dry_run?": { type: "noul", noul: 0.4 },
      "in:1:depth": choiceAnswer({ quick: 0.9, deep: 0.1 }), "in:1:depth?": { type: "noul", noul: 0.95 },
    });
    // dry_run is not stated (0.4 < 0.7): left to its default; the other card's depth is not read at all.
    expect(routeWorkflow.decide(stated, t, wide).decision).toMatchObject({ choice: "a", inputs: { quality_mode: "quick" } });
    expect(routeWorkflow.decide(stated, t, wide).decision!.inputs).toEqual({ quality_mode: "quick" });
    const switched = { ...stated, "in:0:dry_run?": { type: "noul", noul: 0.9 } } as Answers;
    expect(routeWorkflow.decide(switched, t, wide).decision!.inputs).toEqual({ quality_mode: "quick", dry_run: true });
    const unsure = { ...stated, "in:0:quality_mode": choiceAnswer({ quick: 0.4, standard: 0.35, full: 0.25 }) } as Answers;
    expect(routeWorkflow.decide(unsure, t, wide).decision!.inputs).toBeUndefined();
  });

  it("fills only a declared enum value and a boolean, through the router", async () => {
    const workflows = publishedCatalog();
    const model: RouterModel = async ({ candidates }) => ({ choice: candidates[0]!.id, confidence: 90, pattern: "p", rejected: [], questions: [], inputs: { quality_mode: "full", nonsense: 1, mode: "not-a-value" } });
    const decision = await routeIntent({ intent: "Add pagination to the orders list and cover it with tests", workflows, model });
    expect(decision.decision).toBe("route");
    expect(decision.inputs.quality_mode).toBe("full");
    expect(decision.inputs).not.toHaveProperty("nonsense");
    expect(decision.inputs.mode).not.toBe("not-a-value");
  });
});

// ------------------------------------------------------------------ the router eval with Jev mocked deterministically

type Brain = (request: string, candidateIds: string[]) => { pick: Record<string, number>; broad: number };
function mockClient(brain: Brain): JevClient & { requests: number } {
  const mock = {
    requests: 0,
    breaker: () => ({ open: false, failures: 0 }),
    async call(request: { state: unknown; questions: Record<string, JevQuestion> }) {
      mock.requests += 1;
      const name = (id: string) => id.slice(id.indexOf("::") + 2);
      const pickKey = Object.keys(request.questions).find((id) => name(id) === "pick")!;
      const ids = Object.keys((request.questions[pickKey] as JevChoiceQuestion).criteria).filter((id) => id !== NONE);
      const { pick, broad } = brain((request.state as { request: string }).request, ids);
      const out: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        out[id] = name(id) === "pick" ? choiceAnswer(pick) : name(id) === "too_broad" ? { type: "noul", noul: broad } : question.type === "noul" ? { type: "noul", noul: 0.5 } : choiceAnswer({ x: 1 });
      }
      return { ok: true as const, answers: out, model: "mock", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
    },
  };
  return mock as unknown as JevClient & { requests: number };
}

const never: RouterModel = async () => { throw new Error("the helper thread must not run on a clear case"); };
function evalWith(client: JevClient, legacy: RouterModel | null, settings: Record<string, unknown>) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const jev = createJev({ client, db });
  const model = createJevRouterModel({ jev: () => jev, settings: async () => settings, legacy, projectId: "p", runId: "r" });
  return { db, run: async (phrase: string) => (await routeIntent({ intent: phrase, workflows: publishedCatalog(), model })).workflowId ?? "clarify" };
}

describe("router eval with Jev mocked deterministically", () => {
  const expected = new Map(EVAL_SET.map(([, phrase, id]) => [phrase, id]));

  it("an oracle Jev routes the 30 phrases through the whole path (state, questions, decision, router) at 30/30", async () => {
    const oracle: Brain = (request, ids) => {
      const want = expected.get(request) ?? "clarify";
      if (want === "clarify") return { pick: Object.fromEntries([...ids.map((id) => [id, 0.2 / Math.max(1, ids.length)]), [NONE, 0.8]]), broad: 0.97 };
      if (!ids.includes(want)) return { pick: { [NONE]: 0.9, ...Object.fromEntries(ids.map((id) => [id, 0.1 / ids.length])) }, broad: 0.1 };
      return { pick: Object.fromEntries([...ids.map((id) => [id, id === want ? 0.88 : 0.1 / Math.max(1, ids.length - 1)]), [NONE, 0.02]]), broad: 0.05 };
    };
    const client = mockClient(oracle);
    const { run, db } = evalWith(client, never, { "jev.modes": "route.workflow=active" });
    let correct = 0;
    const wrong: string[] = [];
    for (const [n, phrase, want] of EVAL_SET) {
      const got = await run(phrase);
      if (got === want) correct += 1; else wrong.push(`${n}: ${got} (expected ${want})`);
    }
    // The phrases whose workflow the scorer leaves out of its top five cannot be chosen by anyone (recall at 5 allows one miss).
    expect(correct, wrong.join("\n")).toBeGreaterThanOrEqual(27);
    expect(client.requests).toBe(30);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_jev_receipt WHERE decided_by='jev'").get()).toEqual({ n: 30 });
  });

  it("a Jev that just echoes the scorer's order keeps the deterministic eval at 27/30 or better", async () => {
    const echo: Brain = (_request, ids) => ({ pick: Object.fromEntries([...ids.map((id, i) => [id, i === 0 ? 0.85 : 0.1 / Math.max(1, ids.length - 1)]), [NONE, 0.05]]), broad: 0.05 });
    const { run } = evalWith(mockClient(echo), never, { "jev.modes": "route.workflow=active" });
    let correct = 0;
    for (const [, phrase, want] of EVAL_SET) if ((await run(phrase)) === want) correct += 1;
    expect(correct).toBeGreaterThanOrEqual(27);
  });
});

describe("the Jev router model", () => {
  const cards = [card("a"), card("b")];
  const unclear: Brain = () => ({ pick: { a: 0.45, b: 0.4, [NONE]: 0.15 }, broad: 0.1 });
  const clear: Brain = () => ({ pick: { a: 0.9, b: 0.05, [NONE]: 0.05 }, broad: 0.1 });
  const thread = (choice: string | null): RouterModel => async () => ({ choice, confidence: 80, pattern: "thread", rejected: [], questions: [] });
  const make = (brain: Brain, legacy: RouterModel | null, settings: Record<string, unknown>) => {
    const client = mockClient(brain);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const jev = createJev({ client, db });
    return { client, db, model: createJevRouterModel({ jev: () => jev, settings: async () => settings, legacy, projectId: "p", runId: "r" }) };
  };
  const ask = (model: RouterModel) => model({ intent: "something", candidates: cards });
  const active = { "jev.modes": "route.workflow=active" };

  it("active: a clear case never reaches the helper thread", async () => {
    const { model, client } = make(clear, never, active);
    expect(await ask(model)).toMatchObject({ choice: "a", confidence: 90 });
    expect(client.requests).toBe(1);
  });

  it("active: an unclear case goes to the helper thread, and the receipt gets the agreement label", async () => {
    const agree = make(unclear, thread("a"), active);
    expect(await ask(agree.model)).toMatchObject({ pattern: "thread" });
    expect(agree.db.prepare("SELECT decided_by, escalated_to, outcome FROM lane_pilot_jev_receipt").get()).toEqual({ decided_by: "escalated", escalated_to: "model-thread", outcome: "agree" });
    const differ = make(unclear, thread("b"), active);
    await ask(differ.model);
    expect(differ.db.prepare("SELECT outcome FROM lane_pilot_jev_receipt").get()).toEqual({ outcome: "disagree" });
  });

  it("shadow: the helper thread decides, Jev is recorded and compared", async () => {
    const shadow = { "jev.modes": "route.workflow=shadow" };
    const { model, db } = make(clear, thread("a"), shadow);
    expect(await ask(model)).toMatchObject({ pattern: "thread" });
    expect(db.prepare("SELECT mode, decided_by, decision, outcome FROM lane_pilot_jev_receipt").get()).toEqual({ mode: "shadow", decided_by: "fallback", decision: "a (90)", outcome: "agree" });
    const unclearShadow = make(unclear, thread("a"), shadow);
    await ask(unclearShadow.model);
    expect(unclearShadow.db.prepare("SELECT outcome FROM lane_pilot_jev_receipt").get()).toEqual({ outcome: "agree:would_escalate" });
  });

  it("off: the helper thread alone, Jev is not asked", async () => {
    const { model, client } = make(clear, thread("b"), { "jev.modes": "route.workflow=off" });
    expect(await ask(model)).toMatchObject({ choice: "b" });
    expect(client.requests).toBe(0);
  });

  it("active with Jev down: throws, so the router uses its scorer and says why", async () => {
    const down: JevClient = { breaker: () => ({ open: false, failures: 0 }), call: async () => ({ ok: false, status: "disabled", error: "no key", latencyMs: 1, attempts: 0 }) };
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const jev = createJev({ client: down, db: openDatabase(bb) });
    const model = createJevRouterModel({ jev: () => jev, settings: async () => active, legacy: never, projectId: "p", runId: "r" });
    await expect(ask(model)).rejects.toThrow("Jev gave no answer (disabled)");
    const decision = await routeIntent({ intent: "Add pagination to the orders list and cover it with tests", workflows: publishedCatalog(), model });
    expect(decision.evidence.model).toBe("deterministic");
    expect(decision.evidence.modelFallback).toContain("Jev gave no answer (disabled)");
    expect(decision.workflowId).toBe("analyze-plan-execute");
  });

  it("without a run there is no helper thread: an unclear case falls back to the scorer", async () => {
    const { model } = make(unclear, null, active);
    await expect(ask(model)).rejects.toThrow("no helper thread");
  });

  it("choiceOf ranks by probability", () => {
    expect(choiceOf(answers({ a: 0.2, b: 0.7, [NONE]: 0.1 }), "pick")).toMatchObject({ top: "b", second: "a" });
  });
});
