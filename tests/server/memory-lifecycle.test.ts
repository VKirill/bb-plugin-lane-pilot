import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/database";
import { memoryMaintenancePrompt, parseMemoryCandidates, parseMemorySettings, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import type { MemoryCandidate } from "../../packages/memory-core/src";

type Db = ReturnType<typeof openDatabase>;
const newDb = (): Db => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });
const statusOf = (db: Db, id: string) => (db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(id) as { status: string } | undefined)?.status;
const put = (db: Db, entries: MemoryCandidate[], extra: Partial<Parameters<typeof storeMemoryRecords>[1]> = {}) => storeMemoryRecords(db, { projectId: "P", ...limits, entries, ...extra });

describe("K8 supersession: a newer note on the same subject replaces the older, which is hidden but kept", () => {
  const oldNote = note("Checkout total is computed in src/cart/total.ts with integer cents", ["checkout", "total", "cents"]);
  const newNote = note("Checkout total moved to src/cart/pricing.ts and still uses integer cents", ["checkout", "total", "cents"]);

  it("replaces a restatement, keeps the old row pointing at the new one, finds only the new", () => {
    const db = newDb();
    const first = put(db, [oldNote]).insertedIds[0]!;
    const result = put(db, [newNote]);
    expect(result.supersededIds).toEqual([first]);
    expect(db.prepare("SELECT status,superseded_by FROM lane_pilot_memory WHERE id=?").get(first)).toEqual({ status: "superseded", superseded_by: result.insertedIds[0] });
    expect(searchMemoryRecords(db, "P", "checkout total cents", 10, "fts5").map((row) => row.id)).toEqual(result.insertedIds);
  });

  it("two different facts about one area both stay", () => {
    const db = newDb();
    put(db, [oldNote]);
    const result = put(db, [note("Never call the tax service from the checkout page; the worker does it nightly", ["checkout", "total", "tax"])]);
    expect(result.supersededIds).toEqual([]);
    expect(searchMemoryRecords(db, "P", "checkout total", 10, "fts5")).toHaveLength(2);
  });

  it("a maintainer can name what a note replaces; a one-session note replaces nothing", () => {
    const db = newDb();
    const first = put(db, [note("Release branch is release/1", ["alpha"])]).insertedIds[0]!;
    const explicit = put(db, [{ ...note("Release branch is release/2 since March", ["beta"]), supersedes: [first.slice(0, 12)] }]);
    expect(explicit.supersededIds).toEqual([first]);
    const second = explicit.insertedIds[0]!;
    const observed = put(db, [{ ...note("Release branch is release/3", ["gamma"]), supersedes: [second.slice(0, 12)] }], { trust: "observed", origin: "session", sourceSha256: "b".repeat(64) });
    expect(observed.supersededIds).toEqual([]);
    expect(statusOf(db, second)).toBe("active");
  });

  it("never replaces a rule", () => {
    const db = newDb();
    const rule = put(db, [{ kind: "core", content: "Run npm ci, never npm install", concepts: ["rule", "npm"] }]).insertedIds[0]!;
    put(db, [{ ...note("Run npm ci in the worktree", ["npm"]), supersedes: [rule.slice(0, 12)] }]);
    expect(statusOf(db, rule)).toBe("active");
  });

  it("the maintainer's JSON may carry supersedes and valid_until, and nothing else new", () => {
    const settings = parseMemorySettings({});
    const [entry] = parseMemoryCandidates('[{"kind":"note","content":"Use staging until 2026-12-01","concepts":["env"],"supersedes":["abcdef123456"],"valid_until":"2026-12-01"}]', settings);
    expect(entry).toMatchObject({ supersedes: ["abcdef123456"], validUntil: Date.parse("2026-12-01") });
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], valid_until: "soon" }], settings)).toThrow("valid_until");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], supersedes: ["short"] }], settings)).toThrow("supersedes");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], status: "expired" }], settings)).toThrow("unsupported");
  });
});

describe("K8 expiry: an expired note is not mixed into briefs", () => {
  const day = 24 * 3_600_000;
  const found = (db: Db, now: number) => searchMemoryRecords(db, "P", "staging environment", 10, "fts5", "subagent", "", { now }).map((row) => row.content);

  it("valid_until: found before it, not after, and the next write marks it expired", () => {
    const db = newDb();
    const t0 = Date.UTC(2026, 9, 1);
    const id = put(db, [{ ...note("Use the staging environment for payments", ["staging"]), validUntil: t0 + 10 * day }], { now: t0 }).insertedIds[0]!;
    expect(found(db, t0 + 5 * day)).toHaveLength(1);
    expect(found(db, t0 + 11 * day)).toEqual([]);
    expect(statusOf(db, id)).toBe("active");
    const later = put(db, [note("An unrelated note about caching layers", ["cache"])], { now: t0 + 11 * day });
    expect(later.expiredIds).toEqual([id]);
    expect(statusOf(db, id)).toBe("expired");
  });

  it("an unused note goes stale after 90 days; a used one and core stay", () => {
    const db = newDb();
    const t0 = Date.UTC(2026, 0, 1);
    const stale = put(db, [note("Staging environment note nobody needs", ["stagingnote"])], { now: t0 }).insertedIds[0]!;
    const used = put(db, [note("Staging environment note that is read", ["stagingread"])], { now: t0 }).insertedIds[0]!;
    db.prepare("UPDATE lane_pilot_memory SET last_used_at=? WHERE id=?").run(t0 + 80 * day, used);
    const core = put(db, [{ kind: "core", content: "Staging environment convention for everyone", concepts: ["stagingcore"] }], { now: t0 }).insertedIds[0]!;
    const contents = found(db, t0 + 100 * day);
    expect(contents).toContain("Staging environment note that is read");
    expect(contents).toContain("Staging environment convention for everyone");
    expect(contents).not.toContain("Staging environment note nobody needs");
    put(db, [note("Another small note", ["x"])], { now: t0 + 100 * day });
    expect(statusOf(db, stale)).toBe("expired");
    expect(statusOf(db, used)).toBe("active");
    expect(statusOf(db, core)).toBe("active");
  });

  it("stating a fact again brings an expired note back", () => {
    const db = newDb();
    const t0 = Date.UTC(2026, 0, 1);
    const entry = note("Use the staging environment for payments", ["staging"]);
    const id = put(db, [entry], { now: t0 }).insertedIds[0]!;
    put(db, [note("Another small note", ["x"])], { now: t0 + 100 * day });
    expect(statusOf(db, id)).toBe("expired");
    expect(put(db, [entry], { now: t0 + 101 * day }).insertedIds).toEqual([id]);
    expect(found(db, t0 + 101 * day)).toEqual(["Use the staging environment for payments"]);
  });
});

describe("K8: the maintainer is shown the notes close to the task", () => {
  it("lists them by short id so a changed fact can name the note it replaces", () => {
    const prompt = memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings: parseMemorySettings({}), existing: [{ id: "abcdef1234567890", content: "Port is 8080" }] });
    expect(prompt).toContain("EXISTING NOTES (id: text");
    expect(prompt).toContain("abcdef123456: Port is 8080");
    expect(prompt).toContain("supersedes");
    expect(memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings: parseMemorySettings({}) })).not.toContain("EXISTING NOTES (id: text");
  });
});
