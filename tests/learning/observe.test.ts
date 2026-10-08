import { describe, expect, it } from "vitest";
import { createObserver, finalRouteOf, fractionOf } from "../../src/rooms/learning/observe";
import { createDecisionsClient, signalsFromDecisions, type DecisionsClient } from "../../src/rooms/learning/opinion";
import { getObservation, usageToday } from "../../src/rooms/learning/store";
import { routeOf } from "../../src/rooms/learning/judgment";
import { NOW, config, database, jevWith, message } from "./helpers";

const CORRECTION = /не так|зачем|убери/i;
const RULES: Array<[RegExp, Parameters<typeof jevWith>[1][number][1]]> = [
  [/бесит|задолбал/i, { kind: ["correction", 0.8], durable: 0.7, level2: 0.8 }],
  [CORRECTION, { kind: ["correction", 0.85], durable: 0.8, scope: "project" }],
  [/мож(?:ет|но) быть/i, { kind: ["correction", 0.4], durable: 0.5 }],
  [/ребёнок болеет/i, { kind: ["fact", 0.8], durable: 0.8 }],
  [/напомни/i, { kind: ["deadline", 0.8], deadline: 0.9 }],
];
const SECOND_OK = (learnP: number, over: Record<string, number> = {}) => ({
  async ask() {
    return { ok: true as const, signals: { kind: "correction" as const, kindP: 0.8, learnP, durable: learnP, scope: "project" as const, scopeP: 0.7, deadline: 0.02, frustration: 0, mild: 0, ...over },
      route: routeOf({ learnP, deadline: 0.02, durable: learnP }), tokensIn: 733, latencyMs: 210, model: "gpt-6-luna" };
  },
});

function observer(options: { cfg?: Parameters<typeof config>[0]; second?: Pick<DecisionsClient, "ask"> | null; jevFail?: boolean; frustrations?: unknown[] } = {}) {
  const db = database();
  const { jev, calls } = jevWith(db, RULES, { fail: options.jevFail === true });
  const asked: string[] = [];
  const second = options.second === undefined ? { ask: async (input: { text: string }) => { asked.push(input.text); return SECOND_OK(0.8).ask(); } } : options.second;
  const value = createObserver({
    db, jev: () => jev, decisions: second, now: () => NOW, config: async () => config(options.cfg),
    prevReply: async () => "Готово, окно добавил.",
    onFrustration: async (input) => { options.frustrations?.push(input); },
  });
  return { db, calls, asked, ...value };
}
const handle = (o: ReturnType<typeof observer>, text: string, id?: string) => o.observe(message(text, id ? { id } : {}), { live: true });

