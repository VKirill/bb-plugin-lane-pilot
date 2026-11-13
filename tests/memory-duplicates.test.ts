import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { EMBED_DIM, dedupeProject, dropMemoryIndexes, duplicatePairs, duplicateWords, factsAgree, parseMemorySettings, searchMemoryRecords, storeMemoryRecords, storeVectors, textRelation, type MemoryCandidate } from "@lane-pilot/memory-core";
import { migrations } from "../src/rooms/plugin-db";
import { runMemoryImport } from "../src/rooms/memory/server/import";
import { runMemoryDuplicatesCli } from "../src/rooms/memory/server/memory-duplicates-cli";

const LIMITS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 99_999 };
const fresh = () => { const db = new Database(":memory:"); for (const m of migrations) db.exec(m); return db; };
const write = (db: Database.Database, content: string, extra: Record<string, unknown> = {}) => storeMemoryRecords(db as never, { ...LIMITS, projectId: "p", audience: "subagent", sourceSha256: "a".repeat(64), origin: "maintainer",
  entries: [{ kind: "note", content, concepts: ["t"] } as MemoryCandidate], ...extra });
const FACT = "The Muse relay connector signs every outbound request with a rotating token and retries three times before it parks the job.";
const status = (db: Database.Database, id: string) => db.prepare("SELECT status, expired_reason, superseded_by FROM lane_pilot_memory WHERE id=?").get(id) as { status: string; expired_reason: string | null; superseded_by: string | null };

describe("near-duplicate door", () => {
  it("an imported copy with a source mark creates no row and is recorded as an origin of the stored note", () => {
    const db = fresh();
    const first = write(db, FACT);
    const copy = write(db, `[из авто-памяти Claude Code, project memory] ${FACT}`, { origin: "import", sourceSha256: "b".repeat(64) });
    expect(copy.insertedIds).toEqual([]);
    expect(copy.duplicateIds).toEqual(first.insertedIds);
    expect((db.prepare("SELECT count(*) n FROM lane_pilot_memory").get() as { n: number }).n).toBe(1);
    const verification = JSON.parse((db.prepare("SELECT verification_json v FROM lane_pilot_memory").get() as { v: string }).v) as Array<{ by: string; sha: string }>;
    expect(verification.map((item) => item.by)).toEqual(["maintainer", "import"]);
    // the same source again adds no second origin
    write(db, `[x] ${FACT}`, { origin: "import", sourceSha256: "b".repeat(64) });
    expect(JSON.parse((db.prepare("SELECT verification_json v FROM lane_pilot_memory").get() as { v: string }).v)).toHaveLength(2);
  });

  it("a strict superset replaces the shorter note as a new version", () => {
    const db = fresh();
    const first = write(db, FACT);
    const longer = write(db, `${FACT} A parked job is rescanned by the shift lead.`);
    expect(longer.insertedIds).toHaveLength(1);
    expect(longer.supersededIds).toEqual(first.insertedIds);
    expect(status(db, first.insertedIds[0]!).status).toBe("superseded");
  });

  it("a changed number or a flipped negation is an update, not a copy", () => {
    expect(factsAgree("kept for 14 days", "kept for 30 days")).toBe(false);
    expect(factsAgree("the cache is enabled for all", "the cache is not enabled for all")).toBe(false);
    const db = fresh();
    write(db, "Database backups run at 02:00 UTC and are kept for 14 days; restore drills happen monthly.");
    const changed = write(db, "Database backups run at 02:00 UTC and are kept for 30 days; restore drills happen monthly.");
    expect(changed.insertedIds).toHaveLength(1);
    expect(changed.duplicateIds).toEqual([]);
  });

  it("another section is not compared", () => {
    const db = fresh();
    write(db, FACT);
    expect(write(db, FACT, { scope: ["web"] }).insertedIds).toHaveLength(1);
    expect(write(db, `[m] ${FACT}`, { scope: ["web"] }).duplicateIds).toHaveLength(1);
  });

  it("a cosine of 0.92 or more is a copy even when the words differ", () => {
    const db = fresh();
    const first = write(db, "Parcels leave the Lisbon depot after the evening scan at the loading gate.");
    const vec = new Float32Array(EMBED_DIM); vec[3] = 1;
    storeVectors(db as never, [{ id: first.insertedIds[0]!, projectId: "p", content: "x", vector: vec }]);
    const near = new Float32Array(EMBED_DIM); near[3] = 1; near[4] = 0.1;
    const copy = write(db, "Evening scanning finishes before trucks depart the Portuguese warehouse gate.", { vectorOf: () => near });
    expect(copy.insertedIds).toEqual([]);
    expect(copy.duplicateIds).toEqual(first.insertedIds);
    const far = new Float32Array(EMBED_DIM); far[9] = 1;
    expect(write(db, "Totally different statement about quarterly invoice rounding policy for suppliers.", { vectorOf: () => far }).insertedIds).toHaveLength(1);
  });

  it("the import reports a copy as merged, with the stored note's id", () => {
    const db = fresh();
    const first = write(db, FACT);
    const line = JSON.stringify({ source_id: "m1", content: `[из авто-памяти Claude Code] ${FACT}`, kind: "project" });
    const report = runMemoryImport({ db: db as never, projectId: "p", source: "claude-files", jsonl: line, settings: parseMemorySettings({}) });
    expect(report.counts).toEqual({ added: 0, merged_with: 1, dropped: 0 });
    expect(report.outcomes[0]!.id).toBe(first.insertedIds[0]);
  });
});

