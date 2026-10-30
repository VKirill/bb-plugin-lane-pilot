import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { memoryRecordId } from "../packages/memory-core/src";
import { buildEvalDb, planCorpus, syntheticCopy } from "../src/rooms/memory-eval/server/corpus";
import { classify, fileKey, folderKey } from "../src/rooms/memory-eval/server/questions";
import { createRetrievers } from "../src/rooms/memory-eval/server/retrievers";
import { formatEvalReport, runMemoryEval, score, stat } from "../src/rooms/memory-eval/server/memory-eval";
import { exportEvalExtract, loadEvalData, type EvalData, type RawNote, type RawQuestion } from "../src/rooms/memory-eval/server/source";
import { runMemoryEvalCommand } from "../src/rooms/memory-eval/server/command";
import { writerMemoryPicks } from "../src/rooms/writer/writer-brief";
import { SHELF_CONFIGS, durabilityScore, formatShelf, pickThree, replayShelf, runShelfReplay } from "../src/rooms/memory-eval/server/shelf";

// SMA block 4 «Next» (P2-7): retrieval measured on real accepted tasks, with questions whose right answer is nothing.
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

// The id is the one the write door gives the content, as on the hub (the shelf replay stores through that door).
const note = (n: number, content: string, over: Partial<RawNote> = {}): RawNote => ({ id: memoryRecordId("P", "note", content), projectId: "P", kind: "note", content, concepts: ["area"], createdAt: T0 + n * 1000,
  status: "active", trust: "confirmed", origin: "maintainer", useCount: 0, acceptedCount: 0, sections: [], audience: "subagent", personalBot: "", ...over });
const task = (n: number, produced: string[], title: string, owns = produced): RawQuestion => ({ attemptId: `att${n}`, taskId: `task${n}`, projectId: "P", startedAt: T0 + DAY * 2 + n * 1000, attemptNo: 1,
  produced, picked: [], task: { title, objective: `${title} in the project`, acceptance: [], owns_paths: owns, read_first: [] } });

/** Twelve folders each with one note, a task per folder that touches it (positive), and eight tasks on folders no note names (negative). */
function data(): EvalData {
  const notes: RawNote[] = [], questions: RawQuestion[] = [];
  for (let n = 0; n < 12; n++) {
    notes.push(note(n, `The ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"][n]} screen is built in apps/web/zone${n}/panel${n}.vue and keeps its state in a store.`));
    questions.push(task(n, [`apps/web/zone${n}/panel${n}.vue`], `Change the ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"][n]} screen`));
  }
  for (let n = 12; n < 20; n++) questions.push(task(n, [`apps/api/area${n}/handler${n}.ts`], `Rework handler number ${n}`));
  // A task whose folder is mentioned by a note that names another file: neither positive nor negative.
  notes.push(note(30, "Only the sibling apps/web/zone3/other3.vue lives next to it."));
  questions.push(task(21, ["apps/web/zone3/panel3b.vue"], "Touch the neighbour"));
  return { notes, questions, origin: "extract" };
}
const options = { skipProjects: new Set<string>(), skipTask: () => false, now: T0 + 30 * DAY };

describe("questions and gold", () => {
  it("names a file and a folder the way the writer's brief anchors a path", () => {
    expect(fileKey("apps/web/zone1/panel1.vue")).toBe("zone1/panel1.vue");
    expect(fileKey("package.json")).toBeNull();
    expect(folderKey("apps/web/zone1/panel1.vue")).toBe("web/zone1");
    expect(folderKey("apps/web/zone1/")).toBe("web/zone1");
  });

  it("a task is positive when an earlier note names a file it produced, negative when no earlier note names a file or folder, otherwise left out", () => {
    const { notes, questions } = data();
    const kinds = questions.map((question) => classify(question, notes)?.kind ?? "skip");
    expect(kinds.slice(0, 12)).toEqual(Array(12).fill("positive"));
    expect(kinds.slice(12, 20)).toEqual(Array(8).fill("negative"));
    expect(kinds[20]).toBe("skip");
  });

  it("a note written after the task started is not its answer", () => {
    const { notes, questions } = data();
    const late = [...notes, note(9999, "The alpha screen apps/web/zone0/panel0.vue was rewritten.", { createdAt: questions[0]!.startedAt + 5 })];
    expect(classify(questions[0]!, late)!.gold.map((item) => item.id)).toEqual([notes[0]!.id]);
  });

  it("a task that produced nothing nameable asks nothing", () => {
    expect(classify(task(1, ["README.md"], "Docs"), data().notes)).toBeNull();
  });
});

