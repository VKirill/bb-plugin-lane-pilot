import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import {
  addToIndexes, deleteMemoryRecord, dropMemoryIndexes, eraseLeftovers, hideRecord, lintMemory, listMemory,
  memoryClaimIssue, memoryIndexStatus, memoryTokenStats, memoryWithoutTrace, rebuildMemoryIndexes,
  recordMemoryMiss, reviewMemory, searchMemoryRecords, storeMemoryRecords, trigramReady, parseMemorySettings,
} from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import { createMemoryConflicts } from "../../src/rooms/memory/server/memory-conflicts";
import { dropPackedLists, maintainerMemorySettings } from "../../src/rooms/memory/server/memory-settings";
import { mixWriterMemory } from "../../src/rooms/memory/server/memory-mix";
import { writerMemoryPicks } from "../../src/rooms/memory/server/memory-picks";
import { insightsRpc } from "../../src/rooms/self-repair/server/rpc/insights";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createRun } from "../../src/rooms/storage";
import { runMemoryEvalCommand } from "../../src/rooms/memory-eval/server/command";
import gateFixture from "../../src/rooms/memory-eval/server/gate-fixture.json";
import { runMemoryGate, type MemoryGate } from "../../src/rooms/memory-eval/server/gate";
import { planCorpus } from "../../src/rooms/memory-eval/server/corpus";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";

const newHost = () => createFakePluginHost({ pluginId: "lane-pilot" });
const BUDGETS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
const put = (db: MemoryDatabase, entries: MemoryCandidate[], projectId = "P") =>
  storeMemoryRecords(db, { projectId, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries, nearDuplicates: false, ...BUDGETS }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });

function rpc(db: MemoryDatabase) {
  return sessionMemoryRpc({ db, bb: newHost().bb, log: () => {}, isDisposed: () => false } as unknown as ServerCore,
    { insights: {}, docsPlaces: async () => [], memoryConflicts: { detect: () => {}, sweepMoot: () => {} }, wallThreadReader: {} } as unknown as Services);
}


type ThreadSpec = { projectId: string; role?: string };
/** The real `bb lane-pilot memory …` CLI on a scratch database; `threads` says who a calling thread id is (project and plugin role). */
function cliHarness(threads: Record<string, ThreadSpec> = {}) {
  const host = newHost();
  const db = openDatabase(host.bb);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId]!.projectId } : null);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threads[threadId]?.role ? { role: threads[threadId]!.role } : null);
  const closed: Array<{ id: string; evidence: string }> = [];
  const memoryConflicts = createMemoryConflicts({ db, deferrals: () => ({ close: (input) => { closed.push(input); } }) });
  registerCli(createCore(host.bb, db), { memoryConflicts } as unknown as Services, migrations);
  const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(["memory", ...argv], threadId ? { threadId } : {});
  return { host, db, run, closed };
}
const row = (db: MemoryDatabase, id: string) => db.prepare("SELECT status, expired_reason AS reason FROM lane_pilot_memory WHERE id=?").get(id) as { status: string; reason: string | null } | undefined;
const unindexer = (db: MemoryDatabase) => (p: string, id: string) => dropMemoryIndexes(db, p, id);
const fileNote = (content: string, sourceFileId = "file1"): MemoryCandidate => ({ kind: "note", content, concepts: ["area"], sourceFileId });

