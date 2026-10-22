import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { disagreement, findConflicts, listMemory, searchMemoryRecords, storeMemoryRecords, heldClause } from "../packages/memory-core/src";
import { createDeferrals } from "../src/rooms/deferral/server";
import { deferralKindMigrations, deferralMigrations } from "../src/rooms/deferral/migrations";
import { createMemoryConflicts, runMemoryConflictCli } from "../src/rooms/memory/server";
import { openDatabase } from "../src/rooms/storage/database";

// SMA block 4, P2-7: two notes that disagree are held, both, with a term the owner gives, until a person settles it.
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const T = Date.parse("2026-10-22T10:00:00Z");
// Tags that share only one word: a restated note with two shared tags would replace the older one at write (`sameSubject`), not conflict with it.
const TA = ["seo-landings", "redis"], TB = ["seo-landings", "cache", "deploy"];

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const deferrals = createDeferrals({ db, port: { getThread: async () => null, listEvents: async () => [] }, now: () => T });
  const conflicts = createMemoryConflicts({ db, deferrals: () => deferrals, now: () => T });
  const put = (content: string, concepts: string[], at = T - 1000) =>
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content, concepts }], now: at }).insertedIds[0]!;
  return { db, deferrals, conflicts, put };
}

describe("detection", () => {
  const note = (id: string, content: string, concepts: string[] = []) => ({ id, content, concepts, createdAt: 1 });

  it("finds two numbers for one quantity of the same file", () => {
    const found = disagreement(
      note("a", "src/cache/store.ts keeps entries for a cache TTL of 24 h before it refetches."),
      note("b", "src/cache/store.ts evicts after a cache TTL of 48 h."));
    expect(found).toMatchObject({ kind: "value" });
    expect(found?.evidenceA).toContain("24");
    expect(found?.evidenceB).toContain("48");
  });

  it("finds one sentence affirmed and denied", () => {
    const found = disagreement(
      note("a", "The upload worker in apps/worker/src/upload.ts retries failed jobs with backoff after a network error."),
      note("b", "The upload worker in apps/worker/src/upload.ts does not retry failed jobs with backoff after a network error."));
    expect(found).toMatchObject({ kind: "polarity" });
  });

  it("finds one constant with two values", () => {
    const found = disagreement(
      note("a", "In apps/api/src/config.ts the limit is `MAX_UPLOAD_MB` = `10`."),
      note("b", "apps/api/src/config.ts sets `MAX_UPLOAD_MB` = `25` for uploads."));
    expect(found).toMatchObject({ kind: "literal" });
  });

  it("leaves alone notes that agree, that are about different files, or that differ in a negation of another clause", () => {
    expect(disagreement(note("a", "src/cache/store.ts has a cache TTL of 24 h."), note("b", "src/cache/store.ts has a cache TTL of 24 h, set in config."))).toBeNull();
    expect(disagreement(note("a", "src/cache/store.ts has a cache TTL of 24 h."), note("b", "src/other/thing.ts has a cache TTL of 48 h."))).toBeNull();
    expect(disagreement(
      note("a", "apps/site/i18n/locales/areas.json lists only the area home in the catalog."),
      note("b", "It is NOT listed anywhere else, apps/site/i18n/locales/areas.json lists only the home area."))).toBeNull();
  });

  it("with `only`, looks at the pairs that include a new note", () => {
    const notes = [note("a", "src/x/y.ts has a cache TTL of 24 h."), note("b", "src/x/y.ts has a cache TTL of 48 h."), note("c", "unrelated")];
    expect(findConflicts(notes)).toHaveLength(1);
    expect(findConflicts(notes, new Set(["c"]))).toHaveLength(0);
    expect(findConflicts(notes, new Set(["b"]))).toHaveLength(1);
  });
});