describe("the corpus", () => {
  it("holds the gold notes of its positives, none for its negatives, and pads with copies that name no touched file", () => {
    const plan = planCorpus({ data: data(), size: 30, seed: 1, scope: "pile", ...options });
    expect(plan.notes).toHaveLength(30);
    expect(plan.composition.synthetic).toBeGreaterThan(0);
    const positives = plan.questions.filter((question) => question.kind === "positive");
    const negatives = plan.questions.filter((question) => question.kind === "negative");
    expect(positives.length).toBeGreaterThan(3);
    expect(negatives.length).toBeGreaterThan(3);
    expect(plan.questions.filter((question) => question.kind === "offtopic")).toHaveLength(6);
    for (const question of positives) expect(question.gold.length).toBeGreaterThan(0);
    for (const question of negatives) expect(question.gold).toEqual([]);
    const copy = syntheticCopy(data().notes[0]!, 1);
    expect(copy.content).toContain("apps-s1/web-s1/zone0-s1/panel0.vue");
    expect(copy.id).not.toBe(data().notes[0]!.id);
    const ids = new Set(plan.notes.map((item) => item.id));
    for (const question of positives) for (const id of question.gold) expect(ids.has(id)).toBe(true);
  });

  it("is repeatable for a seed", () => {
    const a = planCorpus({ data: data(), size: 30, seed: 3, ...options });
    const b = planCorpus({ data: data(), size: 30, seed: 3, ...options });
    expect(a.notes.map((item) => item.id)).toEqual(b.notes.map((item) => item.id));
    expect(a.questions.map((item) => item.id)).toEqual(b.questions.map((item) => item.id));
  });

  it("indexes the corpus like the write door, in the project scope or one pile", () => {
    for (const scope of ["project", "pile"] as const) {
      const plan = planCorpus({ data: data(), size: 30, seed: 1, scope, ...options });
      const db = buildEvalDb(plan);
      const counted = db.prepare("SELECT count(*) n FROM lane_pilot_memory").get() as { n: number };
      expect(counted.n).toBe(30);
      expect((db.prepare("SELECT count(DISTINCT project_id) n FROM lane_pilot_memory").get() as { n: number }).n).toBe(scope === "pile" ? 1 : 1);
      const retrievers = createRetrievers(db, plan.notes);
      const question = plan.questions.find((item) => item.kind === "positive")!;
      const excluded = new Set(plan.notes.filter((item) => item.createdAt >= question.startedAt).map((item) => item.id));
      const plain = retrievers.find((item) => item.id === "plain")!.run(question, excluded);
      expect(plain.ids.length).toBeGreaterThan(0);
      expect(plain.why?.get(plain.ids[0]!)).toMatch(/^names /);
      expect(plain.ids.some((id) => question.gold.includes(id))).toBe(true);
      db.close();
    }
  });
});