describe("memory corpus care (parity wave d7)", () => {
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


  it("[sma:d_mem_index] the cockpit action «index» rebuilds a lost search entry and says how many records it rebuilt", async () => {
    const host = newHost();
    const db = openDatabase(host.bb);
    createRun(db, "run1", "P");
    const [id] = put(db, [note("The ledger rounds half to even before storing the invoice total.")]);
    dropMemoryIndexes(db, "P", id!);
    expect(searchMemoryRecords(db, "P", "ledger rounds", 10, "auto").map((item) => item.id)).not.toContain(id);
    const cockpit = cockpitRpc({ db, bb: host.bb } as never, {} as never) as unknown as Record<string, (input: unknown) => Promise<{ exitCode: number; output: string }>>;
    const answer = await cockpit.cockpit_memory!({ runId: "run1", action: "index" });
    expect(answer.exitCode).toBe(0);
    expect(answer.output).toMatch(/Перестроено записей: 1 \(добавлено 1/);
    expect(searchMemoryRecords(db, "P", "ledger rounds", 10, "auto").map((item) => item.id)).toContain(id);
  });

  it("[sma:d_mem_lint] the cockpit lint counts records with no trace on the whole project (not the first 80), and an owner or voucher-carrying record is not one", async () => {
    const host = newHost();
    const db = openDatabase(host.bb);
    createRun(db, "run1", "P");
    // 85 ordinary records carry a voucher (every stored record does), even though none has a task: the older-install shape.
    put(db, Array.from({ length: 85 }, (_, n) => note(`Ordinary fact number ${n} about the ledger and its rounding rules.`)));
    const plant = (id: string, origin: string) => db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES(?,'P','note','subagent',?,'[]','',0,'confirmed',?)").run(id, `A fact nobody can trace (${id}).`, origin);
    plant("orphan1", "maintainer"); plant("orphan2", "maintainer"); plant("owner1", "owner");
    expect(memoryWithoutTrace(db, "P").map((item) => item.id).sort()).toEqual(["orphan1", "orphan2"]);
    const cockpit = cockpitRpc({ db, bb: host.bb } as never, {} as never) as unknown as Record<string, (input: unknown) => Promise<{ exitCode: number; output: string }>>;
    const answer = await cockpit.cockpit_memory!({ runId: "run1", action: "lint" });
    expect(answer.output).toContain("Без следа в работе: 2 из 88");
  });

  it("[sma:m_lint] no_trace is a warning that names exactly the records memoryWithoutTrace names, and `memory lint` still exits 0 on it", async () => {
    const h = cliHarness();
    put(h.db, [note("A fact with a voucher but no task, as an older install holds.")]);
    const [orphan] = put(h.db, [note("A fact nobody can trace.")]);
    h.db.prepare("UPDATE lane_pilot_memory SET verification_json='[]' WHERE id=?").run(orphan!);
    const findings = lintMemory(h.db, "P", { budgets: BUDGETS }).filter((item) => item.check === "no_trace");
    expect(findings.map((item) => item.recordId)).toEqual(memoryWithoutTrace(h.db, "P").map((item) => item.id));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.tier).toBe("warn");
    const out = await h.run(["lint", "--project", "P"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("[warn] no_trace");
    // A real error still fails the command.
    h.db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES('leak1','P','note','subagent','password: hunter2xx lives here','[]','abc',0,'confirmed','maintainer')").run();
    expect((await h.run(["lint", "--project", "P"])).exitCode).toBe(1);
  });

  it("[sma:m_sw_lint_panel] the records list marks «no trace» by the one definition: an old maintainer record with a voucher and an owner record are not marked", async () => {
    const host = newHost();
    const db = openDatabase(host.bb);
    const [vouched] = put(db, [note("An older maintainer record: no task id, but a verification entry.")]);
    db.prepare("UPDATE lane_pilot_memory SET origin_task_id=NULL, origin='maintainer' WHERE id=?").run(vouched!);
    const plant = (id: string, origin: string) => db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES(?,'P','note','subagent',?,'[]','',?,'confirmed',?)").run(id, `Planted ${id}.`, Date.now(), origin);
    plant("orphan1", "maintainer"); plant("owner1", "owner");
    const rpcApi = insightsRpc({ db, bb: host.bb, log: () => {} } as never, { ruleScan: {}, memoryConflicts: { eraseRecord: () => [] } } as never) as unknown as Record<string, (input: unknown) => Promise<{ records: Array<{ id: string; noTrace: boolean }> }>>;
    const listed = (await rpcApi.memory_records_list!({ projectId: "P" })).records;
    expect(Object.fromEntries(listed.map((item) => [item.id, item.noTrace]))).toEqual({ [vouched!]: false, orphan1: true, owner1: false });
  });

  it("[sma:k_lib_consolidate] the review proposes a supersede and an expire and writes nothing", () => {
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

  it("[sma:m_lifecycle] a revoked record stays down on every path (restated, or re-imported from the same file); archived stays in the cold tier; an idle one still comes back", () => {
    const db = openDatabase(newHost().bb);
    const unindex = unindexer(db);
    const content = "The billing queue holds refunds for three days.";
    const [revoked] = put(db, [note(content)]);
    const [idle] = put(db, [note("The billing queue holds chargebacks for three days.")]);
    expect(hideRecord(db, "P", revoked!, "expired", null, unindex, "revoked")).toBe(true);
    expect(hideRecord(db, "P", idle!, "expired", null, unindex, "idle")).toBe(true);
    const again = put(db, [note(content), note("The billing queue holds chargebacks for three days.")]);
    expect(row(db, revoked!)).toEqual({ status: "expired", reason: "revoked" });
    expect(row(db, idle!)?.status).toBe("active");
    expect(again.length).toBe(1);

    // The same-file branch: a file record the owner withdrew is not brought back by importing the file again; an idle one is.
    const [fromFile, fromFileIdle, fromFileArchived] = put(db, [fileNote("The nightly export lives in the exports folder."), fileNote("The weekly digest goes out on Monday morning."), fileNote("The yearly audit trail is kept for seven years.")]);
    hideRecord(db, "P", fromFile!, "expired", null, unindex, "revoked");
    hideRecord(db, "P", fromFileIdle!, "expired", null, unindex, "idle");
    hideRecord(db, "P", fromFileArchived!, "expired", null, unindex, "archived");
    const reimported = put(db, [fileNote("The nightly export lives in the exports folder."), fileNote("The weekly digest goes out on Monday morning."), fileNote("The yearly audit trail is kept for seven years.")]);
    expect(reimported).toEqual([fromFileIdle]);
    expect(row(db, fromFile!)).toEqual({ status: "expired", reason: "revoked" });
    expect(row(db, fromFileArchived!)).toEqual({ status: "expired", reason: "archived" });
    expect(row(db, fromFileIdle!)?.status).toBe("active");
    // Neither a revoked nor an archived record is served again by search; the archived one remains reachable as the cold tier.
    expect(searchMemoryRecords(db, "P", "nightly export exports folder", 10, "auto").map((item) => item.id)).not.toContain(fromFile);
  });

  it("[sma:m_extract] memory.single_claim is on when unset on the maintainer path too; a stored off keeps a packed list", () => {
    const entries = [{ content: "- one\n- two\n- three" }, { content: "The ledger rounds half to even." }];
    // Unset: on, the list goes, the plain note stays, and the count is reported (the stage's listDropped).
    expect(maintainerMemorySettings({}).singleClaim).toBe(true);
    expect(dropPackedLists(entries, maintainerMemorySettings({}))).toEqual({ kept: [entries[1]], dropped: 1 });
    expect(parseMemorySettings({}).singleClaim).toBe(true);
    // Explicit off: the old path, nothing is dropped.
    const off = maintainerMemorySettings({ "memory.single_claim": "off" });
    expect(off.singleClaim).toBe(false);
    expect(dropPackedLists(entries, off)).toEqual({ kept: entries, dropped: 0 });
    expect(maintainerMemorySettings({ "memory.single_claim": true }).singleClaim).toBe(true);
  });

  it("[sma:m_extract] a three-line bullet list is refused at the session door unless memory.single_claim is stored off; plain notes still store", async () => {
    const db = openDatabase(newHost().bb);
    const api = rpc(db);
    // Unset: on, the list is refused.
    const unset = await api.session_memory_write({ projectId: "P", kind: "note", content: "- one\n- two\n- three", concepts: [] });
    expect(unset.stored).toBe(false);
    // Stored off: the old path, the list is stored.
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('P','','memory.single_claim','off',1,0)").run();
    const offStored = await api.session_memory_write({ projectId: "P", kind: "note", content: "- seven\n- eight\n- nine", concepts: [] });
    expect(offStored.stored).toBe(true);
    db.prepare("UPDATE lane_pilot_project_settings SET value='true', version=2 WHERE project_id='P' AND key='memory.single_claim'").run();
    const refused = await api.session_memory_write({ projectId: "P", kind: "note", content: "- four\n- five\n- six", concepts: [] });
    expect(refused.stored).toBe(false);
    expect(refused.reason).toMatch(/one claim/);
    const stored = await api.session_memory_write({ projectId: "P", kind: "note", content: "The ledger rounds half to even.", concepts: [] });
    expect(stored.stored).toBe(true);
    const paragraph = await api.session_memory_write({ projectId: "P", kind: "note", content: "First sentence of the note.\nSecond sentence of the note.", concepts: [] });
    expect(paragraph.stored).toBe(true);
    expect(memoryClaimIssue("- a\n- b\n- c")).toMatch(/one claim/);
  });

  it("[sma:k_v_mem_forget] the owner at a terminal: revoke, archive, expire and replace hide with a reason, erase needs --yes, a rule record is refused", async () => {
    const h = cliHarness();
    const [revoke, archive, expire, replaced, keeper, erased] = put(h.db, ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((word) => note(`${word} is a distinct fact about the billing ledger rounding.`, [word.toLowerCase()])));
    const forget = (...argv: string[]) => h.run(["forget", ...argv, "--project", "P"]);
    expect((await forget(revoke!, "--revoke")).exitCode).toBe(0);
    expect((await forget(archive!, "--archive")).exitCode).toBe(0);
    expect((await forget(expire!, "--expire")).exitCode).toBe(0);
    expect((await forget(replaced!, "--replace", keeper!)).exitCode).toBe(0);
    expect(row(h.db, revoke!)).toEqual({ status: "expired", reason: "revoked" });
    expect(row(h.db, archive!)).toEqual({ status: "expired", reason: "archived" });
    expect(row(h.db, expire!)).toEqual({ status: "expired", reason: "owner" });
    expect(row(h.db, replaced!)?.status).toBe("superseded");
    expect(row(h.db, keeper!)?.status).toBe("active");
    // Nothing picked, nothing done.
    expect((await forget(keeper!)).stderr).toMatch(/pick one/);
    // Erase is refused without --yes and the record is still there; with --yes the bytes are gone everywhere.
    const noYes = await forget(erased!, "--erase");
    expect(noYes.exitCode).toBe(1);
    expect(noYes.stderr).toMatch(/--yes/);
    expect(row(h.db, erased!)?.status).toBe("active");
    const done = await forget(erased!, "--erase", "--yes");
    expect(done.exitCode).toBe(0);
    expect(row(h.db, erased!)).toBeUndefined();
    expect(eraseLeftovers(h.db, "P", erased!)).toEqual([]);
    // A rule record is removed with its rule, never through this verb.
    storeMemoryRecords(h.db, { projectId: "P", sourceSha256: "b".repeat(64), audience: "subagent", origin: "rule", entries: [{ kind: "core", content: "Always run the tests first.", concepts: ["rule", "owner-confirmed"] }], ...BUDGETS });
    const ruleId = (h.db.prepare("SELECT id FROM lane_pilot_memory WHERE concepts_json LIKE '%\"rule\"%'").get() as { id: string }).id;
    for (const flags of [["--revoke"], ["--erase", "--yes"]]) {
      const refused = await forget(ruleId, ...flags);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/rule/);
    }
    expect(row(h.db, ruleId)?.status).toBe("active");
    // And a revoked record stays revoked when its fact is stored again.
    expect(put(h.db, [note("Alpha is a distinct fact about the billing ledger rounding.", ["alpha"])])).toEqual([]);
    expect(row(h.db, revoke!)).toEqual({ status: "expired", reason: "revoked" });
  });

  it("[sma:k_v_mem_forget] a thread is an agent: no thread erases, only the PM chat hides and only in its own project, the refusal names the reason", async () => {
    const h = cliHarness({
      thr_writer: { projectId: "P", role: "writer" }, thr_helper: { projectId: "P", role: "pm-reader" }, thr_blank: { projectId: "P" },
      thr_pm: { projectId: "P", role: "pm" }, thr_other: { projectId: "Q", role: "pm" },
    });
    const [one, two] = put(h.db, ["Alpha", "Beta"].map((word) => note(`${word} is a distinct fact about the billing ledger rounding.`, [word.toLowerCase()])));
    const [foreign] = put(h.db, [note("Kappa is a fact of another project entirely.")], "Q");
    // Erase: refused for every thread, the PM chat included; the record is untouched.
    for (const threadId of ["thr_writer", "thr_helper", "thr_blank", "thr_pm"]) {
      const out = await h.run(["forget", one!, "--erase", "--yes"], threadId);
      expect(out.exitCode, threadId).toBe(1);
      expect(out.stderr, threadId).toMatch(/refused: --erase is irreversible/);
      expect(row(h.db, one!)?.status).toBe("active");
    }
    // A writer, a helper and a thread of unknown role hide nothing either: a revoked fact would never come back by itself.
    for (const threadId of ["thr_writer", "thr_helper", "thr_blank"]) {
      for (const flag of ["--revoke", "--archive"]) {
        const out = await h.run(["forget", one!, flag], threadId);
        expect(out.exitCode, threadId).toBe(1);
        expect(out.stderr, threadId).toMatch(/refused: memory forget is not for a/);
      }
    }
    expect((await h.run(["forget", one!, "--revoke"], "thr_writer")).stderr).toMatch(/writer thread/);
    expect(row(h.db, one!)?.status).toBe("active");
    // Another project: refused for every action, the PM chat included.
    for (const flags of [["--revoke"], ["--archive"], ["--erase", "--yes"]]) {
      const out = await h.run(["forget", foreign!, ...flags, "--project", "Q"], "thr_pm");
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toMatch(/only that thread's own project \(P\), not Q/);
    }
    expect(row(h.db, foreign!)?.status).toBe("active");
    // The PM chat hides a record of its own project (the project comes from the thread).
    expect((await h.run(["forget", foreign!, "--revoke"], "thr_other")).exitCode).toBe(0);
    expect(row(h.db, foreign!)).toEqual({ status: "expired", reason: "revoked" });
    expect((await h.run(["forget", two!, "--archive"], "thr_pm")).exitCode).toBe(0);
    expect(row(h.db, two!)?.status).toBe("expired");
  });

  it("[sma:k_lib_erase] erasing a record removes its bytes everywhere, restores secure_delete, and verifies none remain", () => {
    const db = openDatabase(newHost().bb);
    const [id] = put(db, [note("A fact with an embedding, a promotion and a conflict.")]);
    db.prepare("INSERT INTO lane_pilot_memory_vec(id,project_id,model,content_sha,vec,created_at) VALUES(?,?,?,?,?,?)").run(id!, "P", "m", "s", Buffer.alloc(4), 0);
    db.prepare("INSERT INTO lane_pilot_memory_promotion(project_id,memory_id,query,at) VALUES('P',?,'q',0)").run(id!);
    db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,state,detected_at) VALUES('c1','P',?,'other','value','s','held',0)").run(id!);
    db.prepare("PRAGMA secure_delete=0").get();
    deleteMemoryRecord(db as never, "P", id!);
    expect((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(0);
    expect(eraseLeftovers(db, "P", id!)).toEqual([]);
    const gone = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_vec WHERE id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_promotion WHERE memory_id=?", id!)).toBe(0);
    expect(gone("SELECT count(*) AS n FROM lane_pilot_memory_conflict WHERE note_a=? OR note_b=?", id!, id!)).toBe(0);
    // A connection that had secure_delete on keeps it on.
    const [other] = put(db, [note("Another fact to erase.")]);
    db.prepare("PRAGMA secure_delete=1").get();
    deleteMemoryRecord(db as never, "P", other!);
    expect((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(1);
  });

  it("[sma:k_lib_erase] erasing one note of a held conflict pair closes the deferral it opened, deletes the pair, and frees the surviving note", async () => {
    const h = cliHarness();
    const [a, b] = put(h.db, [note("The retry limit is three attempts per job.", ["retry"]), note("The retry limit is five attempts per job.", ["retry"])]);
    h.db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,state,deferral_id,detected_at) VALUES('c1','P',?,?,'value','retry limit','held','dfr_1',0)").run(a!, b!);
    // While the pair is held neither note is served.
    expect(listMemory(h.db, "P", {}, 20).map((item) => item.id)).toEqual([]);
    const out = await h.run(["forget", a!, "--erase", "--yes", "--project", "P"]);
    expect(out.exitCode).toBe(0);
    expect(h.closed).toEqual([{ id: "dfr_1", evidence: expect.stringContaining("erased") }]);
    expect(h.db.prepare("SELECT count(*) AS n FROM lane_pilot_memory_conflict").get()).toEqual({ n: 0 });
    expect(eraseLeftovers(h.db, "P", a!)).toEqual([]);
    expect(listMemory(h.db, "P", {}, 20).map((item) => item.id)).toEqual([b]);
    expect(lintMemory(h.db, "P", { budgets: BUDGETS }).filter((item) => item.check === "broken_link")).toEqual([]);
  });

  it("[sma:k_lib_erase] the records tab's delete returns deleted:true with a separate leftovers list, and a rule is refused", async () => {
    const host = newHost();
    const db = openDatabase(host.bb);
    const [id] = put(db, [note("A fact the owner removes from the records tab.")]);
    storeMemoryRecords(db, { projectId: "P", sourceSha256: "b".repeat(64), audience: "subagent", origin: "rule", entries: [{ kind: "core", content: "Always run the tests first.", concepts: ["rule", "owner-confirmed"] }], ...BUDGETS });
    const ruleId = (db.prepare("SELECT id FROM lane_pilot_memory WHERE concepts_json LIKE '%\"rule\"%'").get() as { id: string }).id;
    const conflicts = createMemoryConflicts({ db, deferrals: () => ({ close: () => {} }) });
    const api = (eraser: (projectId: string, id: string) => string[]) => insightsRpc({ db, bb: host.bb, log: () => {} } as never, { ruleScan: {}, memoryConflicts: { eraseRecord: eraser } } as never) as unknown as Record<string, (input: unknown) => Promise<{ deleted: boolean; reason: string | null; leftovers: string[] }>>;
    expect(await api((p, r) => conflicts.eraseRecord(p, r)).memory_record_delete!({ projectId: "P", id: id! })).toEqual({ deleted: true, reason: null, leftovers: [] });
    expect(row(db, id!)).toBeUndefined();
    // The record was deleted but something still holds it: still deleted:true, and the leftovers say where.
    expect(await api(() => ["lane_pilot_memory_vec"]).memory_record_delete!({ projectId: "P", id: "missing-id-for-this" })).toEqual({ deleted: false, reason: "not_found", leftovers: [] });
    const [second] = put(db, [note("A second fact with a stubborn embedding.")]);
    expect(await api(() => ["lane_pilot_memory_vec"]).memory_record_delete!({ projectId: "P", id: second! })).toEqual({ deleted: true, reason: "leftovers: lane_pilot_memory_vec", leftovers: ["lane_pilot_memory_vec"] });
    expect(await api((p, r) => conflicts.eraseRecord(p, r)).memory_record_delete!({ projectId: "P", id: ruleId })).toEqual({ deleted: false, reason: "rule", leftovers: [] });
    expect(row(db, ruleId)?.status).toBe("active");
  });

  it("[sma:k_v_mem_miss] `memory miss \"<q>\" --note <id>` stores a reminded miss with its gold note; an unknown note is refused", async () => {
    const h = cliHarness();
    const [id] = put(h.db, [note("The answer the owner had to repeat.")]);
    const refused = await h.run(["miss", "what holds the answer?", "--note", "nope", "--project", "P"]);
    expect(refused.exitCode).toBe(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM lane_pilot_memory_miss").get()).toEqual({ n: 0 });
    const ok = await h.run(["miss", "what holds the answer?", "--note", id!, "--project", "P"]);
    expect(ok.exitCode).toBe(0);
    expect(h.db.prepare("SELECT query, kind, note_id AS noteId FROM lane_pilot_memory_miss").all()).toEqual([{ query: "what holds the answer?", kind: "reminded", noteId: id }]);
  });

  it("[sma:k_v_load] with memory.tag_notes unset (on) a note carrying a tag of the task joins between path notes and core", () => {
    const db = openDatabase(newHost().bb);
    put(db, [
      { kind: "note", content: "Refunds are held for three days before they are paid out.", concepts: ["billing"] },
      { kind: "note", content: "The kitchen display refreshes every ten seconds.", concepts: ["kitchen"] },
    ]);
    const task = { owns_paths: ["src/billing/ledger.ts"], read_first: [], area: "billing", kind: "feature" as const };
    const base = { projectId: "P", query: "zzzz unrelated words", task, searchEngine: "auto" as const, personalBot: "", ruleMemoryIds: new Set<string>() };
    const unset = mixWriterMemory(db as never, base);
    expect(unset.text).toContain("Refunds are held for three days");
    const off = mixWriterMemory(db as never, { ...base, tagNotes: false });
    expect(off.text).toBe("");
    expect(off.ids).toEqual([]);
    expect(parseMemorySettings({}).tagNotes).toBe(true);
    expect(parseMemorySettings({ "memory.tag_notes": "off" }).tagNotes).toBe(false);
    const on = mixWriterMemory(db as never, { ...base, tagNotes: true });
    expect(on.text).toContain("Refunds are held for three days");
    expect(on.text).not.toContain("kitchen display");
    // The picks function itself: tags move a tagged note ahead of core, and no tags means no tier.
    const notes = [
      { id: "core1", kind: "core" as const, content: "A convention for everybody.", concepts: ["convention"] },
      { id: "tag1", kind: "note" as const, content: "A note about billing.", concepts: ["billing"] },
    ];
    expect(writerMemoryPicks(notes as never, task).map((item) => item.id)).toEqual(["core1"]);
    expect(writerMemoryPicks(notes as never, task, ["billing"]).map((item) => item.id)).toEqual(["tag1", "core1"]);
  });

  it("[sma:k_v_load] a task with no tag in the project's cloud gets no tagged notes, and a core record never comes in by its tag", () => {
    const db = openDatabase(newHost().bb);
    put(db, [
      { kind: "note", content: "The kitchen display refreshes every ten seconds.", concepts: ["kitchen"] },
      { kind: "core", content: "A rule text of another section about billing.", concepts: ["billing"] },
      { kind: "note", content: "Refunds are held for three days before they are paid out.", concepts: ["billing"] },
    ]);
    const base = { projectId: "P", query: "zzzz unrelated words", searchEngine: "auto" as const, personalBot: "", ruleMemoryIds: new Set<string>() };
    // No tag of this task is in the cloud: an empty tag list must not read as "no filter" and list the shelf.
    const untagged = mixWriterMemory(db as never, { ...base, task: { owns_paths: ["lib/other.ts"], read_first: [] } });
    expect(untagged.text).toBe("");
    expect(untagged.ids).toEqual([]);
    const tagged = mixWriterMemory(db as never, { ...base, task: { owns_paths: ["lib/other.ts"], read_first: [], area: "billing" } });
    expect(tagged.text).toContain("Refunds are held for three days");
    expect(tagged.text).not.toContain("rule text of another section");
    expect(tagged.text).not.toContain("kitchen display");
  });

  it("[sma:k_v_load] `memory load --tags` lists the core plus the notes carrying the given tags", async () => {
    const h = cliHarness();
    put(h.db, [
      { kind: "core", content: "Always write terse commit messages.", concepts: ["convention"] },
      note("The billing ledger rounds half to even.", ["billing"]),
      note("The kitchen sink is a fixture.", ["kitchen"]),
    ]);
    const out = await h.run(["load", "--tags", "billing", "--project", "P"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Always write terse commit messages.");
    expect(out.stdout).toContain("The billing ledger rounds half to even.");
    expect(out.stdout).not.toContain("kitchen sink");
  });

  it("[sma:k_v_eval] `memory-eval --gate` runs the bundled 40-case gate on a scratch database and exits 0; `--north-star` appends the cost per verified result", async () => {
    // The fixture is a static import of the command (the plugin ships as one bundle), so nothing is read from disk next to it.
    expect((gateFixture as { cases?: unknown[] }).cases ?? Object.keys(gateFixture)).toBeTruthy();
    const gate = await runMemoryEvalCommand(null, ["--gate"], migrations);
    expect(gate.exitCode).toBe(0);
    expect(gate.stdout).toMatch(/memory gate: 40 cases, 0 leaks, 0 overflows, 0 cut rules, 0 misses, 0 errors/);
    const json = await runMemoryEvalCommand(null, ["--gate", "--json"], migrations);
    expect(JSON.parse(json.stdout!)).toEqual({ cases: 40, leaks: [], overflows: [], cutRules: [], misses: [], errors: [] });
    const db = openDatabase(newHost().bb);
    put(db, [note("The ledger rounds half to even before storing the invoice total."), note("Refunds are held for three days before they are paid out.")]);
    const star = await runMemoryEvalCommand(db, ["--north-star", "--sizes", "30"], migrations, { northStar: () => [{ projectId: "P", tokens: 900, accepted: 3, tokensPerAccepted: 300 }] });
    expect(star.exitCode, star.stderr).toBe(0);
    expect(star.stdout).toContain("cost per verified result");
    expect(star.stdout).toContain("300");
    const plain = await runMemoryEvalCommand(db, ["--sizes", "30"], migrations, { northStar: () => [{ projectId: "P", tokens: 900, accepted: 3, tokensPerAccepted: 300 }] });
    expect(plain.stdout).not.toContain("cost per verified result");
  });
});

