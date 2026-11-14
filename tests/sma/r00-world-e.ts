// Region 0 (Phase graph), batch e: the lessons stage (n120 … n129) and the phase control work (n130 … n139, n132 is another batch's). Every observation runs the REAL code of the node
// (the phase driver on a scratch database and a fake host, the auto stages with a fake engine, the real workflow engine on workflows/retrospective.json) and returns plain JSON.
// tests/sma/four-proofs-r00-e.test.ts asserts on it and the scene scripts/lp_drill/scenes/sma_r00_e.py proves the nodes that write no hub row. No model, no hub write, nothing outside the machine.
import { sha256Hex } from "@lane-pilot/kit";
import { renderBook, type PhaseRecord } from "../../src/rooms/phase/logic";
import { AUTO_WORKFLOWS, autoDue, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { listParts } from "../../src/rooms/phase/store";
import { runSim } from "../workflow/chain-harness";
import { drv, pure } from "./r00-world-c";

type Drv = Awaited<ReturnType<typeof drv>>;
const withDrv = async <T>(o: Parameters<typeof drv>[0], run: (f: Drv) => Promise<T>): Promise<T> => { const f = await drv(o); try { return await run(f); } finally { f.restore(); } };
export const ANALYSIS = "The plan missed the empty-cell case; a check per promise would have caught it.";
const refusal = (run: () => unknown): { message: string; why: string[] } | null => {
  try { run(); return null; } catch (cause) { return { message: cause instanceof Error ? cause.message : String(cause), why: ((cause as { why?: string[] })?.why) ?? [] }; }
};
const memory = (f: Drv) => (f.db.prepare("SELECT kind, audience, content, concepts_json AS concepts FROM lane_pilot_memory WHERE project_id='projA'").all() as Array<{ kind: string; audience: string; content: string; concepts: string }>)
  .map((row) => ({ kind: row.kind, audience: row.audience, content: row.content, concepts: JSON.parse(row.concepts) as string[] }));

/** A finished retrospective in the journal: «stage» (the reviewer) was handed `handoff` by «retro» (the author) in sessions of their own. */
export function seedRetro(db: Drv["db"], runId: string, opts: { handoff?: string; author?: string; reviewer?: string; project?: string; badHash?: boolean; noStage?: boolean } = {}) {
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(runId, "retrospective", 1, "sha", "{}", opts.project ?? "projA", "succeeded", 1, 1);
  if (opts.noStage) return "";
  const input = JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: "retro#1", fromThreadId: opts.author ?? "thr_retro", handoff: opts.handoff ?? ANALYSIS } });
  const receipt = JSON.stringify({ executor: "agent", inputSha256: opts.badHash ? sha256Hex("other") : sha256Hex(input), threadId: opts.reviewer ?? "thr_stage" });
  db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(runId, "stage#1", "stage#1", "stage", 1, "succeeded", input, receipt, 1, 2, 2);
  return sha256Hex(input);
}
const atLessons = (f: Drv) => f.seed("lessons", { lessons: { needed: true, why: "a return" } });
const bookOf = (f: Drv, kind: string) => listParts(f.db, f.id).filter((part) => part.kind === kind).map((part) => part.text);

