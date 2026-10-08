import { describe, expect, it } from "vitest";
import { createOwnerMessageHub, TURN_REQUESTED, type EventLike, type ThreadLike } from "../../src/rooms/anamnesis/owner-messages";
import { DEFAULT_CONFIG, loadConfig, parseConfigWords, saveConfig } from "../../src/rooms/learning/config";
import { FIRST_LOOK_MS, THROTTLE_MS, createLiveFeed } from "../../src/rooms/learning/live";
import { createObserver } from "../../src/rooms/learning/observe";
import { createOps, type Kv } from "../../src/rooms/learning/ops";
import { DAY_MS, agreementReport, getItem, insertItem, labelObservation, reviewStats } from "../../src/rooms/learning/store";
import { NOW, config, database, jevWith, message } from "./helpers";

const thread = (over: Partial<ThreadLike> = {}): ThreadLike => ({ id: "thr_pm", projectId: "proj_1", createdAt: NOW - 10 * DAY_MS, visibility: "visible", ...over });
const turn = (seq: number, text: string, over: Partial<EventLike["data"]> = {}, at = NOW - 1_000): EventLike =>
  ({ seq, type: TURN_REQUESTED, createdAt: at, data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }], ...over } });

function feed(events: EventLike[]) {
  const hub = createOwnerMessageHub();
  const delivered: string[] = [];
  hub.subscribe({ name: "probe", handle: (batch) => { delivered.push(...batch.map((m) => m.text)); } });
  let clock = NOW, reads = 0;
  const live = createLiveFeed({ hub, now: () => clock, readEvents: async () => { reads += 1; return [...events].sort((a, b) => b.seq - a.seq); } });
  return { live, delivered, reads: () => reads, advance: (ms: number) => { clock += ms; }, events };
}

describe("the live feed of owner messages (T1)", () => {
  it("reads a thread when BB says it became active and delivers only the owner's new messages, once", async () => {
    const f = feed([turn(1, "старое сообщение", {}, NOW - 2 * FIRST_LOOK_MS), turn(2, "Всегда пиши отчёты по-русски"), turn(3, "служебное", { initiator: "agent" })]);
    expect(await f.live.heard(thread(), { force: true })).toBe(true);
    expect(f.delivered).toEqual(["Всегда пиши отчёты по-русски"]);
    f.events.push(turn(4, "А теперь убери это окно"));
    f.advance(1_000);
    await f.live.heard(thread(), { force: true });
    expect(f.delivered).toEqual(["Всегда пиши отчёты по-русски", "А теперь убери это окно"]);
    await f.live.heard(thread(), { force: true });
    expect(f.delivered).toHaveLength(2);
  });

  it("drops writer, helper and plugin threads before reading anything", async () => {
    const f = feed([turn(1, "привет, это сообщение владельца")]);
    expect(await f.live.heard(thread({ parentThreadId: "thr_pm" }), { force: true })).toBe(false);
    expect(await f.live.heard(thread({ originPluginId: "lane-pilot" }), { force: true })).toBe(false);
    expect(await f.live.heard(thread({ visibility: "hidden" }), { force: true })).toBe(false);
    expect(await f.live.heard(null, { force: true })).toBe(false);
    expect(f.reads()).toBe(0);
  });

  it("throttles the debounced events of a thread but not the active and idle ones", async () => {
    const f = feed([turn(1, "первое сообщение владельца")]);
    await f.live.heard(thread());
    await f.live.heard(thread());
    expect(f.reads()).toBe(1);
    f.advance(THROTTLE_MS + 1);
    await f.live.heard(thread());
    expect(f.reads()).toBe(2);
    await f.live.heard(thread(), { force: true });
    expect(f.reads()).toBe(3);
  });

  it("does not replay a fork's copied history", async () => {
    const f = feed([turn(1, "скопировано из родителя", {}, NOW - 5 * DAY_MS)]);
    await f.live.heard(thread({ originKind: "fork", createdAt: NOW - 1_000 }), { force: true });
    expect(f.delivered).toEqual([]);
  });

  it("reaches the observer through the shared hub", async () => {
    const db = database();
    const { jev } = jevWith(db, []);
    const hub = createOwnerMessageHub();
    hub.subscribe(createObserver({ db, jev: () => jev, decisions: null, config: async () => config() }).consumer);
    const live = createLiveFeed({ hub, now: () => NOW, readEvents: async () => [turn(7, "Запусти тесты и покажи результат прогона")] });
    await live.heard(thread(), { force: true });
    expect(db.prepare("SELECT id, project_id, source FROM lane_pilot_learning_obs").all()).toEqual([{ id: "thr_pm:7:0", project_id: "proj_1", source: "live" }]);
  });
});

describe("the configuration", () => {
  const store = () => { const map = new Map<string, unknown>(); return { map, kv: { get: async <T>(key: string) => map.get(key) as T | undefined, set: async (key: string, value: unknown) => { map.set(key, value); } } as unknown as Kv }; };

  it("starts in observe mode with every cost cap set", async () => {
    expect(await loadConfig(store().kv)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ mode: "observe", enabled: true, sample: 1, dailyJudgeCap: 300, secondOpinionDailyCap: 60, agreeSample: 0.1, extractorRunsPerDay: 6, extractorBatch: 12 });
  });

  it("changes by key=value words and refuses an unknown key or a value out of range", async () => {
    const s = store();
    expect(parseConfigWords(["mode=active", "sample=0.5", "secondOpinion=false"])).toEqual({ mode: "active", sample: 0.5, secondOpinion: false });
    await saveConfig(s.kv, parseConfigWords(["mode=active", "dailyJudgeCap=100"]));
    expect(await loadConfig(s.kv)).toMatchObject({ mode: "active", dailyJudgeCap: 100, sample: 1 });
    expect(() => parseConfigWords(["nope=1"])).toThrow(/unknown setting/);
    expect(() => parseConfigWords(["sample=3"])).toThrow();
  });
});

