import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJudgeReply } from "../packages/memory-core/src";
import { migrations } from "../src/rooms/migrations";
import { runMemoryEvalCommand } from "../src/rooms/memory-eval/server/command";
import { copyOfDatabase, formatRuler, mergeIntoHub, parseRuler, runRuler, wilson, type RulerOptions } from "../src/rooms/memory-eval/server/ruler";
import { plantSuite, standInEmbedding } from "../src/rooms/memory-eval/server/suite";
import { SUITE_NOTES, SUITE_PACK_NOTES, SUITE_PROJECT } from "../src/rooms/memory-eval/server/suite-fixture";
import { setMemoryJudge, type MemoryJudge } from "../src/rooms/memory/server";
import { setEmbedder } from "../src/rooms/memory/server/embeddings";

afterEach(() => { setMemoryJudge(null); setEmbedder(null); });

const stubEmbedder = async (texts: readonly string[]) => texts.map((text) => standInEmbedding(text.replace(/^task: search result \| query: /, "")));
/** A judge that keeps every candidate in order. */
const stubJudge = (): MemoryJudge => async ({ candidates, settings }) => {
  const chosen = [...candidates];
  return { chosen, receipt: { model: "stub", candidates: candidates.map((r) => r.id), chosen: chosen.map((r) => r.id), latencyMs: 1, tokensIn: 1, tokensOut: 1, ...(settings.mode === "rerank" ? { mode: "rerank" as const } : {}) } };
};
const base: RulerOptions = { vectorMode: "all", doorLock: "off", judgeMode: "filter", pinned: false, judge: "on", scope: "both", runs: 3, limit: 8, parallel: 2, makeJudge: stubJudge, embedder: stubEmbedder };

