import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { EXAM_LIVE, authorize, runLiveExam } from "../../src/rooms/policy/exam";
import { LIVE_EXAM_KEY, LIVE_STORE_LIMIT_BYTES, STANDING_DAYS, appendLiveItems, collectAndAppend, collectOwnerDecisions, loadLiveExam, recordOwnerDecision } from "../../src/rooms/policy/live-exam";
import { POLICY } from "../../src/rooms/policy/policy";

const FREEZE = Date.parse(POLICY.frozen_at);
const HOUR = 3_600_000, DAY = 24 * HOUR;

function seeded() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  db.exec("PRAGMA foreign_keys=OFF");
  const rule = (id: string, state: string, always = 0) => db.prepare("INSERT INTO lane_pilot_rule_proposal(id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at,always_on) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "proj_1", id, `rule text of ${id}`, "model", state, 1, 1, "[]", FREEZE, FREEZE, FREEZE, always);
  const event = (rule_id: string, action: string, at: number, detail: string | null = null) => db.prepare("INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,detail,at) VALUES ('proj_1',?,?,?,?)").run(rule_id, action, detail, at);
  const obs = (id: string, review: string | null, at: number, sensitive = 0) => db.prepare("INSERT INTO lane_pilot_learning_obs(id,thread_id,project_id,at,judged_at,source,chars,excerpt,state,sensitive,kind,final_route,review,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "t", "proj_1", at, at, "owner", 10, `excerpt ${id}`, "extracted", sensitive, "rule", "adopted", review, review ? at : null);
  return { db, rule, event, obs };
}
const memoryKv = () => {
  const store = new Map<string, unknown>();
  return { store, kv: { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => { store.set(key, value); } } };
};

describe("collectOwnerDecisions", () => {
  it("turns each kind of new owner decision into an item, and ignores everything at or before the freeze", () => {
    const { db, rule, event, obs } = seeded();
    rule("r_rej", "rejected"); rule("r_acc", "accepted"); rule("r_rev", "revoked"); rule("r_old", "rejected");
    event("r_rej", "owner_rejected", FREEZE + HOUR); event("r_acc", "owner_accepted", FREEZE + 2 * HOUR, "from the Rules tab"); event("r_rev", "owner_revoked", FREEZE + 3 * HOUR);
    event("r_old", "owner_rejected", FREEZE - HOUR); // seen: before the freeze
    obs("o_ok", "ok", FREEZE + 4 * HOUR); obs("o_wrong", "wrong", FREEZE + 5 * HOUR); obs("o_old", "ok", FREEZE - DAY); obs("o_secret", "ok", FREEZE + HOUR, 1); obs("o_none", null, FREEZE + HOUR);

    const items = collectOwnerDecisions(db, FREEZE, FREEZE + 6 * HOUR);
    expect(items.map((item) => item.source.ref)).toEqual(["proj_1/r_rej#owner_rejected", "proj_1/r_acc#owner_accepted", "proj_1/r_rev#owner_revoked", "o_ok", "o_wrong"]);
    const by = Object.fromEntries(items.map((item) => [item.source.ref, item]));
    expect(by["proj_1/r_rej#owner_rejected"]).toMatchObject({ expected: "night_proposes", strength: "medium", descriptor: { kind: "rule_adopt", attrs: { trial: true, always_on: false } } });
    expect(by["proj_1/r_acc#owner_accepted"]!.quote).toContain("from the Rules tab");
    expect(by.o_ok).toMatchObject({ expected: "night_decides", descriptor: { kind: "learning_item_adopt" } });
    expect(by.o_wrong).toMatchObject({ expected: "night_proposes" });
    for (const item of items) expect(Date.parse(item.decided_at)).toBeGreaterThan(FREEZE);
  });

  it("an auto-adopted rule the owner left for the standing period is a weak night_decides item, dated when the period ended", () => {
    const { db, rule, event } = seeded();
    rule("r_quiet", "accepted"); rule("r_young", "accepted"); rule("r_taken_back", "revoked"); rule("r_retired", "revoked");
    event("r_quiet", "adopted", FREEZE + HOUR); event("r_young", "adopted", FREEZE + 3 * DAY); event("r_taken_back", "adopted", FREEZE + HOUR); event("r_taken_back", "owner_revoked", FREEZE + DAY);
    const now = FREEZE + (STANDING_DAYS + 1) * DAY;
    const items = collectOwnerDecisions(db, FREEZE, now).filter((item) => item.quote.startsWith("adopted by the night"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: { ref: "proj_1/r_quiet#left_standing" }, expected: "night_decides", strength: "weak" });
    expect(Date.parse(items[0]!.decided_at)).toBe(FREEZE + HOUR + STANDING_DAYS * DAY);
  });

  it("is deterministic: the same decision gets the same id", () => {
    const { db, rule, event } = seeded();
    rule("r1", "rejected"); event("r1", "owner_rejected", FREEZE + HOUR);
    expect(collectOwnerDecisions(db, FREEZE)[0]!.id).toBe(collectOwnerDecisions(db, FREEZE)[0]!.id);
    expect(collectOwnerDecisions(db, FREEZE)[0]!.id).toMatch(/^y_[0-9a-f]{12}$/);
  });
});

describe("the store", () => {
  it("appends once, never edits, merges with the committed items in decision order", async () => {
    const { db, rule, event } = seeded();
    rule("r1", "rejected"); rule("r2", "rejected");
    event("r2", "owner_rejected", FREEZE + 2 * HOUR); event("r1", "owner_rejected", FREEZE + HOUR);
    const { kv, store } = memoryKv();
    expect(await collectAndAppend(db, kv, FREEZE + DAY)).toMatchObject({ added: 2, skipped: 0 });
    const first = JSON.stringify(store.get(LIVE_EXAM_KEY));
    expect(await collectAndAppend(db, kv, FREEZE + DAY)).toMatchObject({ added: 0 });
    expect(JSON.stringify(store.get(LIVE_EXAM_KEY))).toBe(first);
    const merged = await loadLiveExam(kv);
    expect(merged.items.map((item) => item.source.ref)).toEqual([...EXAM_LIVE.items.map((item) => item.source.ref), "proj_1/r1#owner_rejected", "proj_1/r2#owner_rejected"]);
  });

  it("refuses to grow past the plugin store limit and says what to do", async () => {
    const { kv } = memoryKv();
    const big = (n: number) => recordOwnerDecision({ quote: `q ${n}`, ref: `thr_${n}`, at: FREEZE + n, descriptor: { kind: "x", attrs: { pad: "p".repeat(200) } }, expected: "night_proposes", why: "w".repeat(300) });
    let failure = "";
    try { for (let n = 0; n < 2000; n++) await appendLiveItems(kv, [big(n)]); } catch (cause) { failure = String(cause); }
    expect(failure).toContain(`${LIVE_STORE_LIMIT_BYTES}`);
    expect(failure).toContain("exam-export");
  });

  it("recordOwnerDecision validates the item", () => {
    expect(() => recordOwnerDecision({ quote: "", ref: "thr", at: FREEZE + 1, descriptor: {}, expected: "owner_only", why: "w" })).toThrow();
    const item = recordOwnerDecision({ quote: "нет, не надо так", ref: "thr_7#3", at: FREEZE + 1000, descriptor: { kind: "stage_add" }, expected: "owner_only", why: "he refused it" });
    expect(item).toMatchObject({ strength: "strong", source: { type: "owner_message" } });
  });
});

describe("the growing exam gates the night end to end", () => {
  it("20 decisions the policy agrees with open the gate; fewer keep it shut", async () => {
    const { kv } = memoryKv();
    const repair = { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts"], attrs: { bench_subset_passed: true, auto_revertible: true } };
    for (let n = 0; n < 19; n++) await appendLiveItems(kv, [recordOwnerDecision({ quote: `ok ${n}`, ref: `thr_${n}`, at: FREEZE + 1000 + n, descriptor: n % 2 ? { kind: "stage_add" } : repair, expected: n % 2 ? "night_proposes" : "night_decides", why: "w" })]);
    expect(authorize(repair, { exam: await loadLiveExam(kv) })).toMatchObject({ tier: "night_proposes", degraded: true });
    await appendLiveItems(kv, [recordOwnerDecision({ quote: "ok 19", ref: "thr_19", at: FREEZE + 2000, descriptor: { kind: "data_delete" }, expected: "owner_only", why: "w" })]);
    const exam = await loadLiveExam(kv);
    expect(runLiveExam(POLICY, exam)).toMatchObject({ enough: true, passed: true, accuracy: 1 });
    expect(authorize(repair, { exam })).toMatchObject({ tier: "night_decides", degraded: false });
  });
});
