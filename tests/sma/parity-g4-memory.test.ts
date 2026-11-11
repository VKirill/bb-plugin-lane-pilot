import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import {
  addToIndexes, applyShorter, compressibleRow, dropMemoryIndexes, estimateTokens, heavyNoteRows,
  hideRecord, proposeShorter, searchMemoryRecords, storeMemoryRecords, HEAVY_NOTE_TOKENS,
} from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";
import { buildFileCard } from "../../src/rooms/file-cards/card";
import { appendTouch, cardNotes, catalogDir, findRepo, readCatalog, readMeta, readTouches, repoHead, writeCatalog, writeMeta } from "../../src/rooms/file-cards/store";
import { buildCatalog, catalogNeedsBuild, collectCards, takeBuildLock } from "../../src/rooms/file-cards/build";
import { SESSION_HOOK_SOURCE } from "../../src/rooms/contracts/session-hook-source";
import { workFilePathError } from "../../src/rooms/runs/server/work-file";
import { shortenText, resolveCompressible, undoShorter } from "../../packages/memory-core/src";
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
function cliHarness(threads: Record<string, { projectId: string; role?: string }> = {}) {
  const host = newHost();
  const db = openDatabase(host.bb);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId]!.projectId } : null);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threads[threadId]?.role ? { role: threads[threadId]!.role } : null);
  registerCli(createCore(host.bb, db), { memoryConflicts: { detect: () => {}, sweepMoot: () => {} } } as unknown as Services, migrations);
  const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(argv, threadId ? { threadId } : {});
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
    // Only the node hash and the two kit helpers that mask and filter: no model client.
    expect(cardSource.match(/^import .*$/gm)).toEqual([
      'import { createHash } from "node:crypto";',
      'import { maskCredentials } from "../../../packages/kit/src/redact.ts";',
      'import { secretPathHit } from "../../../packages/kit/src/secret-files.ts";',
    ]);
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

// ---- review fixes -------------------------------------------------------------------------------------------------

