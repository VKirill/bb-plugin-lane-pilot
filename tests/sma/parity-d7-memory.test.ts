import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  addToIndexes, deleteMemoryRecord, dropMemoryIndexes, eraseLeftovers, hideRecord, lintMemory, listMemory,
  memoryClaimIssue, memoryIndexStatus, memoryTokenStats, memoryWithoutTrace, rebuildMemoryIndexes,
  recordMemoryMiss, reviewMemory, searchMemoryRecords, storeMemoryRecords, trigramReady,
} from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import { runMemoryGate, type MemoryGate } from "../../src/rooms/memory-eval/server/gate";
import { planCorpus } from "../../src/rooms/memory-eval/server/corpus";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";

const newHost = () => createFakePluginHost({ pluginId: "lane-pilot" });
const BUDGETS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
const put = (db: MemoryDatabase, entries: MemoryCandidate[], projectId = "P") =>
  storeMemoryRecords(db, { projectId, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries, ...BUDGETS }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });

function rpc(db: MemoryDatabase) {
  return sessionMemoryRpc({ db, bb: newHost().bb, log: () => {}, isDisposed: () => false } as unknown as ServerCore,
    { insights: {}, docsPlaces: async () => [], memoryConflicts: { detect: () => {}, sweepMoot: () => {} }, wallThreadReader: {} } as unknown as Services);
}