describe("scoring", () => {
  const rows = (items: Array<{ kind: "positive" | "negative" | "offtopic"; gold?: string[]; area?: string[]; ids: string[] }>) => items.map((item, index) => ({
    question: { id: `q${index}`, kind: item.kind, projectId: "P", taskId: `q${index}`, startedAt: 0, query: "", text: { title: "", objective: "", acceptance: [] }, scope: "P",
      paths: { owns_paths: [], read_first: [] }, produced: [], gold: item.gold ?? [], area: item.area ?? [] }, ids: item.ids, ms: 1 }));
  const kindOf = (id: string) => id.startsWith("core") ? "core" as const : "note" as const;

  it("counts hits, precision, recall within k, nearby notes and false hits apart from core", () => {
    const result = score({ id: "x", production: true, group: "writer", k: 3 }, rows([
      { kind: "positive", gold: ["g1", "g2"], area: ["n1"], ids: ["g1", "n1", "z", "g2"] },
      { kind: "positive", gold: ["g3"], ids: ["z"] },
      { kind: "negative", ids: [] },
      { kind: "negative", ids: ["core1"] },
      { kind: "offtopic", ids: ["a"] },
    ]), kindOf);
    expect(result.hit.mean).toBe(0.5);
    expect(result.precision.mean).toBeCloseTo((1 / 3 + 0) / 2);
    expect(result.recall.mean).toBeCloseTo((1 / 2 + 0) / 2);
    expect(result.nearby.mean).toBeCloseTo((1 / 3) / 2);
    expect(result.falseHit.mean).toBeCloseTo(2 / 3);
    expect(result.falseHitNonCore.mean).toBeCloseTo(1 / 3);
    expect(result.offtopicFalseHit.mean).toBe(1);
  });

  it("gives an interval around a mean, and nothing for no questions", () => {
    const value = stat([1, 0, 1, 1, 0, 1, 1, 1, 0, 1]);
    expect(value.mean).toBe(0.7);
    expect(value.lo).toBeLessThanOrEqual(0.7);
    expect(value.hi).toBeGreaterThanOrEqual(0.7);
    expect(stat([])).toEqual({ mean: 0, lo: 0, hi: 0, n: 0 });
  });
});

describe("a run", () => {
  it("reports every retriever at every size, and the plain baseline finds what the production writer path finds on a clean corpus", async () => {
    const report = await runMemoryEval(data(), { sizes: [30, 60], seed: 1, scope: "pile", ...options });
    expect(report.sizes.map((size) => size.size)).toEqual([30, 60]);
    for (const size of report.sizes) {
      expect(size.scores.map((row) => row.id)).toEqual(["writer", "plain", "pm", "search", "search+floor", "plain-keyword", "reviewer"]);
      const writer = size.scores.find((row) => row.id === "writer")!, plain = size.scores.find((row) => row.id === "plain")!;
      expect(writer.hit.mean).toBeGreaterThan(0.7);
      expect(plain.hit.mean).toBeGreaterThan(0.7);
      expect(plain.falseHitNonCore.mean).toBeLessThan(0.5);
      expect(size.versus).toHaveLength(4);
    }
    const text = formatEvalReport(report);
    expect(text).toContain("== 30 notes");
    expect(text).toContain("plain (plain)");
    expect(text).toContain("false-hit(non-core)");
  });

  it("the writer's picks keep the search's order whatever the usefulness counters say", () => {
    const picks = writerMemoryPicks([
      { id: "best", content: "apps/web/zone1/panel1.vue holds the screen", concepts: [], useCount: 0, acceptedCount: 0 },
      { id: "used", content: "apps/web/zone1/other.vue also lives in web/zone1", concepts: [], useCount: 9, acceptedCount: 9 },
    ], { owns_paths: ["apps/web/zone1/panel1.vue"], read_first: [] });
    expect(picks.map((item) => item.id)).toEqual(["best", "used"]);
  });

  it("skips a near-duplicate so a different note can take a slot", () => {
    const picks = writerMemoryPicks([
      { id: "a", content: "src/rooms widget layout uses the shared panel grid for the settings window", concepts: ["widget", "layout", "panel"] },
      { id: "dup", content: "src/rooms widget layout uses the shared panel grid for the settings window again", concepts: ["widget", "layout", "panel"] },
      { id: "other", content: "src/rooms stores the widget token in settings.ts and nowhere else", concepts: ["token", "settings"] },
      { id: "core", content: "Writers commit through the worktree only", concepts: ["git"], kind: "core" },
    ], { owns_paths: ["src/rooms/widget.ts"], read_first: [] });
    expect(picks.map((item) => item.id)).toEqual(["a", "other", "core"]);
  });
});