describe("status, review and the agreement report (T1, T2)", () => {
  async function seeded() {
    const db = database();
    const { jev } = jevWith(db, [[/убери/i, { kind: ["correction", 0.85], durable: 0.8 }], [/может быть/i, { kind: ["correction", 0.4], durable: 0.5 }]]);
    let routeOfSecond: "learn" | "none" = "learn";
    const observer = createObserver({
      db, jev: () => jev, config: async () => config({ agreeSample: 1 }), now: () => NOW,
      decisions: { ask: async () => ({ ok: true as const, signals: { kind: "correction", kindP: 0.8, learnP: routeOfSecond === "learn" ? 0.9 : 0.1, durable: 0.5, scope: "project", scopeP: 0.6, deadline: 0, frustration: 0, mild: 0 }, route: routeOfSecond, tokensIn: 1_000_000, latencyMs: 100 + (db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs").get() as { n: number }).n * 100, model: "gpt-6-luna" }) },
    });
    for (const [text, second] of [["Убери это окно, пожалуйста", "learn"], ["Убери и это тоже, не надо так", "none"], ["Может быть, стоит писать короче?", "learn"], ["Запусти тесты и покажи результат", "learn"]] as const) {
      routeOfSecond = second;
      await observer.observe(message(text), { live: true });
    }
    const kv = { get: async () => undefined, set: async () => undefined } as unknown as Kv;
    return { db, ops: createOps({ db, kv, now: () => NOW }) };
  }

  it("counts how the two judges agree, what the second opinion cost and how fast it was", async () => {
    const { db } = await seeded();
    const report = agreementReport(db, NOW - DAY_MS, 0.1);
    expect(report).toMatchObject({ judged: 4, jevAnswered: 4, secondAnswered: 4, bothAnswered: 4, sameRoute: 1, routeAgreement: 0.25, disagreements: 2, contested: 1, contestedResolvedLearn: 1 });
    expect(report.secondTokens).toBe(4_000_000);
    expect(report.secondUsd).toBe(0.4);
    expect(report.secondP50Ms).toBeGreaterThan(0);
  });

  it("is not ready to act before a week of observation and fifty checked cases, and says what is missing", async () => {
    const { ops } = await seeded();
    const status = await ops.status();
    expect(status).toMatchObject({ mode: "observe", readyForActive: false, observations: { observed: 4 }, today: { judged: 4, judgeCap: 300 } });
    expect(status.missing.join(" ")).toMatch(/day\(s\) of observation/);
    expect(status.missing.join(" ")).toMatch(/50 more reviewed case/);
  });

  it("lists cases to mark and keeps the accuracy of the marks", async () => {
    const { db, ops } = await seeded();
    const cases = ops.review(10);
    expect(cases).toHaveLength(4);
    expect(cases[0]).toHaveProperty("text");
    expect(JSON.stringify(cases)).not.toContain("body");
    for (const [index, row] of cases.entries()) ops.label(row.id, index < 3);
    expect(reviewStats(db)).toEqual({ reviewed: 4, correct: 3, accuracy: 0.75 });
    expect(ops.review(10)).toHaveLength(0);
    expect(() => ops.label("thr_x:9:9", true)).toThrow(/not found/);
    expect(labelObservation(db, cases[0]!.id, false, NOW)).toBe(true);
  });

  it("is ready once a week has passed and fifty cases were marked right at 80 percent", async () => {
    const { db } = await seeded();
    db.prepare("UPDATE lane_pilot_learning_obs SET judged_at=?").run(NOW - 8 * DAY_MS);
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO lane_pilot_learning_obs (id,thread_id,project_id,at,judged_at,source,chars,state,jev_status,review,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`thr_r:${i}:0`, "thr_r", "proj_1", NOW, NOW - 8 * DAY_MS, "live", 40, "observed", "ok", i < 42 ? "ok" : "wrong", NOW);
    }
    const kv = { get: async () => undefined, set: async () => undefined } as unknown as Kv;
    const status = await createOps({ db, kv, now: () => NOW }).status();
    expect(status).toMatchObject({ readyForActive: true, missing: [], review: { reviewed: 50, accuracy: 0.84 } });
  });

  it("reads items, and an item without evidence cannot be stored", async () => {
    const { db, ops } = await seeded();
    const base = { id: "lrn_1", obsId: "thr_a:1:0", projectId: "proj_1", threadId: "thr_a", kind: "rule" as const, text: "Reply in Russian", audience: "both", reach: "project", dueAt: null, state: "adopted" as const,
      target: null, evidence: "owner message thr_a:1:0", duplicateOf: null, confirmations: 0, note: null, createdAt: NOW, decidedAt: null, announcedAt: null };
    expect(insertItem(db, base)).toBe(true);
    expect(() => insertItem(db, { ...base, id: "lrn_2", evidence: " " })).toThrow(/evidence/);
    expect(() => insertItem(db, { ...base, id: "lrn_3", obsId: "" })).toThrow(/evidence/);
    expect(ops.items({ states: ["adopted"] }).map((row) => row.id)).toEqual(["lrn_1"]);
    expect(getItem(db, "lrn_1")?.text).toBe("Reply in Russian");
  });
});