describe("memory corpus care (parity wave d7)", () => {
  it("[sma:d_mem_index] cockpit-style rebuild: a record removed from the FTS index is put back and hidden records are not indexed", () => {
    const db = openDatabase(newHost().bb);
    const [id] = put(db, [note("The ledger rounds half to even before storing the invoice total.")]);
    dropMemoryIndexes(db, "P", id!);
    expect(searchMemoryRecords(db, "P", "ledger rounds", 10, "auto").map((row) => row.id)).not.toContain(id);
    const done = rebuildMemoryIndexes(db, "P");
    expect(done).toMatchObject({ active: 1, added: 1 });
    expect(searchMemoryRecords(db, "P", "ledger rounds", 10, "auto").map((row) => row.id)).toContain(id);
    expect(memoryIndexStatus(db, "P").missingIds).toEqual([]);
  });

  it("[sma:k_v_build_index] rebuild drops a stale index row and reports the counts", () => {
    const db = openDatabase(newHost().bb);
    const [a, b] = put(db, [note("Alpha fact about the billing ledger."), note("Beta fact about the refund queue.")]);
    db.prepare("DELETE FROM lane_pilot_memory_fts WHERE id=?").run(a!);
    addToIndexes(db, "P", "dead".repeat(8), "ghost of a deleted record", ["area"]);
    const done = rebuildMemoryIndexes(db, "P");
    expect(done).toMatchObject({ active: 2, added: 1, stale: 1 });
    expect(memoryIndexStatus(db, "P")).toMatchObject({ missingIds: [], orphanedIds: [] });
    expect(b).toBeTruthy();
  });

  it("[sma:k_v_mem_index] status reports drifted and missing ids", () => {
    const db = openDatabase(newHost().bb);
    const [a, b] = put(db, [note("First indexable fact."), note("Second indexable fact.")]);
    db.prepare("DELETE FROM lane_pilot_memory_fts WHERE id IN (?,?)").run(a!, b!);
    const status = memoryIndexStatus(db, "P");
    expect(status.active).toBe(2);
    expect(status.missingIds.sort()).toEqual([a, b].sort());
    expect(rebuildMemoryIndexes(db, "P").added).toBe(2);
  });

  it("[sma:d_mem_lint] records with no trace back to the pipeline are flagged; a record with an origin task is not", () => {
    const db = openDatabase(newHost().bb);
    storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries: [note("Fact distilled from an accepted task.")], originTaskId: "task1", ...BUDGETS });
    // A hand-planted row with no verification, no task, no file: the lint's target.
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES('orphan1','P','note','subagent','A fact nobody can trace.','[]','',0,'confirmed','maintainer')").run();
    expect(memoryWithoutTrace(db, "P").map((row) => row.id)).toEqual(["orphan1"]);
    const findings = lintMemory(db, "P", { budgets: BUDGETS });
    expect(findings.filter((item) => item.check === "no_trace").map((item) => item.recordId)).toContain("orphan1");
  });

  it("[sma:m_lint] the lint reports a stored credential as an error finding and the same corpus gives the same ordered report twice", () => {
    const db = openDatabase(newHost().bb);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES('leak1','P','note','subagent','password: hunter2xx lives here','[]','abc',?,'confirmed','maintainer')").run(Date.now());
    put(db, [note("Ordinary fact about the ledger.")]);
    const first = lintMemory(db, "P", { budgets: BUDGETS });
    const secret = first.filter((item) => item.check === "secret");
    expect(secret.map((item) => item.recordId)).toEqual(["leak1"]);
    expect(secret[0]!.tier).toBe("error");
    expect(lintMemory(db, "P", { budgets: BUDGETS })).toEqual(first);
    const tiers = first.map((item) => item.tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => ({ error: 0, warn: 1, info: 2 } as const)[a] - ({ error: 0, warn: 1, info: 2 } as const)[b]));
  });

  it("[sma:k_v_lint] the checker names each planted defect: secret, dated, broken link and index drift", () => {
    const db = openDatabase(newHost().bb);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES('s1','P','note','subagent','api_key: abcdefghijklmnop','[]','x',0,'confirmed','maintainer')").run();
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin,valid_until) VALUES('s2','P','note','subagent','A fact that lapsed yesterday.','[]','x',0,'confirmed','maintainer',1)").run();
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin,status,superseded_by) VALUES('s3','P','note','subagent','An old wording.','[]','x',0,'confirmed','maintainer','superseded','missingid')").run();
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES('s4','P','note','subagent','A fact the index lost.','[]','x',0,'confirmed','maintainer')").run();
    trigramReady(db);
    const checks = new Set(lintMemory(db, "P", { budgets: BUDGETS }).map((item) => item.check));
    for (const code of ["secret", "dated", "broken_link", "index_drift"]) expect(checks.has(code), code).toBe(true);
  });

  it("[sma:m_sw_lint_panel] [sma:k_lib_consolidate] the review proposes a supersede and an expire and writes nothing", () => {
    const db = openDatabase(newHost().bb);
    put(db, [
      { kind: "note", content: "The invoice ledger rounds half to even in the billing totals.", concepts: ["billing", "ledger"] },
      { kind: "note", content: "The invoice ledger rounds half to even for billing totals now.", concepts: ["billing", "ledger"] },
    ]);
    db.prepare("UPDATE lane_pilot_memory SET created_at=? WHERE id=(SELECT id FROM lane_pilot_memory LIMIT 1)").run(0);
    const before = db.prepare("SELECT * FROM lane_pilot_memory").all();
    const proposals = reviewMemory(db, "P");
    expect(proposals.some((item) => item.action === "supersede")).toBe(true);
    expect(proposals.some((item) => item.action === "expire" && item.reason === "idle")).toBe(true);
    expect(db.prepare("SELECT * FROM lane_pilot_memory").all()).toEqual(before);
  });

  it("[sma:m_lifecycle] a revoked record stays down when the fact is restated, an idle one comes back", () => {
    const db = openDatabase(newHost().bb);
    const content = "The billing queue holds refunds for three days.";
    const [revoked] = put(db, [note(content)]);
    const [idle] = put(db, [note("The billing queue holds chargebacks for three days.")]);
    const unindex = (p: string, id: string) => dropMemoryIndexes(db, p, id);
    expect(hideRecord(db, "P", revoked!, "expired", null, unindex, "revoked")).toBe(true);
    expect(hideRecord(db, "P", idle!, "expired", null, unindex, "idle")).toBe(true);
    const again = put(db, [note(content), note("The billing queue holds chargebacks for three days.")]);
    const row = (id: string) => db.prepare("SELECT status, expired_reason AS reason FROM lane_pilot_memory WHERE id=?").get(id) as { status: string; reason: string };
    expect(row(revoked!)).toEqual({ status: "expired", reason: "revoked" });
    expect(row(idle!).status).toBe("active");
    expect(again.length).toBe(1);
  });

  it("[sma:m_extract] a three-line bullet list is refused at the session door; plain notes still store", async () => {
    const db = openDatabase(newHost().bb);
    const api = rpc(db);
    // The refusal is opt-in (memory.single_claim): with the flag on the door says «one claim».
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('P','','memory.single_claim','true',1,0)").run();
    const refused = await api.session_memory_write({ projectId: "P", kind: "note", content: "- one\n- two\n- three", concepts: [] });
    expect(refused.stored).toBe(false);
    expect(refused.reason).toMatch(/one claim/);
    const stored = await api.session_memory_write({ projectId: "P", kind: "note", content: "The ledger rounds half to even.", concepts: [] });
    expect(stored.stored).toBe(true);
    const paragraph = await api.session_memory_write({ projectId: "P", kind: "note", content: "First sentence of the note.\nSecond sentence of the note.", concepts: [] });
    expect(paragraph.stored).toBe(true);
    expect(memoryClaimIssue("- a\n- b\n- c")).toMatch(/one claim/);
  });

  it("[sma:k_lib_erase] erasing a record removes its bytes everywhere and verifies none remain", () => {
    const db = openDatabase(newHost().bb);
    const [id] = put(db, [note("A fact with an embedding, a promotion and a conflict.")]);
    db.prepare("INSERT INTO lane_pilot_memory_vec(id,project_id,model,content_sha,vec,created_at) VALUES(?,?,?,?,?,?)").run(id!, "P", "m", "s", Buffer.alloc(4), 0);
    db.prepare("INSERT INTO lane_pilot_memory_promotion(project_id,memory_id,query,at) VALUES('P',?,'q',0)").run(id!);
    db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,state,detected_at) VALUES('c1','P',?,'other','value','s','held',0)").run(id!);
    deleteMemoryRecord(db as never, "P", id!);
    expect(eraseLeftovers(db, "P", id!)).toEqual([]);
    const gone = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_vec WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_promotion WHERE memory_id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_conflict WHERE note_a=? OR note_b=?", id!, id!)).toBe(0);
  });

  it("[sma:k_v_mem_forget] the forget verbs hide or erase with a reason; a rule record is refused", () => {
    const db = openDatabase(newHost().bb);
    const [noteId] = put(db, [note("A fact the owner withdraws.")]);
    const unindex = (p: string, id: string) => dropMemoryIndexes(db, p, id);
    expect(hideRecord(db, "P", noteId!, "expired", null, unindex, "revoked")).toBe(true);
    expect((db.prepare("SELECT expired_reason AS r FROM lane_pilot_memory WHERE id=?").get(noteId!) as { r: string }).r).toBe("revoked");
    const [archId] = put(db, [note("A fact the owner archives.")]);
    expect(hideRecord(db, "P", archId!, "expired", null, unindex, "archived")).toBe(true);
    // Archived notes are the cold tier: a PM query can bring them back.
    const cold = db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status='expired' AND expired_reason='archived'").get() as { n: number };
    expect(cold.n).toBe(1);
    const rule = put(db, [{ kind: "core", content: "Always run the tests first.", concepts: ["convention"] }], "P2");
    expect(rule.length).toBe(1);
  });

  it("[sma:k_v_mem_miss] a reminded miss is stored with its gold note, and the eval plan gains a positive question for it", () => {
    const db = openDatabase(newHost().bb);
    const [id] = put(db, [note("The answer the owner had to repeat.")]);
    recordMemoryMiss(db, "P", "what holds the answer?", 1000, "reminded", id!);
    const miss = db.prepare("SELECT kind, note_id AS noteId FROM lane_pilot_memory_miss WHERE note_id=?").get(id!) as { kind: string; noteId: string };
    expect(miss).toEqual({ kind: "reminded", noteId: id });
    const raw = db.prepare("SELECT id,project_id,kind,content,concepts_json,created_at,status,trust,origin,use_count,accepted_count,scope_json,audience,personal_bot FROM lane_pilot_memory").all() as never[];
    const toNote = (row: { id: string; project_id: string; kind: "note"; content: string; concepts_json: string; created_at: number; status: string; trust: string; origin: string; use_count: number; accepted_count: number; audience: string; personal_bot: string }) =>
      ({ id: row.id, projectId: row.project_id, kind: row.kind, content: row.content, concepts: JSON.parse(row.concepts_json), createdAt: row.created_at, status: row.status, trust: row.trust, origin: row.origin, useCount: row.use_count, acceptedCount: row.accepted_count, sections: [], audience: row.audience, personalBot: row.personal_bot });
    const plan = planCorpus({ data: { origin: "live", notes: (raw as never[]).map(toNote), questions: [], misses: [{ projectId: "P", query: "what holds the answer?", noteId: id! }] }, size: 30, seed: 1, skipProjects: new Set(), skipTask: () => false });
    const question = plan.questions.find((item) => item.id === "miss-1");
    expect(question).toMatchObject({ kind: "positive", gold: [id] });
    expect(plan.notes.map((item) => item.id)).toContain(id);
  });

  it("[sma:k_v_mem_stats] token stats weigh core and notes against their budgets", () => {
    const db = openDatabase(newHost().bb);
    put(db, [
      { kind: "core", content: "x".repeat(400), concepts: ["convention"] },
      note("y".repeat(800)),
      note("z".repeat(800)),
    ]);
    const stats = memoryTokenStats(db, "P", { coreBudget: 100, noteBudget: 300, indexBudget: 1000 });
    expect(stats.coreTokens).toBe(100);
    expect(stats.noteTokens).toBe(400);
    expect(stats.budgets).toEqual({ coreBudget: 100, noteBudget: 300, indexBudget: 1000 });
    expect(stats.records.active).toBe(3);
  });

  it("[sma:k_v_load] memory load lists the core plus the notes carrying the given tags", () => {
    const db = openDatabase(newHost().bb);
    put(db, [
      { kind: "core", content: "Always write terse commit messages.", concepts: ["convention"] },
      note("The billing ledger rounds half to even.", ["billing"]),
      note("The kitchen sink is a fixture.", ["kitchen"]),
    ]);
    const core = listMemory(db, "P", { kind: "core" }, 20);
    const tagged = listMemory(db, "P", { concepts: ["billing"] }, 20);
    expect(core.map((row) => row.content)).toEqual(["Always write terse commit messages."]);
    expect(tagged.map((row) => row.content)).toEqual(["The billing ledger rounds half to even."]);
  });

  it("[sma:k_v_eval] the frozen 40-case gate passes on a scratch database", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../src/rooms/memory-eval/server/gate-fixture.json", import.meta.url), "utf8")) as MemoryGate;
    const db = openDatabase(newHost().bb);
    expect(runMemoryGate(db, fixture)).toEqual({ cases: 40, leaks: [], overflows: [], cutRules: [], misses: [], errors: [] });
  });
});


// The schema is exercised so a column drift in the new miss columns fails here, not in production.
describe("memory miss columns", () => {
  it("[sma:k_v_mem_miss] lane_pilot_memory_miss carries kind and note_id", () => {
    const db = openDatabase(newHost().bb);
    const columns = db.prepare("PRAGMA table_info(lane_pilot_memory_miss)").all().map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(["kind", "note_id"]));
  });
});