describe("the register", () => {
  const A = "The Redis key for the seo-landings list in apps/admin/src/seo.ts expires after a cache TTL of 24 h.";
  const B = "apps/admin/src/seo.ts: the seo-landings Redis key has a cache TTL of 48 h and is bumped on deploy.";


  it("holds both notes out of search and listing, and opens a deferral that waits for the owner's term", () => {
    const { db, conflicts, deferrals, put } = setup();
    const a = put(A, TA, T - 2000);
    put("Unrelated note about apps/admin/src/other.ts and billing.", ["billing"]);
    expect(searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "")).toHaveLength(1);
    const b = put(B, TB, T - 1000);
    const opened = conflicts.detect("P", new Set([b]));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ noteA: [a, b].sort()[0], state: "held", kind: "value" });

    // Neither reaches any reader.
    expect(searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "")).toEqual([]);
    expect(listMemory(db, "P", {}, 10).map((record) => record.id)).not.toContain(a);
    const raw = db.prepare(`SELECT id FROM lane_pilot_memory WHERE project_id='P' AND status='active'${heldClause(db, "lane_pilot_memory")}`).all() as Array<{ id: string }>;
    expect(raw.map((row) => row.id)).not.toContain(a);
    expect(raw.map((row) => row.id)).not.toContain(b);
    expect(db.prepare("SELECT count(*) n FROM lane_pilot_memory WHERE project_id='P' AND status='active'").get()).toEqual({ n: 3 });

    // The deferral register holds it, untermed: the morning list, never overdue.
    const entry = deferrals.list({ projectId: "P" }).needsOwnerTerm.find((item) => item.id === opened[0]!.deferralId);
    expect(entry).toMatchObject({ kind: "memory_conflict", state: "needs_owner_term", due: null, projectId: "P" });
    expect(deferrals.list({ projectId: "P" }).overdue).toEqual([]);
  });

  it("does not open the same pair twice", () => {
    const { conflicts, put } = setup();
    put(A, TA, T - 2000);
    const b = put(B, TB, T - 1000);
    expect(conflicts.detect("P", new Set([b]))).toHaveLength(1);
    expect(conflicts.detect("P")).toHaveLength(0);
  });

  it("settling with keep a releases a and retires b, and closes the deferral with the evidence", () => {
    const { db, conflicts, deferrals, put } = setup();
    const first = put(A, TA, T - 2000);
    const second = put(B, TB, T - 1000);
    const [row] = conflicts.detect("P");
    expect(() => conflicts.settle({ id: row!.id, keep: "a", evidence: "short" })).toThrow(/evidence/);
    const keepId = row!.noteA;
    const settled = conflicts.settle({ id: row!.id, keep: "a", evidence: "checked apps/admin/src/seo.ts: the TTL is 24 h" });
    expect(settled).toMatchObject({ state: "settled", resolution: "keep_a" });
    const alive = searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "").map((record) => record.id);
    expect(alive).toEqual([keepId]);
    expect([first, second]).toContain(keepId);
    expect(deferrals.list({ projectId: "P", state: "closed" }).entries.find((item) => item.id === row!.deferralId)?.closedBy).toContain("keep_a");
    expect(() => conflicts.settle({ id: row!.id, keep: "b", evidence: "again, with a reason" })).toThrow(/already settled/);
  });

  it("settling with both releases both and the pair is never held again", () => {
    const { db, conflicts, put } = setup();
    put(A, TA, T - 2000);
    put(B, TB, T - 1000);
    const [row] = conflicts.detect("P");
    conflicts.settle({ id: row!.id, keep: "both", evidence: "two different keys, both true" });
    expect(searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "")).toHaveLength(2);
    expect(conflicts.detect("P")).toEqual([]);
  });

  it("a conflict whose note is replaced settles itself as moot", () => {
    const { db, conflicts, deferrals, put } = setup();
    put(A, TA, T - 2000);
    put(B, TB, T - 1000);
    const [row] = conflicts.detect("P");
    db.prepare("UPDATE lane_pilot_memory SET status='expired' WHERE project_id='P' AND id=?").run(row!.noteA);
    const swept = conflicts.sweepMoot("P");
    expect(swept.map((item) => item.resolution)).toEqual(["moot"]);
    expect(deferrals.list({ projectId: "P", state: "closed" }).entries.map((item) => item.id)).toContain(row!.deferralId);
  });

  it("stops opening entries when a project holds too many (the heuristics are misfiring)", () => {
    const { conflicts, put } = setup();
    for (let index = 0; index < 30; index++) {
      put(`apps/admin/src/f${index}.ts keeps a cache TTL of 24 h for item${index}.`, [`a${index}`, "shared"], T - 5000 - index);
      put(`apps/admin/src/f${index}.ts keeps a cache TTL of 48 h for item${index}.`, [`b${index}`, "other"], T - 1000 - index);
    }
    expect(conflicts.detect("P").length).toBe(25);
    expect(conflicts.list({ projectId: "P", state: "held" })).toHaveLength(25);
  });
});

describe("the command line", () => {
  it("lists, detects and settles", () => {
    const { conflicts, put } = setup();
    put("apps/admin/src/seo.ts keeps a cache TTL of 24 h for the seo-landings key.", TA, T - 2000);
    put("apps/admin/src/seo.ts keeps a cache TTL of 48 h for the seo-landings key.", TB, T - 1000);
    const listed = JSON.parse(runMemoryConflictCli(conflicts, "memory-conflicts", ["--project", "P", "--detect"]).stdout!);
    expect(listed.opened).toBe(1);
    const id = listed.conflicts[0].id as string;
    expect(runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "b"]).exitCode).toBe(1);
    expect(runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "x", "--evidence", "a good reason"]).stderr).toMatch(/--keep is a/);
    const done = runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "none", "--evidence", "both are stale, the code changed"]);
    expect(JSON.parse(done.stdout!)).toMatchObject({ state: "settled", resolution: "drop_both" });
    expect(runMemoryConflictCli(conflicts, "memory-conflicts", ["--detect"]).exitCode).toBe(1);
  });
});

describe("the deferral table rebuild", () => {
  it("keeps the rows of the old table and accepts the new kind", () => {
    const db = new Database(":memory:");
    for (const statement of deferralMigrations) db.exec(statement);
    db.prepare("INSERT INTO lane_pilot_deferral(id,what,kind,state,created_at,updated_at) VALUES('dfr_old','an old one','gate','needs_owner_term',1,1)").run();
    expect(() => db.prepare("INSERT INTO lane_pilot_deferral(id,what,kind,state,created_at,updated_at) VALUES('x','y','memory_conflict','needs_owner_term',1,1)").run()).toThrow();
    for (const statement of deferralKindMigrations) db.exec(statement);
    expect(db.prepare("SELECT id, kind FROM lane_pilot_deferral").all()).toEqual([{ id: "dfr_old", kind: "gate" }]);
    db.prepare("INSERT INTO lane_pilot_deferral(id,what,kind,state,created_at,updated_at) VALUES('x','y','memory_conflict','needs_owner_term',1,1)").run();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='lane_pilot_deferral_state'").all() as unknown[]).length).toBe(1);
  });
});