export const observe = {
  /** n120, n121 · the driver's pass starts the retrospective for a phase at lessons with a run and no analysis, handed the run, and holds nothing else back. */
  async lessonsStart() {
    const at = pure({ lessons: { needed: true, why: "a return" } } as PhaseRecord, "lessons");
    const started: Array<{ workflow: { id?: string }; inputs: Record<string, unknown> }> = [];
    let record = at.record;
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: { resolveWorkflow: (id: string) => ({ id }), start: (input: { workflow: { id?: string }; inputs: Record<string, unknown> }) => { started.push(input); return { runId: "wfrun_r", done: new Promise(() => undefined) }; }, get: () => undefined } as never,
    }, { api: {} as never, get: () => ({ ...at, record }), save: (_id: string, next: PhaseRecord) => { record = next; }, book: () => undefined, runtime: () => ({}), pmIdle: async () => true, now: () => 1 } as never);
    const stepped = await auto.step(at);
    return { due: autoDue(at), withAnalysis: autoDue(pure({ lessons: { needed: true, why: "x", analysis: "a" } } as PhaseRecord, "lessons")), noRun: autoDue({ ...at, runId: null }), stepped,
      workflow: started[0]?.workflow.id ?? null, runId: started[0]?.inputs.run_id ?? null, auto: record.auto?.kind ?? null, wfRunId: record.auto?.wfRunId ?? null };
  },

  /** n121 · the retrospective command: the real graph reads the run, stages the insights for the reviewer's step and ends done with what it staged. */
  async retro() {
    const r = await runSim("retrospective", { input: { run_id: "r-sample" }, stubs: { retro: { insights: [{ id: "INS-1a2b3c4d" }, { id: "INS-5e6f7a8b" }], retro_path: "retro/r-sample.md" }, stage: { staged: 2 } } });
    return { path: r.path, output: r.summary.output as Record<string, unknown>, status: r.summary.status, roles: ["retro", "stage"].map((id) => (r.workflow.nodes.find((node) => node.id === id) as { role?: string } | undefined)?.role ?? null) };
  },

  /** n120, n122, n123, n125 · an analysis read by a reviewer of another session closes the phase: the row keeps its trigger and gains the analysis, its author, its reviewer, the hash and the run; the pipeline writes the note. */
  async lessonsDone() {
    return withDrv({}, async (f) => {
      atLessons(f);
      const measured = seedRetro(f.db, "wf_read");
      const closed = f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
      const row = closed.record.lessons!;
      return { stage: closed.stage, row: { needed: row.needed, why: row.why, analysis: row.analysis, author: row.author, reviewer: row.reviewer, reviewRun: row.reviewRun, hash: row.reviewedHash === measured, draft: row.draft ?? null },
        analysisPart: bookOf(f, "analysis"), memory: memory(f), measured12: measured.slice(0, 12) };
    });
  },

  /** n122, n123, n124 · the lessons are taken only from a run whose reviewer was a session of its own, in this phase's project, measured on these exact bytes: each other run is refused in its own words and writes nothing. */
  async lessonsRefused() {
    return withDrv({}, async (f) => {
      atLessons(f);
      seedRetro(f.db, "wf_other", { project: "OTHER" });
      seedRetro(f.db, "wf_elsewhere", { handoff: "Another analysis the reviewer read." });
      seedRetro(f.db, "wf_self", { reviewer: "thr_retro" });
      seedRetro(f.db, "wf_forged", { badHash: true });
      seedRetro(f.db, "wf_nostage", { noStage: true });
      const out: Record<string, { message: string; why: string[] } | null> = {};
      for (const run of ["wf_none", "wf_other", "wf_elsewhere", "wf_self", "wf_forged", "wf_nostage"]) out[run] = refusal(() => f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: run }));
      return { out, stage: f.get().stage, analysis: f.get().record.lessons?.analysis ?? null, memory: memory(f).length };
    });
  },

  /** n125, n126 · with the owner's word on, the lesson is a draft: nothing is in memory until his yes writes it through the door; a no declines it and writes nothing. */
  async lessonDraft() {
    return withDrv({ words: true }, async (f) => {
      atLessons(f);
      seedRetro(f.db, "wf_read");
      const closed = f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
      const staged = { stage: closed.stage, draft: closed.record.lessons?.draft, memory: memory(f).length, parts: bookOf(f, "staged") };
      const applied = await f.phases.word({ phaseId: f.id, turn: "lesson", decision: "yes", text: "да", by: "owner via screen" });
      const after = { draft: applied.record.lessons?.draft?.state, memory: memory(f), parts: bookOf(f, "lesson_applied") };
      return { staged: { ...staged, draft: { state: staged.draft?.state, text: staged.draft?.text } }, after };
    });
  },
  async lessonDeclined() {
    return withDrv({ words: true }, async (f) => {
      atLessons(f);
      seedRetro(f.db, "wf_read");
      f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
      const declined = await f.phases.word({ phaseId: f.id, turn: "lesson", decision: "no", text: "нет", by: "owner via screen" });
      return { state: declined.record.lessons?.draft?.state, memory: memory(f).length, parts: bookOf(f, "lesson_declined"), applied: bookOf(f, "lesson_applied") };
    });
  },

  /** n127, n129, n128 · a refused memory write is booked with the door's words and the draft stays staged with its error; a later pass finishes that same lesson, with no new analysis. */
  async lessonRefused() {
    return withDrv({ words: true }, async (f) => {
      atLessons(f);
      seedRetro(f.db, "wf_read");
      f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
      f.db.exec("CREATE TRIGGER lp_memory_closed BEFORE INSERT ON lane_pilot_memory BEGIN SELECT RAISE(ABORT, 'memory door closed'); END");
      const refused = await f.phases.word({ phaseId: f.id, turn: "lesson", decision: "yes", text: "да", by: "owner via screen" });
      const draft = refused.record.lessons?.draft;
      const mid = { state: draft?.state, error: draft?.error ?? null, memory: memory(f).length, parts: bookOf(f, "memory_refused"), applied: bookOf(f, "lesson_applied") };
      const book = renderBook(f.get(), listParts(f.db, f.id));
      f.db.exec("DROP TRIGGER lp_memory_closed");
      const idleBefore = memory(f).length;
      const tick = await f.phases.tick();
      const done = f.get().record.lessons;
      const lessonsSection = renderBook(f.get(), listParts(f.db, f.id)).split("## 8. Lessons")[1]!.split("## 9.")[0]!.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.replace(/^- \S+ \S+ /, "")).slice(0, 4);
      return { mid, idleBefore, moved: tick.moved, after: { state: done?.draft?.state, error: done?.draft?.error ?? null, memory: memory(f), analysis: done?.analysis, applied: bookOf(f, "lesson_applied") },
        bookHasRefusal: book.includes("**memory_refused** — the memory door refused the lesson: "), lessonsSection };
    });
  },

  /** n128 · the lessons section of the book carries the analysis, the staged draft and a refusal in their order, each with its kind and words, and the chain stays intact. */
  async bookSection() {
    return withDrv({ words: true }, async (f) => {
      atLessons(f);
      seedRetro(f.db, "wf_read");
      f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
      const text = renderBook(f.get(), listParts(f.db, f.id));
      const section = text.split("## 8. Lessons")[1]!.split("## 9.")[0]!;
      const heads = text.split("\n").filter((line) => line.startsWith("## "));
      return { heads, lines: section.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.replace(/^- \S+ \S+ /, "")), chain: /chain: intact \((\d+) parts\)/.exec(text)?.[0] ?? null,
        otherSection: text.split("## 7. Acceptance")[1]!.split("## 8.")[0]!.includes("analysis") };
    });
  },
};
export { AUTO_WORKFLOWS };
