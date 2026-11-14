// Region 14 · Memory, batch b (n1078 … n1107): behaviour tests of the four proofs. Each test writes to a scratch database and reads back what is
// stored and what a later reader gets. Memory lives only on the hub (rows of lane_pilot_memory and its indexes): a card that keeps memory in a
// project file (MEMORY.md, a CLAUDE.md block, .sma/…) is proven on the hub path that serves its purpose, never by a file in a project tree.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCatalogCli } from "../../src/rooms/file-cards/cli";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  coreShelf, explainMemory, listRemindedMisses, memoryContext, memoryStem, parseMemoryCandidates, parseMemorySettings, recordMemoryMiss,
  recordMemoryMixed, reviewMemory, searchMemoryRecords, storeMemoryRecords, storeMemoryRecordsKeepingOverflow, trigramReady,
  type MemoryCandidate, type MemoryDatabase, type MemoryRecord,
} from "../../packages/memory-core/src";
import { audienceForSensitivity, laneMemoryFileToCandidate, parseLaneMemoryFile, renderLaneMemoryFile, sensitivityForAudience } from "../../packages/memory-core/src/files";
import { memoryUsefulness } from "../../packages/memory-core/src/lifecycle";
import { planCorpus } from "../../src/rooms/memory-eval/server/corpus";
import { loadEvalData } from "../../src/rooms/memory-eval/server/source";
import { runMemoryImport } from "../../src/rooms/memory/server/import";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import { writerMemoryPicks } from "../../src/rooms/memory/server/memory-picks";
import { openDatabase } from "../../src/rooms/plugin-db";
import { memoryRecordId } from "../../src/rooms/memory/memory";
import { holdEvents, pmThreadId, projectId, setup, stageReceipt, task, until } from "../stages/server-stage/suite";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";

const BUDGETS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
const DAY = 86_400_000;
const db0 = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const put = (db: MemoryDatabase, entries: MemoryCandidate[], extra: Partial<Parameters<typeof storeMemoryRecords>[1]> = {}) =>
  storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries, nearDuplicates: false, ...BUDGETS, ...extra });
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });
const count = (db: MemoryDatabase, table = "lane_pilot_memory", where = "1=1") => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const rpc = (db: MemoryDatabase) => sessionMemoryRpc({ db, bb: createFakePluginHost({ pluginId: "lane-pilot" }).bb, log: () => {}, isDisposed: () => false } as unknown as ServerCore,
  { insights: {}, docsPlaces: async () => [], memoryConflicts: { detect: () => {}, sweepMoot: () => {} }, wallThreadReader: {} } as unknown as Services);
const record = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({ id, projectId: "p", personalBot: "", kind: "note", content, concepts: ["memory"], sourceSha256: "a".repeat(64), createdAt: 1, ...over });

