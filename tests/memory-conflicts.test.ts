import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { disagreement, findConflicts, holdConflict, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { createDeferrals } from "../src/rooms/deferral/server";
import { deferralKindMigrations, deferralMigrations } from "../src/rooms/deferral/migrations";
import { createMemoryConflicts, runMemoryConflictCli } from "../src/rooms/memory/server";
import { openDatabase } from "../src/rooms/storage/database";

// SMA block 4, P2-7: two notes that disagree are settled at once, the newer one kept; nobody is asked.
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


  it("settles a pair at once: the newer note supersedes the older one, no deferral, nobody is asked", () => {
    const { db, conflicts, deferrals, put } = setup();
    const a = put(A, TA, T - 2000);
    put("Unrelated note about apps/admin/src/other.ts and billing.", ["billing"]);
    const b = put(B, TB, T - 1000);
    const settled = conflicts.detect("P", new Set([b]));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ state: "settled", kind: "value", resolution: settled[0]!.noteA === b ? "keep_a" : "keep_b" });
    expect(settled[0]!.settledBy).toMatch(/^automatic: the newer note/);
    expect(searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "").map((record) => record.id)).toEqual([b]);
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(a)).toEqual({ status: "superseded" });
    expect(deferrals.list({ projectId: "P" }).entries).toEqual([]);
  });

  it("does not open the same pair twice", () => {
    const { conflicts, put } = setup();
    put(A, TA, T - 2000);
    const b = put(B, TB, T - 1000);
    expect(conflicts.detect("P", new Set([b]))).toHaveLength(1);
    expect(conflicts.detect("P")).toHaveLength(0);
  });

  it("a pair held before (when a person settled them) can still be settled by hand, and settles itself as moot when a note is gone", () => {
    const { db, conflicts, put } = setup();
    put(A, TA, T - 2000);
    put(B, TB, T - 1000);
    const notes = (db.prepare("SELECT id, content, concepts_json, created_at FROM lane_pilot_memory WHERE project_id='P'").all() as Array<{ id: string; content: string; concepts_json: string; created_at: number }>)
      .map((row) => ({ id: row.id, content: row.content, concepts: JSON.parse(row.concepts_json) as string[], createdAt: row.created_at }));
    const held = holdConflict(db, { projectId: "P", personalBot: "", conflict: findConflicts(notes)[0]!, now: T })!;
    expect(() => conflicts.settle({ id: held.id, keep: "a", evidence: "short" })).toThrow(/evidence/);
    expect(conflicts.settle({ id: held.id, keep: "both", evidence: "two different keys, both true" })).toMatchObject({ state: "settled", resolution: "keep_both" });
    expect(searchMemoryRecords(db, "P", "seo landings redis cache", 10, "auto", "subagent", "")).toHaveLength(2);
    expect(() => conflicts.settle({ id: held.id, keep: "b", evidence: "again, with a reason" })).toThrow(/already settled/);

    db.prepare("DELETE FROM lane_pilot_memory_conflict").run();
    const again = holdConflict(db, { projectId: "P", personalBot: "", conflict: findConflicts(notes)[0]!, now: T })!;
    db.prepare("UPDATE lane_pilot_memory SET status='expired' WHERE project_id='P' AND id=?").run(again.noteA);
    expect(conflicts.sweepMoot("P").map((item) => item.resolution)).toEqual(["moot"]);
  });

  it("settles nothing when one write finds too many pairs (the heuristics are misfiring)", () => {
    const { conflicts, put } = setup();
    for (let index = 0; index < 30; index++) {
      put(`apps/admin/src/f${index}.ts keeps a cache TTL of 24 h for item${index}.`, [`a${index}`, "shared"], T - 5000 - index);
      put(`apps/admin/src/f${index}.ts keeps a cache TTL of 48 h for item${index}.`, [`b${index}`, "other"], T - 1000 - index);
    }
    expect(conflicts.detect("P")).toEqual([]);
    expect(conflicts.list({ projectId: "P" })).toEqual([]);
  });
});

describe("the command line", () => {
  it("lists and detects; a settled pair is not settled again and --keep is checked", () => {
    const { conflicts, put } = setup();
    put("apps/admin/src/seo.ts keeps a cache TTL of 24 h for the seo-landings key.", TA, T - 2000);
    put("apps/admin/src/seo.ts keeps a cache TTL of 48 h for the seo-landings key.", TB, T - 1000);
    const listed = JSON.parse(runMemoryConflictCli(conflicts, "memory-conflicts", ["--project", "P", "--detect"]).stdout!);
    expect(listed.opened).toBe(1);
    const id = listed.conflicts[0].id as string;
    expect(listed.conflicts[0]).toMatchObject({ state: "settled", resolution: expect.stringMatching(/^keep_/) });
    expect(runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "b"]).exitCode).toBe(1);
    expect(runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "x", "--evidence", "a good reason"]).stderr).toMatch(/--keep is a/);
    expect(runMemoryConflictCli(conflicts, "memory-conflict-settle", [id, "--keep", "none", "--evidence", "both are stale, the code changed"]).stderr).toMatch(/already settled/);
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