describe("the hook on owner messages (T1)", () => {
  it("records what Jev made of a message and keeps no text in observe mode", async () => {
    const o = observer();
    const row = (await handle(o, "Зачем такое окно? Убери его и не делай так"))!;
    expect(row).toMatchObject({ state: "observed", jevStatus: "ok", kind: "correction", route: "learn", finalRoute: "learn", scope: "project", body: null });
    expect(row.learnP).toBeGreaterThan(0.8);
    const stored = getObservation(o.db, row.id)!;
    expect(stored.body).toBeNull();
    expect(stored.excerpt).toContain("Зачем такое окно");
    // the receipt is the shared Jev receipt, with the answers and without the text
    const receipt = o.db.prepare("SELECT judgment, status, decision, subject FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(receipt).toMatchObject({ judgment: "learning.owner_message", status: "ok", decision: "learn:correction", subject: row.id });
  });

  it("sends the previous agent reply as context and masks personal data before anything leaves", async () => {
    const o = observer();
    await handle(o, "Зачем такое окно? Убери. Моя почта owner@example.com, телефон +7 999 123 45 67");
    const state = o.calls[0]!.state;
    expect(state.owner_message).toContain("[email]");
    expect(state.owner_message).toContain("[phone]");
    expect(state.owner_message).not.toContain("owner@example.com");
    expect(state.previous_agent_reply).toBe("Готово, окно добавил.");
  });

  it("asks nothing about acknowledgements, tiny and pasted messages, and a message it saw before", async () => {
    const o = observer();
    expect(await handle(o, "ок")).toMatchObject({ state: "skipped", skipReason: "short" });
    expect(await handle(o, "Давай!")).toMatchObject({ skipReason: "short" });
    expect(await handle(o, "x".repeat(13_000))).toMatchObject({ skipReason: "pasted" });
    expect(o.calls).toHaveLength(0);
    const first = await handle(o, "Запусти тесты и покажи результат прогона", "thr_a:900:0");
    expect(first).not.toBeNull();
    expect(await handle(o, "Запусти тесты и покажи результат прогона", "thr_a:900:0")).toBeNull();
    expect(o.calls).toHaveLength(1);
  });

  it("stops at the daily cap and samples by a stable hash of the message id", async () => {
    const o = observer({ cfg: { dailyJudgeCap: 2, secondOpinion: false } });
    await handle(o, "Запусти тесты и покажи результат прогона");
    await handle(o, "Покажи статус по задачам, пожалуйста");
    expect(await handle(o, "А теперь собери релиз и выложи его")).toMatchObject({ state: "skipped", skipReason: "cap" });
    expect(usageToday(o.db, NOW).judged).toBe(2);
    const none = observer({ cfg: { sample: 0 } });
    expect(await handle(none, "Запусти тесты и покажи результат прогона")).toMatchObject({ skipReason: "sample" });
    expect(fractionOf("thr_a:1:0", "sample")).toBe(fractionOf("thr_a:1:0", "sample"));
  });

  it("does nothing at all when switched off", async () => {
    const o = observer({ cfg: { enabled: false } });
    expect(await handle(o, "Зачем такое окно? Убери")).toBeNull();
    expect(o.calls).toHaveLength(0);
  });

  it("subscribes as one consumer and survives a message it cannot judge", async () => {
    const o = observer();
    await o.consumer.handle([message("Зачем такое окно? Убери"), message("Запусти тесты и покажи результат")], { live: true });
    expect(o.db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs").get()).toEqual({ n: 2 });
    expect(o.consumer.name).toBe("learning");
  });

  it("keeps the masked text for the extractor only in active mode, and never for a sensitive message", async () => {
    const o = observer({ cfg: { mode: "active" } });
    const row = (await handle(o, "Зачем такое окно? Убери его, почта a@b.io"))!;
    expect(row).toMatchObject({ state: "candidate" });
    expect(getObservation(o.db, row.id)!.body).toContain("[email]");
    expect(getObservation(o.db, row.id)!.prev).toBe("Готово, окно добавил.");
    const secret = (await handle(o, "У меня ребёнок болеет, поэтому отвечай мне только вечером"))!;
    expect(secret).toMatchObject({ sensitive: true, excerpt: null, body: null, state: "observed" });
    expect(o.asked.filter((text) => text.includes("ребёнок"))).toEqual([]);
  });
});

describe("the second opinion (T2)", () => {
  it("is asked for a contested message and decides it", async () => {
    const o = observer();
    const row = (await handle(o, "Может быть, стоит писать короче? Не знаю"))!;
    expect(row).toMatchObject({ route: "contested", secondStatus: "ok", secondRoute: "learn", finalRoute: "learn", secondTokens: 733, secondMs: 210 });
    expect(o.asked).toHaveLength(1);
  });

  it("settles a contested message as nothing when the second opinion is not sure either", async () => {
    const o = observer({ second: SECOND_OK(0.1) });
    expect(await handle(o, "Может быть, стоит писать короче? Не знаю")).toMatchObject({ route: "contested", secondRoute: "none", finalRoute: "none" });
  });

  it("stands in for Jev when Jev cannot answer", async () => {
    const o = observer({ jevFail: true });
    const row = (await handle(o, "Зачем такое окно? Убери его и не делай так"))!;
    expect(row).toMatchObject({ jevStatus: "error", route: null, secondRoute: "learn", finalRoute: "learn" });
  });

  it("is skipped when the cap for the day is spent, and a contested message then goes to the extractor", async () => {
    const o = observer({ cfg: { secondOpinionDailyCap: 0 } });
    expect(await handle(o, "Может быть, стоит писать короче? Не знаю")).toMatchObject({ route: "contested", secondStatus: null, finalRoute: "none" });
  });

  it("is sampled for the agreement report, and a disagreement sends the message on", async () => {
    const o = observer({ cfg: { agreeSample: 1 }, second: SECOND_OK(0.9) });
    const row = (await handle(o, "Запусти тесты и покажи результат прогона"))!;
    expect(row).toMatchObject({ route: "none", secondRoute: "learn", finalRoute: "learn" });
    expect(finalRouteOf("none", "learn", true)).toBe("learn");
    expect(finalRouteOf("contested", undefined, false)).toBe("none");
    expect(finalRouteOf("contested", undefined, true)).toBe("learn");
    expect(finalRouteOf(undefined, undefined, true)).toBeNull();
  });

  it("never leaves the machine for a sensitive message", async () => {
    const o = observer({ cfg: { agreeSample: 1 } });
    await handle(o, "У меня ребёнок болеет, поэтому отвечай мне только вечером");
    expect(o.asked).toEqual([]);
  });

  it("can be switched off", async () => {
    const o = observer({ cfg: { secondOpinion: false } });
    expect(await handle(o, "Может быть, стоит писать короче? Не знаю")).toMatchObject({ secondStatus: null });
  });
});

describe("annoyance (T6 input)", () => {
  it("is recorded as a signal in observe mode and handed on in active mode", async () => {
    const seen: unknown[] = [];
    const o = observer({ cfg: { mode: "observe" }, frustrations: seen });
    await handle(o, "Меня это уже бесит, зачем ты опять так делаешь");
    expect(o.db.prepare("SELECT kind, p FROM lane_pilot_learning_signal").all()).toEqual([{ kind: "frustration", p: 0.8 }]);
    expect(seen).toHaveLength(0);
    const active = observer({ cfg: { mode: "active" }, frustrations: seen });
    await handle(active, "Меня это уже бесит, зачем ты опять так делаешь");
    expect(seen).toHaveLength(1);
  });
});

describe("the Decisions client", () => {
  const body = {
    model: "gpt-6-luna", usage: { input_tokens: 733 },
    answers: [
      { type: "choice", name: "kind", choice: "correction", probabilities: [{ value: "task_request", probability: 0.1 }, { value: "correction", probability: 0.8 }, { value: "rule", probability: 0.1 }] },
      { type: "predicate", name: "durable", probability: 0.7 },
      { type: "choice", name: "scope", choice: "owner", probabilities: [{ value: "owner", probability: 0.6 }, { value: "task", probability: 0.4 }] },
      { type: "predicate", name: "deadline", probability: 0.03 },
      { type: "score", name: "frustration", score: 1.7, probabilities: [{ value: 0, label: "calm", probability: 0.1 }, { value: 1, label: "mild", probability: 0.2 }, { value: 2, label: "frustrated", probability: 0.7 }] },
    ],
  };
  const client = (respond: () => Promise<Response>, key: string | null = "sk-test-secret-key") => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let now = 0;
    return { requests, advance: (ms: number) => { now += ms; }, value: createDecisionsClient({ apiKey: async () => key ?? undefined, now: () => now, fetch: (async (url: string, init: RequestInit) => { requests.push({ url, init }); return await respond(); }) as never }) };
  };
  const ok = () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("sends the five questions with the key from the Env Catalog and reads the answers as Jev's signals", async () => {
    const c = client(ok);
    const result = await c.value.ask({ text: "Зачем такое окно?", prev: "Готово" });
    expect(result).toMatchObject({ ok: true, route: "learn", tokensIn: 733, model: "gpt-6-luna" });
    if (result.ok) expect(result.signals).toMatchObject({ kind: "correction", kindP: 0.8, durable: 0.7, scope: "owner", frustration: 0.7 });
    const sent = JSON.parse(String(c.requests[0]!.init.body)) as { model: string; input: string; questions: Array<{ name: string }> };
    expect(sent.model).toBe("gpt-6-luna");
    expect(sent.input).toContain("Зачем такое окно?");
    expect(sent.questions.map((q) => q.name)).toEqual(["kind", "durable", "scope", "deadline", "frustration"]);
    expect((c.requests[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-secret-key");
  });

  it("reports a missing key, an error and an unreadable answer as results, never as a throw, and never echoes the key", async () => {
    expect(await client(ok, null).value.ask({ text: "x" })).toMatchObject({ ok: false, status: "disabled" });
    expect(await client(() => Promise.resolve(new Response("no", { status: 500 }))).value.ask({ text: "x" })).toMatchObject({ ok: false, status: "error", error: "http 500" });
    expect(await client(() => Promise.resolve(new Response(JSON.stringify({ answers: [] }), { status: 200 }))).value.ask({ text: "x" })).toMatchObject({ ok: false, status: "invalid" });
    const leak = await client(() => Promise.reject(new Error("connect failed for Bearer sk-test-secret-key"))).value.ask({ text: "x" });
    expect(JSON.stringify(leak)).not.toContain("sk-test-secret-key");
  });

  it("pauses after five failures in a row and resumes later", async () => {
    const c = client(() => Promise.resolve(new Response("busy", { status: 429 })));
    for (let i = 0; i < 5; i++) await c.value.ask({ text: "x" });
    expect(await c.value.ask({ text: "x" })).toMatchObject({ status: "breaker_open" });
    expect(c.requests).toHaveLength(5);
    c.advance(6 * 60_000);
    await c.value.ask({ text: "x" });
    expect(c.requests).toHaveLength(6);
  });

  it("reads the frustration levels by label as well as by number", () => {
    const signals = signalsFromDecisions([{ type: "choice", name: "kind", probabilities: [{ value: "rule", probability: 0.9 }] },
      { type: "score", name: "frustration", probabilities: [{ value: "mild", probability: 0.3 }, { value: "frustrated", probability: 0.6 }] }] as never);
    expect(signals).toMatchObject({ kind: "rule", frustration: 0.6, mild: 0.9 });
  });
});
