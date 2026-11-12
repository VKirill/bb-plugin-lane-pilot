import { describe, expect, it } from "vitest";
import { createOwnerMessageHub, TURN_REQUESTED, type EventLike, type ThreadLike } from "../../src/rooms/anamnesis/owner-messages";
import { DEFAULT_CONFIG, loadConfig, parseConfigWords, saveConfig } from "../../src/rooms/learning/config";
import { FIRST_LOOK_MS, THROTTLE_MS, createLiveFeed } from "../../src/rooms/learning/live";
import { createObserver } from "../../src/rooms/learning/observe";
import { createOps, type Kv } from "../../src/rooms/learning/ops";
import { DAY_MS, getItem, insertItem } from "../../src/rooms/learning/store";
import { NOW, config, database, message } from "./helpers";

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
    const hub = createOwnerMessageHub();
    hub.subscribe(createObserver({ db, config: async () => config() }).consumer);
    const live = createLiveFeed({ hub, now: () => NOW, readEvents: async () => [turn(7, "Запусти тесты и покажи результат прогона")] });
    await live.heard(thread(), { force: true });
    expect(db.prepare("SELECT id, project_id, source FROM lane_pilot_learning_obs").all()).toEqual([{ id: "thr_pm:7:0", project_id: "proj_1", source: "live" }]);
  });
});

describe("the configuration", () => {
  const store = () => { const map = new Map<string, unknown>(); return { map, kv: { get: async <T>(key: string) => map.get(key) as T | undefined, set: async (key: string, value: unknown) => { map.set(key, value); } } as unknown as Kv }; };

  it("starts on with the caps set", async () => {
    expect(await loadConfig(store().kv)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ enabled: true, dailyCandidateCap: 400, nightRuns: 12, nightBatch: 25 });
  });

  it("changes by key=value words and refuses an unknown key (also a removed one) or a value out of range", async () => {
    const s = store();
    expect(parseConfigWords(["nightBatch=10", "enabled=false"])).toEqual({ nightBatch: 10, enabled: false });
    await saveConfig(s.kv, parseConfigWords(["dailyCandidateCap=100"]));
    expect(await loadConfig(s.kv)).toMatchObject({ dailyCandidateCap: 100, nightBatch: 25 });
    expect(() => parseConfigWords(["nope=1"])).toThrow(/unknown setting/);
    expect(() => parseConfigWords(["secondOpinion=false"])).toThrow(/unknown setting/);
    expect(() => parseConfigWords(["nightBatch=300"])).toThrow();
  });

  it("reads a record an older version saved (with mode and the second opinion's keys) without losing the rest", async () => {
    const s = store();
    s.map.set("learning:config", { enabled: true, mode: "observe", sample: 1, secondOpinion: false, dailyJudgeCap: 300, pmRulesTokens: 900 });
    expect(await loadConfig(s.kv)).toMatchObject({ enabled: true, pmRulesTokens: 900, nightBatch: 25 });
  });
});

describe("status (T1)", () => {
  async function seeded() {
    const db = database();
    const observer = createObserver({ db, config: async () => config(), now: () => NOW });
    for (const text of ["Убери это окно, пожалуйста", "Убери и это тоже, не надо так", "ок", "[Lane Pilot] фаза перешла в ревью", "Запусти тесты и покажи результат"]) await observer.observe(message(text), { live: true });
    const map = new Map<string, unknown>();
    const kv = { get: async (key: string) => map.get(key), set: async (key: string, value: unknown) => { map.set(key, value); } } as unknown as Kv;
    return { db, map, ops: createOps({ db, kv, now: () => NOW }) };
  }

  it("says what is waiting for the night run, what the filter dropped, and what the last night did", async () => {
    const { map, ops } = await seeded();
    const before = await ops.status();
    expect(before).toMatchObject({ enabled: true, candidatesWaiting: 3, observations: { candidate: 3, skipped: 2 }, skippedLast7Days: { short: 1, machine: 1 }, today: { candidates: 3, candidateCap: 400 }, lastNightRun: null });
    expect(before).not.toHaveProperty("mode");
    expect(before).not.toHaveProperty("readyForActive");
    const night = { at: NOW, projects: 1, batches: 1, read: 3, items: 1, adopted: 1, waiting: 0, duplicates: 0, noted: 0, dropped: 0 };
    map.set("learning:last-night", night);
    expect((await ops.status()).lastNightRun).toEqual(night);
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