describe("memory corpus care: the gold set and the terminal verbs (region 14, batch b)", () => {
  it("[sma:k_st_gold] a reminded miss is a gold case: the question the owner had to repeat, tied to the note that held the answer, and an empty miss is not one", () => {
    const db = db0();
    const [id] = put(db, [note("The refund queue drains at noon on weekdays.", ["refund", "queue"])]).insertedIds;
    recordMemoryMiss(db, "P", "when does the refund queue drain?", 1_000, "reminded", id);
    recordMemoryMiss(db, "P", "nobody has an answer to this", 2_000);
    expect(listRemindedMisses(db)).toEqual([{ projectId: "P", query: "when does the refund queue drain?", noteId: id }]);
    expect(listRemindedMisses(db, "Q")).toEqual([]);
    const data = loadEvalData(db as never);
    expect(data.misses).toEqual([{ projectId: "P", query: "when does the refund queue drain?", noteId: id }]);
    const plan = planCorpus({ data, size: 30, seed: 1, skipProjects: new Set(), skipTask: () => false });
    const gold = plan.questions.filter((question) => question.kind === "positive");
    expect(gold).toHaveLength(1);
    expect(gold[0]).toMatchObject({ id: "miss-1", query: "when does the refund queue drain?", gold: [id] });
    expect(plan.notes.map((item) => item.id)).toContain(id);
  });

  it("[sma:k_v_mem_write] a session writes one claim as an observed note of the hub corpus; a list, a credential, an unknown kind or a switched-off project store nothing", async () => {
    const db = db0();
    const api = rpc(db);
    const ok = await api.session_memory_write({ projectId: "P", kind: "note", content: "The refund queue drains at noon on weekdays.", concepts: ["refund"], source: "cli:shell" });
    expect(ok).toMatchObject({ stored: true, reason: null });
    expect(db.prepare("SELECT kind, trust, origin, status FROM lane_pilot_memory WHERE id=?").get(ok.id!)).toEqual({ kind: "note", trust: "observed", origin: "session", status: "active" });
    const list = await api.session_memory_write({ projectId: "P", kind: "note", content: "- one\n- two\n- three", concepts: [] });
    expect(list).toMatchObject({ stored: false, id: null });
    expect(list.reason).toMatch(/one claim/);
    const secret = await api.session_memory_write({ projectId: "P", kind: "note", content: "api_key=abcdefghijklmno123456", concepts: [] });
    expect(secret.reason).toMatch(/credential/);
    const unknown = await api.session_memory_write({ projectId: "P", kind: "rule" as never, content: "A rule-shaped sentence about queues.", concepts: [] });
    expect(unknown.reason).toBe("memory kind must be core or note");
    expect(count(db)).toBe(1);
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('OFF','','memory.enabled','off',1,0)").run();
    expect(await api.session_memory_write({ projectId: "OFF", kind: "note", content: "A fact for a project with memory off.", concepts: [] })).toEqual({ stored: false, id: null, reason: "memory_disabled" });
    expect(count(db, "lane_pilot_memory", "project_id='OFF'")).toBe(0);
  });

  it("[sma:k_v_trim] an overfull core moves down, not out: the last core entry that does not fit becomes a note, the first stays core, and nothing is deleted", () => {
    const db = db0();
    const small = { kind: "core" as const, content: "Always write terse commit messages.", concepts: ["convention"] };
    const big = { kind: "core" as const, content: "x".repeat(400), concepts: ["convention"] };
    const stored = storeMemoryRecordsKeepingOverflow(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", entries: [small, big], coreBudget: 50, noteBudget: 5_000, indexBudget: 9_999, nearDuplicates: false });
    expect(stored.demoted).toBe(1);
    expect(stored.entries.map((entry) => entry.kind)).toEqual(["core", "note"]);
    expect(db.prepare("SELECT kind, content, status FROM lane_pilot_memory WHERE project_id='P' ORDER BY kind").all()).toEqual([
      { kind: "core", content: small.content, status: "active" }, { kind: "note", content: big.content, status: "active" }]);
    expect(coreShelf(db, "P", "", "subagent").tokens).toBeLessThanOrEqual(50);
    // The same corpus under a tight shelf: the older note goes to the archive and stays stored.
    const tight = { projectId: "B", sourceSha256: "b".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 30, indexBudget: 99_999, nearDuplicates: false };
    storeMemoryRecords(db, { ...tight, entries: [note("Oldest shelf note about queues " + "q".repeat(60), ["queues"])], now: 1_000 });
    const second = storeMemoryRecords(db, { ...tight, entries: [note("Newer shelf note about workers " + "w".repeat(60), ["workers"])], now: 2_000 });
    expect(db.prepare("SELECT status, expired_reason AS reason FROM lane_pilot_memory WHERE id=?").get(second.evictedIds[0]!)).toEqual({ status: "expired", reason: "budget" });
    expect(count(db, "lane_pilot_memory", "project_id='B'")).toBe(2);
  });

  it("[sma:k_v_context] the pack for a task holds the notes that share its words within the token budget; one that does not fit whole shows as a head line, an unrelated one is left out", () => {
    const records = [
      record("keep", "deploy staging checklist for the hub"),
      record("long", "deploy staging checklist extra words ".repeat(40)),
      record("away", "borscht recipe with beets"),
    ];
    const pack = memoryContext(records, "deploy staging checklist", 60);
    expect(pack.records.map((item) => item.id)).toEqual(["keep"]);
    expect(pack.heads.map((item) => item.id)).toEqual(["long"]);
    expect(pack.text).toContain("deploy staging checklist for the hub");
    expect(pack.text).toContain("head; id=long");
    expect(pack.text).not.toContain("borscht");
    expect(pack.estimatedTokens).toBeLessThanOrEqual(60);
    const wide = memoryContext(records, "deploy staging checklist", 5_000);
    expect(wide.records.map((item) => item.id).sort()).toEqual(["keep", "long"]);
    expect(wide.heads).toEqual([]);
    expect(memoryContext(records, "kubernetes ingress", 5_000).text).toBe("");
  });

  it("[sma:k_v_usage] a note given to a brief counts one use however often its id is listed, and a note nobody was given for 90 days is the one the review proposes to expire", () => {
    const db = db0();
    const NOW = Date.parse("2026-10-23T10:00:00Z");
    const [used, dead] = put(db, [note("The nightly export writes reports to the archive bucket.", ["export"]), note("The parcel label printer sits on the second floor.", ["printer"])], { now: NOW - 100 * DAY }).insertedIds;
    recordMemoryMixed(db, "P", [used!, used!], NOW - DAY);
    const row = (id: string) => db.prepare("SELECT use_count AS used, last_used_at AS at FROM lane_pilot_memory WHERE id=?").get(id);
    expect(row(used!)).toEqual({ used: 1, at: NOW - DAY });
    expect(row(dead!)).toEqual({ used: 0, at: null });
    expect(memoryUsefulness({ useCount: 1, acceptedCount: 1 })).toBeGreaterThan(memoryUsefulness({ useCount: 3, acceptedCount: 0 }));
    expect(reviewMemory(db, "P", NOW)).toEqual([{ action: "expire", id: dead, reason: "idle" }]);
  });
});

describe("how memory reaches a session: parsing, schema, search (region 14, batch b)", () => {
  const FILE = `---
id: worktree-routing
status: active
claim: Parallel writers use a worktree each
sensitivity: sensitive
retrieval:
  areas: [procedures, "lanes"]
  hint: worktree, lanes
valid_until: 2999-01-01
---

Shared checkouts see each other's half-done edits.
`;

  it("[sma:k_lib_frontmatter] one header parser reads a note's claim, areas and sensitivity, defaults a missing status to active, and renders a record back into a file it reads again", () => {
    const file = parseLaneMemoryFile(FILE.replace("status: active\n", ""))!;
    expect(file).toMatchObject({ id: "worktree-routing", status: "active", claim: "Parallel writers use a worktree each", sensitivity: "sensitive", areas: ["procedures", "lanes"], hint: "worktree, lanes", validUntil: "2999-01-01" });
    expect(file.body).toBe("Shared checkouts see each other's half-done edits.");
    const mapped = laneMemoryFileToCandidate(file)!;
    expect(mapped.audience).toBe("owner");
    expect(mapped.candidate.content).toBe("Parallel writers use a worktree each\n\nShared checkouts see each other's half-done edits.");
    expect(parseLaneMemoryFile("no front matter at all")).toBeNull();
    expect(parseLaneMemoryFile("---\nstatus: active\n---\nbody")).toBeNull();
    expect(laneMemoryFileToCandidate(parseLaneMemoryFile(FILE.replace("status: active", "status: superseded"))!)).toBeNull();
    const text = renderLaneMemoryFile(record("b".repeat(64), "Night review found double discounts.\n\nFix: make applyDiscount idempotent.", { concepts: ["lesson", "checkout"] }), "subagent", new Date("2026-09-30T00:00:00Z"));
    expect(parseLaneMemoryFile(text)).toMatchObject({ id: "lp-bbbbbbbbbbbbbbbb", status: "active", claim: "Night review found double discounts.", areas: ["lesson", "checkout"] });
  });

  it("[sma:k_lib_schema] a record is a core or a note with tags, an optional start and end date and the ids it replaces; anything else is refused, and the audience maps to a sensitivity both ways", () => {
    const settings = parseMemorySettings({});
    const target = "a".repeat(64);
    const parsed = parseMemoryCandidates([{ kind: "note", content: "  The queue drains at noon.  ", concepts: ["Queue", "queue", "Noon"], supersedes: [target], valid_from: "2026-01-01", valid_until: "2026-12-31" }], settings);
    expect(parsed).toEqual([{ kind: "note", content: "The queue drains at noon.", concepts: ["queue", "noon"], supersedes: [target], validFrom: Date.parse("2026-01-01"), validUntil: Date.parse("2026-12-31") }]);
    expect(() => parseMemoryCandidates([{ kind: "rule", content: "x".repeat(30), concepts: [] }], settings)).toThrow("memory kind must be core or note");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x".repeat(30), concepts: [], valid_until: "tomorrow" }], settings)).toThrow("valid_until must be an ISO date");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x".repeat(30), concepts: [], supersedes: ["zz"] }], settings)).toThrow("supersedes must be up to 5 record ids");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x".repeat(30), concepts: [], colour: "red" }], settings)).toThrow("unsupported fields");
    const db = db0();
    const [first] = put(db, [note("The queue drained at midnight in the old setup.", ["queue", "drain"])]).insertedIds;
    const second = put(db, [{ ...parsed[0]!, supersedes: [first!], concepts: ["queue", "drain"] }]);
    expect(db.prepare("SELECT status, superseded_by AS by FROM lane_pilot_memory WHERE id=?").get(first!)).toEqual({ status: "superseded", by: second.insertedIds[0] });
    expect(db.prepare("SELECT valid_until AS until, audience, status FROM lane_pilot_memory WHERE id=?").get(second.insertedIds[0]!)).toEqual({ until: Date.parse("2026-12-31"), audience: "subagent", status: "active" });
    expect(sensitivityForAudience("owner")).toBe("sensitive");
    expect(audienceForSensitivity("sensitive")).toBe("owner");
    expect(audienceForSensitivity("public")).toBe("export");
    expect(audienceForSensitivity(undefined)).toBe("subagent");
  });

  it("[sma:k_lib_generator] the core of a session is the active core records of its project and no other: no note, no hidden record, no other project, the same list twice", async () => {
    const db = db0();
    const [a, b] = put(db, [{ kind: "core", content: "Always write terse commit messages.", concepts: ["convention"] }, { kind: "core", content: "Never commit generated files.", concepts: ["convention"] }]).insertedIds;
    put(db, [note("The kitchen display refreshes every ten seconds.", ["kitchen"])]);
    put(db, [{ kind: "core", content: "Another project's convention.", concepts: ["convention"] }], { projectId: "Q" });
    const [hidden] = put(db, [{ kind: "core", content: "A convention nobody follows any more.", concepts: ["convention"] }]).insertedIds;
    db.prepare("UPDATE lane_pilot_memory SET status='expired' WHERE id=?").run(hidden!);
    const api = rpc(db);
    const first = await api.session_memory_core({ projectId: "P" });
    expect(first.records.map((item) => item.content).sort()).toEqual(["Always write terse commit messages.", "Never commit generated files."]);
    expect(first.records.map((item) => item.id).sort()).toEqual([a, b].sort());
    expect(await api.session_memory_core({ projectId: "P" })).toEqual(first);
    expect((await api.session_memory_core({ projectId: "Q" })).records.map((item) => item.content)).toEqual(["Another project's convention."]);
  });

  it("[sma:k_lib_fts] a search finds the whole-word hits first and, through the trigram index, the word forms the whole-word index misses; a project's other notes never answer", () => {
    const db = db0();
    put(db, [note("The invoice rounding rule keeps half to even.", ["billing"]), note("Nightly archive of invoices goes to cold storage.", ["archive"]), note("The kitchen display refreshes every ten seconds.", ["kitchen"])]);
    put(db, [note("Invoice numbers restart every year in another project.", ["billing"])], { projectId: "Q" });
    expect(searchMemoryRecords(db, "P", "invoice", 5, "auto").map((row) => row.content)).toEqual(["The invoice rounding rule keeps half to even.", "Nightly archive of invoices goes to cold storage."]);
    // `invoices` is not a whole word of the first note: only the trigram index reaches it, and it still ranks below the note that has the word whole.
    expect(searchMemoryRecords(db, "P", "invoices", 5, "auto").map((row) => row.content)).toEqual(["Nightly archive of invoices goes to cold storage.", "The invoice rounding rule keeps half to even."]);
    expect(searchMemoryRecords(db, "P", "kubernetes ingress", 5, "auto")).toEqual([]);
  });

  it("[sma:k_lib_wordforms] one word form finds the others: the ending is cut, a short word is left, and a note in another form of the word is found", () => {
    expect(memoryStem("ошибки")).toBe("ошиб");
    expect(memoryStem("ошибка")).toBe("ошиб");
    expect(memoryStem("ошибок")).toBe("ошиб");
    expect(memoryStem("calculation")).toBe("calculati");
    expect(memoryStem("cat")).toBe("cat");
    expect(memoryStem("queue")).toBe("queue");
    const db = db0();
    put(db, [note("Ошибка округления в счёте повторяется каждый квартал.", ["счета"]), note("The kitchen display refreshes every ten seconds.", ["kitchen"])]);
    expect(searchMemoryRecords(db, "P", "ошибки округления", 5, "auto").map((row) => row.content)).toEqual(["Ошибка округления в счёте повторяется каждый квартал."]);
  });

  it("[sma:k_lib_recall] a session that asks by the words in view gets the notes that hold them, and a question nothing answers gets «nothing relevant» instead of an unrelated note", async () => {
    const db = db0();
    put(db, [note("The nightly export writes reports to the archive bucket.", ["export", "archive"]), note("The kitchen display refreshes every ten seconds.", ["kitchen"])], { trust: "confirmed" });
    const api = rpc(db);
    const found = await api.session_memory_search({ projectId: "P", query: "nightly export archive bucket" });
    expect(found.records.map((item) => item.content)).toEqual(["The nightly export writes reports to the archive bucket."]);
    expect(found.nothingRelevant).toBeUndefined();
    const none = await api.session_memory_search({ projectId: "P", query: "kubernetes ingress controller" });
    expect(none.records).toEqual([]);
    expect(none.nothingRelevant).toBe(true);
    expect(none.message).toMatch(/\S/);
    expect((await api.session_memory_search({ projectId: "Q", query: "nightly export archive bucket" })).nothingRelevant).toBe(true);
  });

  it("[sma:k_lib_fusion] the whole-word list and the word-form list are fused by reciprocal rank: a note both lists find outranks a note only one list finds", () => {
    const db = db0();
    // `invoice` whole: both layers find the first two; `invoices` is only a word form: the trigram layer alone finds the third.
    put(db, [
      note("invoice invoice invoice invoice ledger", ["a"]),
      note("A long sentence about the weekly report where one invoice is mentioned once among many other unrelated words", ["b"]),
      note("invoices pile up in the archive folder", ["c"]),
    ]);
    const order = searchMemoryRecords(db, "P", "invoice", 5, "auto").map((row) => row.content.split(" ")[0]);
    expect(order).toHaveLength(3);
    expect(order.slice(0, 2).sort()).toEqual(["A", "invoice"]);
    expect(order[2]).toBe("invoices");
  });

  it("[sma:k_lib_citations] a note given to a brief counts one use and takes the date of the brief; a note not given, and the same id in another project, stay as they were", () => {
    const db = db0();
    const [a, b] = put(db, [note("The nightly export writes reports to the archive bucket.", ["export"]), note("The parcel label printer sits on the second floor.", ["printer"])]).insertedIds;
    const read = (id: string, project = "P") => db.prepare("SELECT use_count AS used, last_used_at AS at FROM lane_pilot_memory WHERE project_id=? AND id=?").get(project, id);
    expect(read(a!)).toEqual({ used: 0, at: null });
    recordMemoryMixed(db, "P", [a!], 1_700_000_000_000);
    expect(read(a!)).toEqual({ used: 1, at: 1_700_000_000_000 });
    recordMemoryMixed(db, "P", [a!], 1_700_000_500_000);
    expect(read(a!)).toEqual({ used: 2, at: 1_700_000_500_000 });
    expect(read(b!)).toEqual({ used: 0, at: null });
    recordMemoryMixed(db, "Q", [b!], 1_800_000_000_000);
    expect(read(b!)).toEqual({ used: 0, at: null });
  });

  it("[sma:k_lib_fragments] a writer gets at most three notes, those that name a path of its task first, then core; a lesson and a near-twin never take a slot", () => {
    const task = { owns_paths: ["components/greeting-cards/share.vue"], read_first: [] };
    const named = (id: string, text: string, concepts: string[] = [id]) => ({ id, kind: "note" as const, content: `${text} in components/greeting-cards/share.vue`, concepts });
    const notes = [
      named("n1", "The share button opens the native sheet", ["share", "button"]),
      { ...named("lesson", "A lesson about the share button"), concepts: ["lesson"] },
      named("twin", "The share button opens the native sheet", ["share", "button"]),
      named("n2", "The card preview is rendered at 2x"),
      named("n3", "The card title is limited to 40 characters"),
      named("n4", "The card colour comes from the theme"),
      { id: "core1", kind: "core" as const, content: "Always write terse commit messages.", concepts: ["convention"] },
    ];
    expect(writerMemoryPicks(notes, task).map((item) => item.id)).toEqual(["n1", "n2", "n3"]);
    expect(writerMemoryPicks(notes.filter((item) => item.id === "core1" || item.id === "n4"), task).map((item) => item.id)).toEqual(["n4", "core1"]);
    expect(writerMemoryPicks([notes[6]!], { owns_paths: ["lib/other.ts"], read_first: [] }).map((item) => item.id)).toEqual(["core1"]);
  });
});