describe("memory duplicates and dedupe", () => {
  const seed = () => {
    const db = fresh();
    const a = write(db, FACT, { now: Date.now() - 3000 }).insertedIds[0]!;
    // planted with the door off, as the hub's existing copies were
    const b = write(db, `[из авто-памяти Claude Code] ${FACT}`, { now: Date.now() - 2000, nearDuplicates: false, origin: "import" }).insertedIds[0]!;
    write(db, "Quarantined pallets are scanned at bay twelve by the night crew and tagged with a violet sticker.", { now: Date.now() - 1000 });
    return { db, a, b };
  };

  it("lists the pairs read-only", () => {
    const { db, a, b } = seed();
    expect(duplicatePairs(db as never, "p").map((pair) => [pair.keep, pair.copy, pair.relation])).toEqual([[a, b, "copy"]]);
    const out = runMemoryDuplicatesCli(db as never, "duplicates", ["--json"], "p");
    expect(JSON.parse(out.stdout!)[0].count).toBe(1);
    expect(status(db, b).status).toBe("active");
  });

  it("a dry run changes nothing; --apply expires the copy as duplicate, keeps it in the archive, and the search returns one", () => {
    const { db, a, b } = seed();
    const dry = dedupeProject(db as never, "p", { unindex: () => {} });
    expect(dry.applied).toBe(false);
    expect(status(db, b).status).toBe("active");
    const done = dedupeProject(db as never, "p", { apply: true, unindex: (p, id) => dropMemoryIndexes(db as never, p, id) });
    expect(done.merged).toEqual([{ keep: a, copy: b, relation: "copy" }]);
    expect(status(db, b)).toEqual({ status: "expired", expired_reason: "duplicate", superseded_by: a });
    const ask = () => searchMemoryRecords(db as never, "p", "Muse relay connector token", 10, "fts5", "subagent", "", { includeArchive: true, includeObserved: true }).map((record) => record.id);
    expect(ask()).toEqual([a]);
    // the archived copy is still found once the note it duplicates is not part of the result
    db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='owner' WHERE id=?").run(a);
    expect(ask()).toEqual([b]);
  });

  it("short or very different sizes do not make a pair", () => {
    expect(textRelation(duplicateWords(`[x] ${FACT}`), duplicateWords(FACT)).relation).toBe("copy");
    expect(textRelation(duplicateWords("Use cursor pagination."), duplicateWords("Use cursor pagination with page size fifty.")).relation).toBeNull();
  });
});