describe("the ruler", () => {
  it("reads the ruler file: masked text, answerable only with a gold note", () => {
    const rows = parseRuler([
      JSON.stringify({ qid: "q1", project: "P", query: "raw", masked: "masked", label: "answerable", gold: ["n1"] }),
      JSON.stringify({ qid: "q2", project: "P", query: "other", masked: "other", label: "unanswerable", gold: [] }),
      "",
    ].join("\n"));
    expect(rows).toEqual([{ qid: "q1", project: "P", query: "masked", answerable: true, gold: ["n1"] }, { qid: "q2", project: "P", query: "other", answerable: false, gold: [] }]);
    expect(parseRuler(JSON.stringify({ qid: "q1", project: "P", query: "raw", masked: "masked", label: "answerable", gold: ["n1"] }), true)[0]!.query).toBe("raw");
    expect(() => parseRuler("not json")).toThrow(/line 1/);
  });

  it("Wilson interval", () => {
    const [low, high] = wilson(50, 100);
    expect(low).toBeCloseTo(0.404, 2);
    expect(high).toBeCloseTo(0.596, 2);
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(wilson(10, 10)[1]).toBe(1);
  });

  it("runs the plugin's search over a copy: project-only memory misses a note of another project, the whole hub finds it; silence and spread are counted", async () => {
    const planted = plantSuite(migrations, SUITE_NOTES);
    const raw = planted.db as unknown as Database.Database;
    const id = planted.ids.get("queue")!;
    const questions = parseRuler([
      { qid: "a", project: SUITE_PROJECT, masked: "Why did we choose Postgres advisory locks for the order queue instead of Redis?", label: "answerable", gold: [id] },
      { qid: "b", project: "another-project", masked: "Why did we choose Postgres advisory locks for the order queue instead of Redis?", label: "answerable", gold: [id] },
      { qid: "c", project: SUITE_PROJECT, masked: "Which font does the marketing website use for headings?", label: "unanswerable", gold: [] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const dir = mkdtempSync(join(tmpdir(), "ruler-"));
    try {
      const file = join(dir, "hub.db");
      writeFileSync(file, raw.serialize());
      const before = new Database(file, { readonly: true }).prepare("SELECT count(*) AS n, count(DISTINCT project_id) AS p FROM lane_pilot_memory").get();
      const report = await runRuler(() => copyOfDatabase(file), questions, { ...base, runs: 2 });
      const [project, hub] = report.scopes;
      expect(project!.scope).toBe("project");
      expect(hub!.scope).toBe("hub");
      expect(project!.runs).toHaveLength(2);
      // project-only: question a finds its note, question b (another project) cannot
      expect(project!.runs[0]!.delivered).toEqual({ k: 1, n: 2 });
      // whole hub: both find it
      expect(hub!.runs[0]!.delivered).toEqual({ k: 2, n: 2 });
      expect(hub!.runs[0]!.strict3.k).toBe(2);
      expect(hub!.runs[0]!.silence.n).toBe(1);
      expect(hub!.runs[0]!.vectorQuestions).toBe(3);
      const text = formatRuler(report);
      expect(text).toMatch(/project-only memory/);
      expect(text).toMatch(/whole-hub memory/);
      expect(text).toMatch(/delivered\s+50\.0/);
      expect(text).toMatch(/latency ms p50/);
      // the file is the same afterwards: the ruler worked on copies
      expect(new Database(file, { readonly: true }).prepare("SELECT count(*) AS n, count(DISTINCT project_id) AS p FROM lane_pilot_memory").get()).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); raw.close(); }
  });

  it("every combination of the forks runs; the reranker reports the unparsed replies it was given", async () => {
    const planted = plantSuite(migrations, SUITE_PACK_NOTES.maslov);
    const raw = planted.db as unknown as Database.Database;
    const manifest = planted.ids.get("manifest")!, rule = planted.ids.get("rule")!;
    const ruler = parseRuler([
      { qid: "m", project: SUITE_PROJECT, masked: "Where does the ZX-7741 manifest get uploaded?", label: "answerable", gold: [manifest] },
      { qid: "u", project: SUITE_PROJECT, masked: "Which font does the marketing website use for headings?", label: "unanswerable", gold: [] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const buffer = raw.serialize();
    const open = () => new Database(buffer);
    for (const forks of [{ vectorMode: "bridge", doorLock: "literal", judgeMode: "rerank" }, { vectorMode: "bridge", doorLock: "translated", judgeMode: "rerank" }] as const) {
      const report = await runRuler(open, ruler, { ...base, ...forks, runs: 1, scope: "project" });
      const run = report.scopes[0]!.runs[0]!;
      expect(run.delivered, JSON.stringify(forks)).toEqual({ k: 1, n: 1 });
    }
    // today's combination (all vectors, no lock, filter) cannot place a bare identifier among 3000 notes: the ruler reports it, it does not throw
    const today = await runRuler(open, ruler, { ...base, runs: 1, scope: "project" });
    expect(today.scopes[0]!.runs[0]!.delivered.n).toBe(1);
    // the closed door is silence; with the rerank judge the only silence is the lock's
    const locked = await runRuler(open, ruler, { ...base, vectorMode: "bridge", doorLock: "literal", judgeMode: "rerank", runs: 1, scope: "project" });
    expect(locked.scopes[0]!.runs[0]!.silence).toEqual({ k: 1, n: 1 });
    const open2 = await runRuler(open, ruler, { ...base, vectorMode: "bridge", doorLock: "off", judgeMode: "rerank", runs: 1, scope: "project" });
    expect(open2.scopes[0]!.runs[0]!.silence.k).toBe(0);
    // pinned: the rule is delivered to a question with nothing to do with it
    const pinned = await runRuler(open, parseRuler(JSON.stringify({ qid: "r", project: SUITE_PROJECT, masked: "Where does the ZX-7741 manifest get uploaded?", label: "answerable", gold: [rule] })), { ...base, pinned: true, runs: 1, scope: "project" });
    expect(pinned.scopes[0]!.runs[0]!.delivered).toEqual({ k: 1, n: 1 });
    // a judge whose replies cannot be read is counted
    const garbled: MemoryJudge = async ({ candidates }) => ({ chosen: null, receipt: { model: "g", candidates: candidates.map((r) => r.id), chosen: [], latencyMs: 1, tokensIn: 1, tokensOut: 1, fallback: "unparsed", unparsed: 1, mode: "rerank" } });
    const unparsed = await runRuler(open, ruler, { ...base, vectorMode: "bridge", judgeMode: "rerank", makeJudge: () => garbled, runs: 1, scope: "project" });
    expect(unparsed.scopes[0]!.runs[0]!.unparsed.k).toBeGreaterThan(0);
    // and the answer is still the previous order: nothing was lost
    expect(unparsed.scopes[0]!.runs[0]!.delivered).toEqual({ k: 1, n: 1 });
    expect(parseJudgeReply("[1]", 1)).toEqual([1]);
  });

  it("merging into the hub changes the copy only", () => {
    const planted = plantSuite(migrations, SUITE_NOTES);
    const raw = planted.db as unknown as Database.Database;
    mergeIntoHub(raw);
    expect(raw.prepare("SELECT DISTINCT project_id AS p FROM lane_pilot_memory").all()).toEqual([{ p: "hub" }]);
    expect(raw.prepare("SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE project_id='hub'").get()).toEqual({ n: (raw.prepare("SELECT count(*) AS n FROM lane_pilot_memory_fts").get() as { n: number }).n });
    raw.close();
  });

  it("the command needs the files and refuses a bad fork", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ruler-"));
    try {
      const file = join(dir, "r.jsonl");
      writeFileSync(file, JSON.stringify({ qid: "q", project: "P", masked: "x", label: "unanswerable", gold: [] }));
      const io = { read: (path: string) => require("node:fs").readFileSync(path, "utf8") as string, write: () => {} };
      expect((await runMemoryEvalCommand(null, ["--ruler", file], migrations, { io })).stderr).toMatch(/--db/);
      expect((await runMemoryEvalCommand(null, ["--ruler", file, "--db", "x", "--door-lock", "nope"], migrations, { io })).stderr).toMatch(/--door-lock is one of/);
      expect((await runMemoryEvalCommand(null, ["--ruler", file], migrations)).stderr).toMatch(/scripts\/memory-eval/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