describe("the extract and the command", () => {
  it("round-trips the data through an extract file and runs from it", async () => {
    const live = new Database(":memory:");
    live.exec(`CREATE TABLE lane_pilot_memory (id TEXT, project_id TEXT, kind TEXT, content TEXT, concepts_json TEXT, created_at INTEGER, status TEXT, trust TEXT, origin TEXT, use_count INTEGER, accepted_count INTEGER)`);
    const source = data();
    const insert = live.prepare("INSERT INTO lane_pilot_memory VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const row of source.notes) insert.run(row.id, row.projectId, row.kind, row.content, JSON.stringify(row.concepts), row.createdAt, row.status, row.trust, row.origin, 0, 0);
    // The live questions need the run tables; an empty set is a valid, if useless, read.
    for (const statement of ["lane_pilot_attempt (id, run_id, task_id, created_at, attempt_no, state)", "lane_pilot_run (id, project_id)", "lane_pilot_task (id, contract_json)",
      "lane_pilot_stage_receipt (run_id, task_id, stage_id, state, result_json)", "lane_pilot_attempt_reasoning (attempt_id, trace_json)"]) live.exec(`CREATE TABLE ${statement}`);
    expect(loadEvalData(live)).toMatchObject({ origin: "live", questions: [] });
    const path = `${process.env.TMPDIR ?? "/tmp"}/memory-eval-${process.pid}.db`;
    expect(exportEvalExtract(live, path)).toEqual({ notes: source.notes.length, questions: 0 });
    const read = new Database(path, { readonly: true });
    expect(loadEvalData(read)).toMatchObject({ origin: "extract" });
    read.close();
    const failed = await runMemoryEvalCommand(null, ["--sizes", "30"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toMatch(/no data/);
    expect((await runMemoryEvalCommand(null, ["--scope", "galaxy", "--source", path])).stderr).toMatch(/--scope/);
    expect((await runMemoryEvalCommand(null, ["--sizes", "5", "--source", path])).stderr).toMatch(/--sizes/);
  });
});

describe("the shelf replay", () => {
  // Two notes per batch: the one a later task needs, and a filler that names two files (the cap keeps the path-rich one).
  const shelfData = (): EvalData => {
    const source = data();
    const fillers = source.notes.slice(0, 12).map((item, n) => note(100 + n, `Filler about apps/misc/x${n}.ts and apps/misc/y${n}.ts and more text here.`, { createdAt: item.createdAt }));
    return { ...source, notes: [...source.notes, ...fillers] };
  };

  it("replays the history through the write door and finds the answer on the shelf", async () => {
    const result = await replayShelf(shelfData(), { name: "x", order: "relevance", noteBudget: 24000 }, { projects: new Set(), task: () => false });
    expect(result.questions).toBe(12);
    expect(result.goldOnShelf).toBe(1);
    expect(result.hit3).toBeGreaterThan(0.8);
    expect(result.written).toBeGreaterThanOrEqual(24);
  });

  it("a cap writes fewer notes, and a small budget evicts", async () => {
    const skip = { projects: new Set<string>(), task: () => false };
    const [open, capped] = [await replayShelf(shelfData(), { name: "a", order: "relevance", noteBudget: 24000 }, skip), await replayShelf(shelfData(), { name: "b", order: "relevance", noteBudget: 24000, cap: 1 }, skip)];
    expect(capped.written).toBeLessThan(open.written);
    const tiny = await replayShelf(shelfData(), { name: "c", order: "relevance", noteBudget: 40 }, skip);
    expect(tiny.evicted).toBeGreaterThan(0);
    expect(tiny.goldOnShelf).toBeLessThan(1);
  });

  it("reports every configuration as a table", async () => {
    const results = await runShelfReplay(shelfData(), { projects: new Set(), task: () => false }, SHELF_CONFIGS.slice(0, 2));
    expect(formatShelf(results)).toContain("legacy order, budget 8000 (before)");
    expect(durabilityScore({ content: "a/b.ts c/d.ts e/f.ts" })).toBeGreaterThan(durabilityScore({ content: "a/b.ts" }));
    expect(pickThree([], [], "legacy")).toEqual([]);
  });
});