describe("the catalog verb (region 14, batch b)", () => {
  it("[sma:k_v_catalog] each card line starts with the file's own path, its line count and language, in path order, and an untracked file has none", () => {
    const repo = mkdtempSync(join(tmpdir(), "r14b-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      for (const name of ["b.ts", "a.ts", "c.md"]) writeFileSync(join(repo, name), `// ${name}\n`);
      execFileSync("git", ["add", "a.ts", "b.ts", "c.md"], { cwd: repo });
      writeFileSync(join(repo, "loose.ts"), "// loose\n");
      const out = runCatalogCli([], repo);
      expect(out.exitCode).toBe(0);
      expect(out.stdout!.trim().split("\n").map((line) => line.split(" | ").slice(0, 2).join(" | "))).toEqual(["a.ts | 1 lines", "b.ts | 1 lines", "c.md | 1 lines"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("a dry-run import on a fresh database (region 14, batch b)", () => {
  it("a dry run that rolls back its first index use does not leave the trigram index «ready»: the real import afterwards stores and indexes every line", () => {
    const fresh = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    fresh.exec("DROP TABLE IF EXISTS lane_pilot_memory_trgm");
    const jsonl = [
      JSON.stringify({ source_id: "s1", content: "The billing worker clears its queue every night at three." }),
      JSON.stringify({ source_id: "s2", content: "Releases go through the release captain on weekdays." }),
    ].join("\n");
    const settings = parseMemorySettings({});
    const dry = runMemoryImport({ db: fresh, projectId: "p", source: "bb-memory", jsonl, settings, dryRun: true });
    expect(dry.outcomes.map((row) => row.outcome)).toEqual(["added", "added"]);
    expect(count(fresh)).toBe(0);
    const real = runMemoryImport({ db: fresh, projectId: "p", source: "bb-memory", jsonl, settings });
    expect(real.outcomes.map((row) => row.outcome)).toEqual(["added", "added"]);
    expect(count(fresh)).toBe(2);
    expect(count(fresh, "lane_pilot_memory_trgm")).toBe(2);
    expect(trigramReady(fresh)).toBe(true);
  });
});

describe("the maintenance receipt and the corpus (region 14, batch b)", () => {
  const MAINTAIN = { "memory.enabled": true, "memory.maintain": true, "memory.inject": true, "memory.audience": "subagent", "memory.provider": "critic", "memory.model": "critic-model", "memory.reasoning_effort": "high" };
  const open = (output: string) => setup('{"decision":"approve","summary":"Checked","findings":[]}', undefined, MAINTAIN, undefined, undefined, output,
    undefined, undefined, undefined, false, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, {});

  it("[sma:m_applied] a passed maintenance receipt says what it stored and every id it names is a row of the project's corpus with this task as its origin and a search entry; a claim the accepted result never made is dropped before the door", async () => {
    const entries = [{ kind: "core", content: "Durable deployment convention uses managed workspaces", concepts: ["deployment", "workspace"] },
      { kind: "note", content: "A claim about v9.9.9 the accepted result never made", concepts: ["version"] }];
    const release = holdEvents("memory-thread");
    const { db, harness } = await open(JSON.stringify(entries));
    await harness.behavior.callAgentTool("lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Write a verified fixture", task }, { threadId: pmThreadId, projectId });
    await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId: "stage-run", timeoutSec: 3 }, { threadId: pmThreadId, projectId });
    await until("memory child to be spawned", () => stageReceipt(db, task.id, "memory-maintenance")?.threadId === "memory-thread");
    expect(count(db, "lane_pilot_memory", `project_id='${projectId}'`)).toBe(0);
    release();
    const passed = await until("memory receipt", () => stageReceipt(db, task.id, "memory-maintenance")?.state === "passed" && stageReceipt(db, task.id, "memory-maintenance"));
    const result = passed.result as { stored: number; recordIds: string[]; unsupportedDropped: number };
    expect(result.stored).toBe(1);
    expect(result.unsupportedDropped).toBe(1);
    expect(result.recordIds).toEqual([memoryRecordId(projectId, "core", entries[0]!.content, "")]);
    const rows = db.prepare("SELECT id, kind, status, origin_task_id AS task FROM lane_pilot_memory WHERE project_id=?").all(projectId);
    expect(rows).toEqual([{ id: result.recordIds[0], kind: "core", status: "active", task: task.id }]);
    expect(count(db, "lane_pilot_memory_fts", `project_id='${projectId}' AND id='${result.recordIds[0]}'`)).toBe(1);
    await harness.lifecycle.dispose();
  });
});