const ROOT = join(__dirname, "../..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const dirs: string[] = [];
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function makeRepo(files: Record<string, string | Buffer> = { "a.ts": "/**\n * Ledger helpers.\n */\nexport const A = 1;\n" }): string {
  const repo = scratch("lp-g4repo-");
  git(repo, "init", "-q", "-b", "main");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

/** The real hook process: from the plain source (strip-types) or from the generated bundle. */
function runHook(payload: Record<string, unknown>, home: string, how: "source" | "bundle" = "source") {
  let args = ["--experimental-strip-types", "src/rooms/session-hooks/cli.ts"];
  if (how === "bundle") {
    const file = join(home, "session-hook.mjs");
    writeFileSync(file, SESSION_HOOK_SOURCE);
    args = [file];
  }
  return spawnSync(process.execPath, args, { cwd: ROOT, input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home } });
}
const waitFor = async (ok: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return ok(); };

describe("review fixes: the session hook and the file catalog", () => {
  it("[sma:k_st_catalog] the guard, which sees every real Edit, prints the catalog card once per session and path, from a worktree too; an uncarded file gets nothing", () => {
    const home = scratchHome();
    const repo = mkdtempSync(join(tmpdir(), "lp-repo-"));
    const tree = `${repo}-wt`;
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      writeFileSync(join(repo, "a.ts"), "export const A = 1;\n");
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"], { cwd: repo });
      execFileSync("git", ["worktree", "add", "-q", tree], { cwd: repo });
      writeCatalog(repo, [buildFileCard({ path: "a.ts", bytes: "export const A = 1;\n", git: { lastCommit: "beef0001", commits: 1 } })]);
      const guardFile = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
      const edit = (cwd: string, file: string, session: string) => spawnSync("python3", [guardFile], {
        input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd, session_id: session }),
        encoding: "utf8", env: { ...process.env, HOME: home, LANE_PILOT_ROLE: "writer" },
      }).stdout ?? "";
      expect(edit(repo, join(repo, "a.ts"), "s1")).toContain("[file-card] a.ts: 2 lines of typescript");
      expect(edit(repo, join(repo, "a.ts"), "s1")).not.toContain("[file-card]");
      expect(edit(tree, "a.ts", "s2")).toContain("last change beef0001");
      expect(edit(repo, join(repo, "b.ts"), "s3")).not.toContain("[file-card]");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("[sma:k_st_catalog] the hook runs as plain source and as the bundle, and a Claude Code `Edit` call gets the [file-card] note on PreToolUse and a touch line on PostToolUse", () => {
    const repo = makeRepo();
    for (const how of ["source", "bundle"] as const) {
      const home = scratch("lp-home-");
      process.env.HOME = home;
      expect(buildCatalog(repo).ok).toBe(true);
      const pre = runHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "a.ts") }, tool_response: "ok" }, home, how);
      expect(pre.status, pre.stderr).toBe(0);
      expect(pre.stdout, how).toContain("[file-card]");
      expect(pre.stdout).toContain("Ledger helpers.");
      for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
        const post = runHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: repo, tool_name: tool, tool_input: { file_path: join(repo, "a.ts") }, tool_response: "ok" }, home, how);
        expect(post.status, post.stderr).toBe(0);
      }
      expect(readTouches(repo).map((touch) => touch.tool)).toEqual(["edit", "multiedit", "write", "notebookedit"]);
      // A tool that is not an edit leaves no touch line.
      runHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: repo, tool_name: "Read", tool_input: { file_path: join(repo, "a.ts") }, tool_response: "ok" }, home, how);
      expect(readTouches(repo)).toHaveLength(4);
    }
  });

  it("[sma:k_st_catalog] a repo with no catalog gets no folder from an edit; a failing touch append cannot skip the stall bookkeeping; the journal is capped; one bad catalog line does not empty the catalog", () => {
    const repo = makeRepo();
    const home = scratch("lp-home-");
    process.env.HOME = home;
    const post = runHook({ hook_event_name: "PostToolUse", session_id: "s2", cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "a.ts") }, tool_response: "ok" }, home);
    expect(post.status).toBe(0);
    expect(existsSync(join(home, ".lane-pilot", "catalog"))).toBe(false);
    expect(existsSync(join(home, ".lane-pilot", "session-hooks", "s2", "stall.json"))).toBe(true);
    // With a catalog, a touch.jsonl that cannot be appended to (a folder) still lets the stall file be written.
    buildCatalog(repo);
    mkdirSync(join(catalogDir(repo), "touch.jsonl"));
    rmSync(join(home, ".lane-pilot", "session-hooks", "s2", "stall.json"));
    expect(runHook({ hook_event_name: "PostToolUse", session_id: "s2", cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "a.ts") }, tool_response: "ok" }, home).status).toBe(0);
    expect(existsSync(join(home, ".lane-pilot", "session-hooks", "s2", "stall.json"))).toBe(true);
    rmSync(join(catalogDir(repo), "touch.jsonl"), { recursive: true });
    // The cap: past about 1 MB the file keeps its newest 2000 lines.
    const long = "x".repeat(400);
    for (let at = 1; at <= 2700; at++) appendTouch(repo, { at, tool: "edit", path: `${long}${at}` });
    const kept = readTouches(repo);
    expect(kept.length).toBeLessThanOrEqual(2700);
    expect(kept.length).toBeGreaterThanOrEqual(2000);
    expect(kept[kept.length - 1]!.at).toBe(2700);
    expect(statSync(join(catalogDir(repo), "touch.jsonl")).size).toBeLessThan(1_300_000);
    expect(kept[0]!.at).toBeGreaterThan(1);
    // One bad line is skipped, the cards around it still answer.
    const file = join(catalogDir(repo), "cards.jsonl");
    const good = readCatalog(repo);
    const card = (path: string) => JSON.stringify(buildFileCard({ path, bytes: `// ${path}\n` }));
    writeFileSync(file, `${card("one.ts")}\n{"path":"broken.ts", oops\n${card("two.ts")}\n`);
    expect(good.length).toBeGreaterThan(0);
    expect(readCatalog(repo).map((entry) => entry.path)).toEqual(["one.ts", "two.ts"]);
    expect(cardNotes(repo, join(repo, "two.ts"))[0]!.claim).toContain("two.ts");
    expect(cardNotes(repo, join(repo, "broken.ts"))).toEqual([]);
  });

  it("[sma:k_st_catalog] a card never carries a secret: a token on a first line is masked when built and again when printed; secret-named, binary and over-size files get name and size only; a failed git log is reported", () => {
    const token = `sk-${"a1b2c3d4".repeat(4)}`;
    const repo = makeRepo({
      "a.ts": `// key ${token}\nexport const A = 1;\n`,
      ".env": `TOKEN=${token}\n`,
      "blob.bin": Buffer.concat([Buffer.from("MZ"), Buffer.alloc(10), Buffer.from("tail")]),
      "big.txt": `first line ${token}\n${"y".repeat(300_000)}`,
    });
    process.env.HOME = scratch("lp-home-");
    const built = buildCatalog(repo);
    expect(built.ok).toBe(true);
    const cards = new Map(readCatalog(repo).map((entry) => [entry.path, entry]));
    expect(cards.get("a.ts")!.headLine).toContain("***");
    expect(JSON.stringify([...cards.values()])).not.toContain(token);
    expect(cards.get(".env")).toMatchObject({ skipped: "secret", headLine: "", exports: [], lines: 0, sha256: "" });
    expect(cards.get("blob.bin")).toMatchObject({ skipped: "binary", headLine: "", bytes: 16 });
    expect(cards.get("big.txt")).toMatchObject({ skipped: "large", headLine: "" });
    expect(cards.get("big.txt")!.bytes).toBeGreaterThan(256 * 1024);
    // Printed again through the mask even when the catalog on disk was written by hand with the raw text.
    writeFileSync(join(catalogDir(repo), "cards.jsonl"), `${JSON.stringify({ ...buildFileCard({ path: "h.ts", bytes: "x" }), headLine: `key ${token}` })}\n`);
    const note = cardNotes(repo, join(repo, "h.ts"))[0]!.claim;
    expect(note).toContain("***");
    expect(note).not.toContain(token);
    // The filter is the one the work-file window uses.
    expect(workFilePathError(".env")).toMatch(/names a secret/);
    expect(workFilePathError(".ssh/config")).toMatch(/inside \.ssh/);
    // A repo with no commit: git log fails, the verb says so instead of returning silently empty facts.
    const empty = scratch("lp-empty-");
    git(empty, "init", "-q");
    writeFileSync(join(empty, "x.ts"), "export const X = 1;\n");
    git(empty, "add", "x.ts");
    const listed = runCatalogCli([], empty);
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toMatch(/git log failed/);
  });

  it("[sma:k_st_catalog] the catalog is keyed by the repository: the main checkout, a subfolder and a git worktree share one folder, and the worktree's edits find the card", () => {
    const repo = makeRepo();
    process.env.HOME = scratch("lp-home-");
    const tree = join(scratch("lp-tree-"), "task");
    git(repo, "worktree", "add", "-q", "-b", "task", tree);
    mkdirSync(join(repo, "sub"));
    expect(catalogDir(tree)).toBe(catalogDir(repo));
    expect(catalogDir(join(repo, "sub"))).toBe(catalogDir(repo));
    expect(findRepo(tree)!.commonDir).toBe(join(repo, ".git"));
    expect(repoHead(findRepo(tree)!)).toBe(git(repo, "rev-parse", "HEAD").trim());
    // The verb from the worktree writes the same catalog; the hook-side lookup from either cwd answers.
    const written = runCatalogCli(["--write", "--path", tree]);
    expect(written.exitCode).toBe(0);
    expect(readCatalog(repo).map((entry) => entry.path)).toContain("a.ts");
    expect(cardNotes(tree, join(tree, "a.ts"))[0]!.claim).toContain("Ledger helpers.");
    expect(cardNotes(repo, join(repo, "a.ts"))[0]!.claim).toContain("Ledger helpers.");
    // A folder outside any repository has no catalog to find.
    expect(cardNotes(scratch("lp-none-"), "/x/a.ts")).toEqual([]);
  });

  it("[sma:k_st_catalog] a session start builds a missing or stale catalog in a detached process, once per HEAD, from the plain source and from the bundle", async () => {
    for (const how of ["source", "bundle"] as const) {
      const repo = makeRepo();
      const home = scratch("lp-home-");
      process.env.HOME = home;
      const start = () => runHook({ hook_event_name: "SessionStart", session_id: "s3", cwd: repo }, home, how);
      const first = start();
      expect(first.status, first.stderr).toBe(0);
      expect(await waitFor(() => readMeta(repo) !== null), how).toBe(true);
      const meta = readMeta(repo)!;
      expect(meta.head).toBe(git(repo, "rev-parse", "HEAD").trim());
      expect(meta.files).toBe(1);
      expect(readCatalog(repo).map((entry) => entry.path)).toEqual(["a.ts"]);
      expect(existsSync(join(catalogDir(repo), "build.lock"))).toBe(false);
      // Same HEAD: nothing is started again.
      expect(catalogNeedsBuild(repo)).toBe(false);
      start();
      await new Promise((r) => setTimeout(r, 500));
      expect(readMeta(repo)!.builtAt).toBe(meta.builtAt);
      // A new commit makes the catalog stale: the next start rebuilds.
      writeFileSync(join(repo, "b.ts"), "export const B = 2;\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "second");
      // …but not within the pause: worktrees at different HEADs share the catalog and must not rebuild it on every start.
      expect(catalogNeedsBuild(repo)).toBe(false);
      expect(catalogNeedsBuild(repo, Date.now() + 31 * 60_000)).toBe(true);
      writeMeta(repo, { ...readMeta(repo)!, builtAt: Date.now() - 31 * 60_000 });
      start();
      expect(await waitFor(() => readMeta(repo)!.files === 2), how).toBe(true);
      expect(readMeta(repo)!.head).toBe(git(repo, "rev-parse", "HEAD").trim());
      // Only the catalog folder under ~/.lane-pilot was written; the checkout is untouched.
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(readdirSync(join(home, ".lane-pilot")).sort()).toEqual(["catalog", "session-hooks"]);
    }
  }, 60_000);

  it("[sma:k_st_catalog] one builder at a time (a lock with a pid and a 10-minute expiry) and the build is bounded by file count and wall time", () => {
    const repo = makeRepo({ "a.ts": "export const A = 1;\n", "b.ts": "export const B = 1;\n", "c.ts": "export const C = 1;\n" });
    process.env.HOME = scratch("lp-home-");
    const dir = catalogDir(repo);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    expect(takeBuildLock(dir, now)).toBe(true);
    expect(takeBuildLock(dir, now + 1000)).toBe(false);
    expect(buildCatalog(repo).message).toMatch(/already running/);
    expect(catalogNeedsBuild(repo, now + 1000)).toBe(false);
    // After ten minutes the lock is stale and is taken over.
    expect(takeBuildLock(dir, now + 11 * 60_000)).toBe(true);
    rmSync(join(dir, "build.lock"));
    // A lock whose process is gone is not held.
    writeFileSync(join(dir, "build.lock"), JSON.stringify({ pid: 2 ** 22 - 1, at: now }));
    expect(takeBuildLock(dir, now)).toBe(true);
    rmSync(join(dir, "build.lock"));
    const capped = collectCards(repo, { maxFiles: 2 });
    expect(capped.cards).toHaveLength(2);
    expect(capped.partial).toBe(true);
    let tick = 0;
    const slow = collectCards(repo, { wallMs: 60_000, now: () => (tick++ === 0 ? 0 : 61_000) });
    expect(slow.cards).toHaveLength(0);
    expect(slow.partial).toBe(true);
    expect(buildCatalog(repo).ok).toBe(true);
    expect(readCatalog(repo)).toHaveLength(3);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("review fixes: memory-compress and history", () => {
  const long = (word: string) => Array(30).fill(`The ${word} rule of the ledger holds for every invoice.`).join("\n\n");

  it("[sma:k_lib_compress] shortening never changes meaning: identifiers, ** in code, backtick spans, lists, tables and code blocks stay; only spaces, trailing spaces and an exact repeated sentence go", () => {
    const keep = [
      "Edit __tests__/a.ts and __init__.py, not the generated ones.",
      "Pass **kwargs and compute a ** b before calling.",
      "Run `npm  run   build` twice.",
      "- first item\n- second item\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      "```py\ndef  f(**kwargs):\n    return   a ** b\n```",
    ];
    for (const text of keep) expect(shortenText(text)).toBe(text);
    expect(shortenText("Two  spaces   inside, trailing here.   \nNext line.  ")).toBe("Two spaces inside, trailing here.\nNext line.");
    expect(shortenText("The ledger rounds half to even. Keep it. The ledger rounds half to even.")).toBe("The ledger rounds half to even. Keep it.");
    expect(shortenText("```\nkeep   this   as it is\n```\nafter  fence")).toBe("```\nkeep   this   as it is\n```\nafter fence");
    expect(shortenText("  - indented  item\n    nested   text")).toBe("  - indented item\n    nested text");
    // Nothing the rules can shorten: no proposal.
    expect(proposeShorter({ kind: "note", content: keep.join("\n\n") }, 1)).toBeNull();
    expect(proposeShorter({ kind: "note", content: `${"A short unique sentence number one. ".repeat(1)}` }, 1)).toBeNull();
  });

  it("[sma:k_v_mem_compress] --apply takes only an ACTIVE note, by exact id or one unique prefix; wildcards in a prefix are literal", async () => {
    const { db, run } = cliHarness();
    const [live, revoked, expired, replaced, other] = put(db, ["a", "b", "c", "d", "e"].map((w, i) => note(i === 4 ? long("fifth") : long(`word${w}`))));
    const unindex = (p: string, id: string) => dropMemoryIndexes(db, p, id);
    hideRecord(db, "P", revoked!, "expired", null, unindex, "revoked");
    hideRecord(db, "P", expired!, "expired", null, unindex, "dated");
    hideRecord(db, "P", replaced!, "superseded", live!, unindex);
    for (const id of [revoked!, expired!, replaced!]) {
      const out = await run(["memory-compress", "--apply", id, "--project", "P"]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toMatch(/no active note/);
    }
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status='active'").get()).toMatchObject({ n: 2 });
    expect((await run(["memory-compress", "--apply", "%", "--project", "P"])).stderr).toMatch(/no active note/);
    expect((await run(["memory-compress", "--apply", "_", "--project", "P"])).stderr).toMatch(/no active note/);
    // A prefix shared by two active notes is refused; a unique one works.
    db.prepare("UPDATE lane_pilot_memory SET id=? WHERE id=?").run("abcd0001".padEnd(64, "0"), live!);
    db.prepare("UPDATE lane_pilot_memory SET id=? WHERE id=?").run("abcd0002".padEnd(64, "0"), other!);
    const shared = await run(["memory-compress", "--apply", "abcd", "--project", "P"]);
    expect(shared.exitCode).toBe(1);
    expect(shared.stderr).toMatch(/more than one/);
    expect(resolveCompressible(db, "P", "abcd0001")).toHaveProperty("row");
    expect((await run(["memory-compress", "--apply", "abcd0001", "--project", "P"])).exitCode).toBe(0);
  });

  it("[sma:k_v_mem_compress] the list is open to the owner and the PM chat of its own project; --apply and --undo are the owner's alone; every refusal names its reason", async () => {
    const h = cliHarness({ thr_pm: { projectId: "P", role: "pm" }, thr_other: { projectId: "Q", role: "pm" }, thr_writer: { projectId: "P", role: "writer" }, thr_blank: { projectId: "P" } });
    const [id] = put(h.db, [note(long("first"))]);
    expect((await h.run(["memory-compress", "--project", "P"], "thr_pm")).stdout).toContain(id!.slice(0, 12));
    expect((await h.run(["memory-compress"], "thr_pm")).stdout).toContain(id!.slice(0, 12));
    expect((await h.run(["memory-compress", "--project", "P"])).exitCode).toBe(0);
    expect((await h.run(["memory-compress", "--project", "P"], "thr_other")).stderr).toMatch(/only that thread's own project \(Q\), not P/);
    expect((await h.run(["memory-compress", "--project", "P"], "thr_writer")).stderr).toMatch(/not for a writer thread/);
    expect((await h.run(["memory-compress", "--project", "P"], "thr_blank")).stderr).toMatch(/role is unknown/);
    for (const threadId of ["thr_pm", "thr_writer", "thr_other", "thr_blank"]) {
      for (const flag of ["--apply", "--undo"]) {
        const out = await h.run(["memory-compress", flag, id!, "--project", "P"], threadId);
        expect(out.exitCode, `${threadId} ${flag}`).toBe(1);
        expect(out.stderr).toMatch(/owner's alone/);
      }
    }
    expect(h.db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(id!)).toEqual({ status: "active" });
    expect((await h.run(["memory-compress", "--apply", id!, "--project", "P"])).exitCode).toBe(0);
  });

  it("[sma:k_lib_compress] the shorter record keeps the old one's file link, dates, origin and task id; a re-import of the file does not bring the long row back; --undo reverses the apply", async () => {
    const { db, run } = cliHarness();
    const text = long("billing");
    const until = Date.now() + 90 * 86_400_000;
    const entry: MemoryCandidate = { kind: "note", content: text, concepts: ["ledger"], sourceFileId: "file:ledger", validUntil: until, validFrom: 1234 };
    const imported = () => storeMemoryRecords(db, { projectId: "P", sourceSha256: "c".repeat(64), audience: "subagent", trust: "confirmed", origin: "import", originTaskId: "task-9", entries: [entry], ...BUDGETS });
    const [oldId] = imported().insertedIds;
    const applied = await run(["memory-compress", "--apply", oldId!, "--project", "P"]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    const rows = () => db.prepare("SELECT id, status, origin, origin_task_id, source_file_id, valid_from, valid_until, superseded_by FROM lane_pilot_memory ORDER BY rowid").all() as Array<Record<string, unknown>>;
    const [before, after] = rows();
    expect(before).toMatchObject({ id: oldId, status: "superseded" });
    expect(after).toMatchObject({ status: "active", origin: "import", origin_task_id: "task-9", source_file_id: "file:ledger", valid_from: 1234, valid_until: until });
    const newId = after!.id as string;
    // The file is imported again unchanged: the old long row stays superseded, the short one stays the only active note.
    imported();
    expect(rows().map((row) => [row.id, row.status])).toEqual([[oldId, "superseded"], [newId, "active"]]);
    expect(searchMemoryRecords(db, "P", "ledger invoice rule", 10, "auto").map((item) => item.id)).toEqual([newId]);
    // Undo: the long one is active, the short one superseded by it, and the index follows.
    const undone = await run(["memory-compress", "--undo", newId, "--project", "P"]);
    expect(undone.exitCode, undone.stderr).toBe(0);
    expect(rows().map((row) => [row.id, row.status])).toEqual([[oldId, "active"], [newId, "superseded"]]);
    expect(searchMemoryRecords(db, "P", "ledger invoice rule", 10, "auto").map((item) => item.id)).toEqual([oldId]);
    // A note that was never compressed cannot be undone.
    expect(() => undoShorter(db, "P", oldId!)).toThrow(/not a compressed note/);
    // The undone short row still exists, so applying again says so instead of inventing a second one.
    const again = await run(["memory-compress", "--apply", oldId!, "--project", "P"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });

  it("[sma:k_v_history] `memory history` from a thread reads only that thread's own project; an explicit other --project is refused with the reason, the owner may name any", async () => {
    const h = cliHarness({ thr_pm: { projectId: "P", role: "pm" } });
    const word = "billingledger";
    createRun(h.db, "run1", "Q");
    createTask(h.db, { id: "t1", runId: "run1", kind: "bb", contract: { title: `Fix the ${word} rounding` } });
    createAttempt(h.db, { id: "a1", runId: "run1", taskId: "t1" });
    recordFinishedAttempt(h.db, "a1", "accepted", `${word} shipped`);
    const foreign = await h.run(["memory", "history", word, "--project", "Q"], "thr_pm");
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toMatch(/only that thread's own project \(P\), not Q/);
    expect((await h.run(["memory", "history", word], "thr_pm")).exitCode).toBe(0);
    expect((await h.run(["memory", "history", word, "--project", "P"], "thr_pm")).exitCode).toBe(0);
    const owner = await h.run(["memory", "history", word, "--project", "Q"]);
    expect(owner.exitCode).toBe(0);
    expect(owner.stdout).toContain("tasks");
  });

  it("[sma:k_v_catalog] `catalog --write` is the owner's (it reads folders of the hub machine): a chat is refused, the owner's build obeys the same key and limits", async () => {
    const h = cliHarness({ thr_pm: { projectId: "P", role: "pm" } });
    const repo = makeRepo({ "a.ts": "export const A = 1;\n", ".env": "TOKEN=abcdefgh12345678\n" });
    process.env.HOME = scratch("lp-home-");
    const refused = await h.run(["catalog", "--path", repo, "--write"], "thr_pm");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/owner at a terminal/);
    expect(readCatalog(repo)).toEqual([]);
    const out = await h.run(["catalog", "--path", repo, "--write"]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(readCatalog(repo).find((card) => card.path === ".env")).toMatchObject({ skipped: "secret", headLine: "" });
  });
});
