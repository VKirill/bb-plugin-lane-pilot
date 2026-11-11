import { phaseWordItemKey } from "./word-item";
import type { DrawingCritique } from "@lane-pilot/contracts";
import { bestEffort } from "@lane-pilot/kit";
import { designGate, phaseFolder } from "../logic";
import { archiveDrawing } from "../stages";
import { savePhase } from "../store";
import { PhaseRefusal } from "./driver-tools";
import type { MethodsTools } from "./driver-methods";
import type { ReturnToInput } from "./driver-methods-control";
import type { Phase, PhaseRecord } from "../logic";

type Reported = { phaseId: string; by?: string };
export type DrawingInput = Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string; critique?: DrawingCritique; lesson?: string };
export type GoalAuditInput = Reported & { state: "met" | "unmet"; by: string; summary: string; points?: Array<{ id: string; met: boolean; evidence?: string }> };
export type LessonsInput = Reported & { analysis: string; reviewRun: string; reviewerNode?: string };

/** The design stage and the close: a drawing with its contract, the goal audit of the blind verdict, and the reviewed lessons. */
export function installDesignMethods(tools: MethodsTools, deps: { returnTo: (input: ReturnToInput) => Phase }) {
  const { ctx, db, now, reactions } = tools;
  const { mustGet, book, move, readText, writeDocs } = tools;
  const { returnTo } = deps;

  async function drawing(input: DrawingInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);
    const folder = `${phaseFolder(phase.id)}/design/`;
    const outside = input.paths.filter((path) => !path.startsWith(folder) || path.includes(".."));
    if (outside.length) throw new PhaseRefusal(`the drawing lives in its own folder ${folder}`, outside.map((path) => `${path} is outside it`));
    const drawn: import("../logic").Drawing = { paths: input.paths.slice(0, 30), sha256: await tools.drawingSha(phase, input.paths.slice(0, 30)), designer: input.designer, feasible: input.feasible, ...(input.contradiction ? { contradiction: input.contradiction } : {}), ...(input.reviewer ? { reviewer: input.reviewer } : {}) };
    // The previous contract to the archive: a replaced drawing stays in the record with its hash.
    const archived = archiveDrawing(phase.record, drawn);
    if (archived.length > (phase.record.design?.archived?.length ?? 0)) book(phase, "design", "archived", `previous drawing ${phase.record.design!.drawing!.sha256.slice(0, 12)} (${phase.record.design!.drawing!.paths.join(", ")}) archived`);
    const record: PhaseRecord = { ...phase.record, design: { ...(phase.record.design ?? { decision: "needed", why: "" }), drawing: drawn, archived } };
    // SMA pc_contract: a redrawn drawing (another sha) voids the owner's earlier design yes.
    if (drawn.sha256 !== phase.record.design?.drawing?.sha256 && record.words) record.words = record.words.filter((word) => word.turn !== "design");
    if (input.critique) {
      const why = reactions.critiqueProblems(input.critique);
      if (why.length) throw new PhaseRefusal("the drawing critique form is not filled", why);
      // A rework without the goal–obstacle–question form is accepted as before; the book says the form was not filled.
      if (input.critique.verdict === "rework" && !input.critique.goal && !input.critique.obstacle && !input.critique.question) book(phase, "design", "critique", "critique form not filled");
      // A role_line continuation is the designer's role line; a set_case one keeps the form and its verdict for later checks of the judge.
      if (input.critique.continuation?.kind === "role_line" && !input.lesson?.trim()) await reactions.addRoleLine(phase.projectId, "design-lead", reactions.roleLine(input.critique.continuation.lesson));
      if (input.critique.continuation?.kind === "set_case")
        await reactions.storeCritiqueCase({ drawingSha: drawn.sha256, form: input.critique, expectedVerdict: input.critique.verdict });
    }
    // The design measurement journal: one line per drawing; first pass = the first drawing of the phase, feasible, and passed by its critic.
    await reactions.journalDrawing({ at: now(), projectId: phase.projectId, phaseId: phase.id, designer: input.designer, reviewer: input.reviewer ?? null, drawingSha: drawn.sha256,
      firstPass: archived.length === 0 && input.feasible && (input.critique ? input.critique.verdict === "pass" : true), critique: input.critique ?? null, codeScore: null, ownerWord: null });
    if (input.lesson?.trim()) await reactions.addRoleLine(phase.projectId, "design-lead", reactions.roleLine(input.lesson));
    book(phase, "design", "drawing", `${input.paths.join(", ")} by ${input.designer}; ${input.feasible ? "feasible" : `contradiction: ${input.contradiction ?? "?"}`}${input.reviewer ? `; reviewed by ${input.reviewer}` : ""}`);
    if (!input.feasible) {
      savePhase(db, phase.id, { record, at: now() });
      return returnTo({ phaseId: phase.id, to: "planning", note: `the drawing contradicts the plan: ${input.contradiction ?? "no reason given"}`, by: input.designer });
    }
    // SMA p3_requirements: the contract is read, not only named — every required section has its heading in UI-SPEC.md.
    const specPath = drawn.paths.find((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path));
    const specText = specPath ? await readText(phase, specPath) : null;
    const check = designGate(record, specText);
    if (!check.ok) {
      savePhase(db, phase.id, { record, at: now() });
      if (record.ownerWords && check.why.length === 1 && check.why[0]!.includes("owner's word")) return mustGet(phase.id);
      throw new PhaseRefusal("the drawing is not confirmed", check.why);
    }
    record.design = { ...record.design!, confirmedAt: now() };
    // SMA k_wd_c1: the drawing and its contract are committed by their explicit manifest paths (best effort — a failed
    // commit does not stop the phase, it is only booked). k_wd_version: paths the new drawing dropped get a one-line stub
    // at the old address pointing to the new file; the previous bytes stay at the drawing's own commit.
    const committed = await tools.commitFiles(phase, drawn.paths, `phase ${phase.id}: drawing and UI contract`);
    // The sha goes on the drawing itself, so the archived edition keeps it (SMA k_wd_version).
    if (committed.commit) {
      drawn.commit = committed.commit;
      book(phase, "design", "drawing_committed", `the drawing and its contract committed (${committed.commit.slice(0, 12)}): ${drawn.paths.join(", ")}`);
    } else book(phase, "design", "drawing_commit_failed", "the drawing could not be committed (no writer host or git refused): the phase goes on, the files are only hashed");
    const previous = phase.record.design?.drawing;
    if (previous) {
      const dropped = previous.paths.filter((path) => !drawn.paths.includes(path));
      // The old file is replaced by a link only when its bytes are in a commit: an uncommitted edition stays as it is.
      if (dropped.length && !previous.commit) book(phase, "design", "drawing_kept", `${dropped.join(", ")} stay as they are: the previous drawing has no commit to keep their bytes`);
      if (dropped.length && previous.commit) {
        const note = `Superseded by ${drawn.paths.join(", ")}; previous bytes at commit ${previous.commit}`;
        await bestEffort(ctx.log, "phase drawing superseded", writeDocs(phase, dropped.map((path) => ({ path, content: `${note}\n` })), `phase ${phase.id}: old drawing addresses link to the new one`), null);
        book(phase, "design", "drawing_superseded", `${dropped.join(", ")} now point to the new drawing; their bytes stay at commit ${previous.commit}`);
      }
    }
    move(phase, "execution", { ...record, design: { ...record.design!, drawing: drawn } }, "the drawing is feasible and reviewed by a separate role");
    return mustGet(phase.id);
  }
  function goalAudit(input: GoalAuditInput): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "verification" || !phase.record.verification?.verdict) throw new PhaseRefusal("no blind verdict to audit yet");
    // SMA k_wv_design: the audit's verdict on each drawing contract point merges into the points read at verification.
    const judged = new Map((phase.record.designPoints === true ? input.points ?? [] : []).map((point) => [point.id, point]));
    const points = (phase.record.designPoints === true ? phase.record.verification?.points ?? [] : []).map((point) => { const hit = judged.get(point.id); return hit ? { ...point, met: hit.met === true, ...(hit.evidence ? { evidence: hit.evidence.slice(0, 300) } : {}) } : point; });
    const record: PhaseRecord = { ...phase.record, verification: { ...phase.record.verification, ...(points.length ? { points } : phase.record.verification?.points ? { points: phase.record.verification.points } : {}), model: { state: input.state, by: input.by, summary: input.summary.slice(0, 2000), at: now() } } };
    book(phase, "verification", "goal_audit", `${input.by}: ${input.state} — ${input.summary}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function lessons(input: LessonsInput): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "lessons") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not lessons`);
    const analysis = input.analysis.slice(0, 4000);
    const read = tools.reviewerRead(phase, input.reviewRun, input.reviewerNode ?? "stage", analysis);
    if ("why" in read) throw new PhaseRefusal("the lessons are not proven read by their reviewer", [read.why]);
    const text = `Phase «${phase.title}» lessons: ${analysis}`.slice(0, 2000);
    const record: PhaseRecord = { ...phase.record, lessons: { ...(phase.record.lessons ?? { needed: true, why: "" }), analysis, author: read.author, reviewer: read.reviewer, reviewedHash: read.inputSha, reviewRun: input.reviewRun, at: now(),
      ...(phase.record.ownerWords ? { draft: { text, stagedAt: now(), state: "staged" as const } } : {}) } };
    book(phase, "lessons", "analysis", `${analysis} (by ${read.author}, read by ${read.reviewer} in ${input.reviewRun}, input ${read.inputSha.slice(0, 12)})`);
    if (phase.record.ownerWords) {
      // Lesson is a draft (SMA p7_staged): it waits for the person's word in drafts; the phase does not wait for it.
      book(phase, "lessons", "staged", "the lesson waits as a draft for the owner's word «lesson»");
      reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, "lesson"), source: "phase", kind: "word", projectId: phase.projectId,
        what: `Этап «${phase.title}» завершён: записать его урок в память проекта?`, why: text.slice(0, 600) });
      reactions.askPhaseWord(phase, "lesson", undefined, text);
    } else tools.writeLesson(phase, text);
    move(phase, "closed", record, "the lessons are written and reviewed");
    // State «closed» comes only after finishClosed writes the closing documents and reads them back intact (SMA ta_closed).
    return mustGet(phase.id);
  }

  return { drawing, goalAudit, lessons };
}
