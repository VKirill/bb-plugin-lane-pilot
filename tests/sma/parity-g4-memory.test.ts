import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import {
  addToIndexes, applyShorter, compressibleRow, dropMemoryIndexes, estimateTokens, heavyNoteRows,
  hideRecord, proposeShorter, searchMemoryRecords, storeMemoryRecords, HEAVY_NOTE_TOKENS,
} from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";
import { buildFileCard } from "../../src/rooms/file-cards/card";
import { appendTouch, cardNotes, catalogDir, readCatalog, readTouches, writeCatalog } from "../../src/rooms/file-cards/store";
import { runCatalogCli } from "../../src/rooms/file-cards/cli";
import { runMemoryCompressCli } from "../../src/rooms/memory/server/memory-compress-cli";
import { historySearch } from "../../src/rooms/memory-tiers/server/history";
import { runStreams } from "../../src/rooms/session-hooks/logic";
import { createAttempt, createRun, createTask, recordFinishedAttempt } from "../../src/rooms/storage";
import { insertItem, insertObservation, itemId } from "../../src/rooms/learning/store";
import { appendPart, insertPhase } from "../../src/rooms/phase/store";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createCore } from "../../src/rooms/core/server/core";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import type { Services } from "../../server";

const newHost = () => createFakePluginHost({ pluginId: "lane-pilot" });
const BUDGETS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
const put = (db: MemoryDatabase, entries: MemoryCandidate[], projectId = "P") =>
  storeMemoryRecords(db, { projectId, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries, ...BUDGETS }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });

/** The real `bb lane-pilot …` CLI on a scratch database; `run` takes any verb. */
function cliHarness() {
  const host = newHost();
  const db = openDatabase(host.bb);
  registerCli(createCore(host.bb, db), { memoryConflicts: { detect: () => {}, sweepMoot: () => {} } } as unknown as Services, migrations);
  const run = (argv: string[]) => host.harness.behavior.runCli(argv);
  return { host, db, run };
}

const homes: string[] = [];
/** Points os.homedir() at a scratch dir so catalog writes leave the real home alone. */
function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-home-"));
  homes.push(dir);
  process.env.HOME = dir;
  return dir;
}
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

describe("memory corpus care (parity wave g4)", () => {
  it("[sma:k_lib_compress] a heavy note gets a shorter proposal; applying it keeps kind, concepts, scope and trust and supersedes the old record; a note that cannot shrink gets no proposal", () => {
    const db = openDatabase(newHost().bb);
    const paragraph = "The billing ledger rounds half to even before it writes the invoice total.";
    const heavy = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    expect(estimateTokens(heavy)).toBeGreaterThan(60);
    const [id] = put(db, [note(heavy, ["billing", "ledger"])]);
    const row = compressibleRow(db, "P", id!)!;
    const proposal = proposeShorter(row, 40);
    expect(proposal).toBe(paragraph);
    const done = applyShorter(db, row, proposal!);
    expect(done.supersededIds).toEqual([id]);
    expect(done.insertedIds).toHaveLength(1);
    const kept = db.prepare("SELECT kind, audience, concepts_json, scope_json, trust, status FROM lane_pilot_memory WHERE id=?").get(done.insertedIds[0]!) as
      { kind: string; audience: string; concepts_json: string; scope_json: string | null; trust: string; status: string };
    expect(kept).toMatchObject({ kind: "note", audience: "subagent", trust: "confirmed", status: "active" });
    expect(JSON.parse(kept.concepts_json)).toEqual(["billing", "ledger"]);
    const old = db.prepare("SELECT status, superseded_by FROM lane_pilot_memory WHERE id=?").get(id!) as { status: string; superseded_by: string };
    expect(old).toEqual({ status: "superseded", superseded_by: done.insertedIds[0] });
    const plain = note("A short fact that cannot shrink.", []);
    expect(proposeShorter(plain, 40)).toBeNull();
  });

  it("[sma:k_v_mem_compress] the list form changes no row; --apply supersedes exactly that note and leaves the other proposals unapplied", async () => {
    const { db, run } = cliHarness();
    const repeated = (word: string) => Array(30).fill(`The ${word} rule of the ledger holds for every invoice.`).join("\n\n");
    const [a, b] = put(db, [note(repeated("first")), note(repeated("second"))]);
    const listed = await run(["memory-compress", "--project", "P"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(a!.slice(0, 12));
    expect(listed.stdout).toContain(b!.slice(0, 12));
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status='superseded'").get() as { n: number }).toMatchObject({ n: 0 });
    const applied = await run(["memory-compress", "--apply", a!, "--project", "P"]);
    expect(applied.exitCode).toBe(0);
    const rows = db.prepare("SELECT id, status FROM lane_pilot_memory ORDER BY rowid").all() as Array<{ id: string; status: string }>;
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get(a)).toBe("superseded");
    expect(byId.get(b)).toBe("active");
    expect(rows.filter((row) => row.status === "active")).toHaveLength(2);
  });

  it("[sma:k_lib_catalog] the same bytes and git facts give an identical card twice; changing one byte changes only the derived fields; the builder imports no model client", () => {
    const source = "/**\n * Billing ledger helpers.\n */\nexport function roundHalf(x: number) { return x; }\nexport const LEDGER = 1;\n";
    const git = { lastCommit: "abc1234", commits: 3 };
    const first = buildFileCard({ path: "src/ledger.ts", bytes: source, git });
    const second = buildFileCard({ path: "src/ledger.ts", bytes: source, git });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ path: "src/ledger.ts", language: "typescript", headLine: "Billing ledger helpers.", lastCommit: "abc1234", commits: 3 });
    expect(first.exports).toEqual(["LEDGER", "roundHalf"]);
    const changed = buildFileCard({ path: "src/ledger.ts", bytes: source.replace("return x", "return x + 1"), git });
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed).toMatchObject({ path: first.path, language: first.language, headLine: first.headLine, exports: first.exports, lastCommit: first.lastCommit, commits: first.commits });
    const cardSource = readFileSync(join(__dirname, "../../src/rooms/file-cards/card.ts"), "utf8");
    expect(cardSource.match(/^import .*$/gm)).toEqual(['import { createHash } from "node:crypto";']);
  });

  it("[sma:k_st_catalog] after a catalog write and two touches, cards.jsonl holds one line per path, touch.jsonl holds both, a carded path emits a [file-card] line, and the repo tree is unchanged", () => {
    const home = scratchHome();
    const repo = mkdtempSync(join(tmpdir(), "lp-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(join(repo, "a.ts"), "export const A = 1;\n");
      writeCatalog(repo, [buildFileCard({ path: "a.ts", bytes: "export const A = 1;\n", git: { lastCommit: "beef0001", commits: 1 } })]);
      writeCatalog(repo, [buildFileCard({ path: "b.ts", bytes: "export const B = 2;\n" })]);
      appendTouch(repo, { at: 1, tool: "edit", path: `${repo}/a.ts` });
      appendTouch(repo, { at: 2, tool: "write", path: `${repo}/b.ts` });
      const dir = catalogDir(repo);
      expect(dir.startsWith(home)).toBe(true);
      expect(readFileSync(join(dir, "cards.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
      expect(readFileSync(join(dir, "touch.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
      expect(readTouches(repo).map((touch) => touch.path)).toEqual([`${repo}/a.ts`, `${repo}/b.ts`]);
      const notes = cardNotes(repo, `${repo}/a.ts`);
      expect(notes[0]!.claim).toContain("a.ts");
      const streams = runStreams({ tool: "edit", sid: "s", cwd: repo, command: "", path: `${repo}/a.ts`, denials: {}, notes }, Date.now);
      expect(streams.advice.some((line) => line.startsWith("[file-card]"))).toBe(true);
      expect(readCatalog(repo).map((card) => card.path).sort()).toEqual(["a.ts", "b.ts"]);
      expect(existsSync(join(repo, "cards.jsonl"))).toBe(false);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).not.toContain("cards.jsonl");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[sma:k_v_catalog] in a temp git repo with three tracked files and one untracked, the verb prints exactly three lines and without --write leaves the catalog folder empty", () => {
    const home = scratchHome();
    const repo = mkdtempSync(join(tmpdir(), "lp-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      for (const name of ["a.ts", "b.ts", "c.md"]) writeFileSync(join(repo, name), `// ${name}\n`);
      execFileSync("git", ["add", "a.ts", "b.ts", "c.md"], { cwd: repo });
      writeFileSync(join(repo, "untracked.ts"), "// loose\n");
      const listed = runCatalogCli([], repo);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout!.trim().split("\n")).toHaveLength(3);
      expect(listed.stdout).toContain("a.ts");
      expect(listed.stdout).not.toContain("untracked");
      expect(existsSync(catalogDir(repo))).toBe(false);
      expect(home).toBeTruthy();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[sma:k_lib_history] history search spans five books and masks secrets: a task, an attempt reason, an observation, a learning item and a phase part sharing one word give five hits with five source labels and the key replaced by the mask", () => {
    const db = openDatabase(newHost().bb);
    const word = "billingledger";
    const secret = `sk-${"a1b2c3".repeat(5)}`;
    createRun(db, "run1", "P");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: `Fix the ${word} rounding` } });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    recordFinishedAttempt(db, "a1", "accepted", `${word} patch accepted`);
    insertObservation(db, {
      id: "obs1", threadId: "thr1", projectId: "P", at: 1, judgedAt: 1, source: "live", chars: 40,
      excerpt: `the owner asked about ${word}`, state: "extracted", skipReason: null, sensitive: false,
      jevStatus: "ok", receiptId: null, kind: null, kindP: null, learnP: null, durable: null, scope: null,
      frustration: null, deadline: null, route: null, secondStatus: null, secondKind: null, secondLearnP: null,
      secondDurable: null, secondRoute: null, secondMs: null, secondTokens: null, finalRoute: "learn",
      body: null, prev: null, review: null, reviewedAt: null,
    });
    insertItem(db, {
      id: itemId("obs1", "fact", `${word} rounds half to even, key ${secret}`), obsId: "obs1", projectId: "P", threadId: "thr1",
      kind: "fact", text: `${word} rounds half to even, key ${secret}`, audience: null, reach: "project", dueAt: null,
      state: "accepted", target: null, evidence: "obs1", duplicateOf: null, confirmations: 0, note: null,
      createdAt: 2, decidedAt: null, announcedAt: null,
    });
    insertPhase(db, { id: "ph1", projectId: "P", pmThreadId: "thr1", title: "phase", goal: "goal", at: 3 });
    appendPart(db, "ph1", { section: "decisions", kind: "note", text: `decided: ${word} uses bankers rounding`, at: 3 });
    const hits = historySearch(db as never, "P", word, { limit: 20 });
    expect(new Set(hits.map((hit) => hit.source))).toEqual(new Set(["tasks", "execution", "transcripts", "lessons", "books"]));
    const text = hits.map((hit) => hit.excerpt).join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("***");
    const lessons = hits.find((hit) => hit.source === "lessons")!;
    expect(lessons.excerpt).toContain("[fact]");
  });

  it("[sma:k_v_history] `memory history` returns fragments from a past task, a phase book part and a learning item, and a planted ghp_ token is masked in the output", async () => {
    const { db, run } = cliHarness();
    const word = "billingledger";
    const secret = `ghp_${"9f8e7d".repeat(4)}`;
    createRun(db, "run1", "P");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: `Fix the ${word} rounding` } });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    recordFinishedAttempt(db, "a1", "accepted", `${word} shipped`);
    insertItem(db, {
      id: itemId("obs2", "fact", `${word} rule, key ${secret}`), obsId: "obs2", projectId: "P", threadId: "thr1",
      kind: "fact", text: `${word} rule, key ${secret}`, audience: null, reach: "project", dueAt: null,
      state: "accepted", target: null, evidence: "obs2", duplicateOf: null, confirmations: 0, note: null,
      createdAt: 2, decidedAt: null, announcedAt: null,
    });
    insertPhase(db, { id: "ph1", projectId: "P", pmThreadId: "thr1", title: "phase", goal: "goal", at: 3 });
    appendPart(db, "ph1", { section: "decisions", kind: "note", text: `decided: ${word} uses bankers rounding`, at: 3 });
    const answer = await run(["memory", "history", word, "--project", "P"]);
    expect(answer.exitCode).toBe(0);
    for (const label of ["tasks", "lessons", "books"]) expect(answer.stdout).toContain(label);
    expect(answer.stdout).not.toContain(secret);
    const denied = await run(["memory", "history", word, "--project", "P", "--source", "nonsense"]);
    expect(denied.exitCode).toBe(1);
  });

  it("[sma:m_sw_index_panel] after deleting one record's fts row by hand a search misses it; cockpit_memory index restores it, and hidden or superseded records stay out of the index", async () => {
    const host = newHost();
    const db = openDatabase(host.bb);
    createRun(db, "run1", "P");
    const [live, hidden] = put(db, [note("The alpha ledger fact stays searchable."), note("The omega ledger fact was hidden.")]);
    const unindex = (p: string, id: string) => dropMemoryIndexes(db, p, id);
    hideRecord(db, "P", hidden!, "expired", null, unindex, "budget");
    dropMemoryIndexes(db, "P", live!);
    expect(searchMemoryRecords(db, "P", "alpha ledger", 10, "auto").map((item) => item.id)).not.toContain(live);
    const cockpit = cockpitRpc({ db, bb: host.bb } as never, {} as never) as unknown as Record<string, (input: unknown) => Promise<{ exitCode: number; output: string }>>;
    const answer = await cockpit.cockpit_memory!({ runId: "run1", action: "index" });
    expect(answer.exitCode).toBe(0);
    expect(searchMemoryRecords(db, "P", "alpha ledger", 10, "auto").map((item) => item.id)).toContain(live);
    expect(searchMemoryRecords(db, "P", "omega ledger", 10, "auto").map((item) => item.id)).not.toContain(hidden);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE id=?").get(hidden!) as { n: number }).toMatchObject({ n: 0 });
  });
});
