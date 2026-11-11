import { designMode, motionRows, openQuestions, uiContractGap } from "../stages";
import { gate, type GateResult } from "./gates";
import { DRAWING_SECTIONS, DRAWING_SYSTEM_SECTIONS, type Phase, type PhaseRecord, type PlanItem } from "./record";
import { wordOf } from "./words";

const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(ui|components|pages|screens|views)\//i;

/** Where a phase keeps its own files in the project: the book, and the drawing in design/ (SMA: The phase has a home, Drawing in its own folder). */
/**
 * Why a withdraw of these pieces would be refused now, or null when it would go through (SMA d_batch_decide). Asked by the driver before it
 * changes anything and by the phase card before it shows «Убрать»: the phase is open, at planning or execution, every piece is in the plan, none is issued.
 */
export function withdrawProblem(phase: Pick<Phase, "id" | "state" | "stage" | "record">, pieces: readonly string[]): string | null {
  if (phase.state === "closed" || phase.state === "stopped") return `phase ${phase.id} is ${phase.state}: a piece leaves the plan only while the phase is open`;
  if (phase.stage !== "planning" && phase.stage !== "execution") return `phase ${phase.id} is at ${phase.stage}: a piece leaves the plan at planning or execution`;
  const plan = phase.record.plan;
  if (!plan) return "no plan to withdraw from";
  const unknown = pieces.filter((id) => !plan.items.some((item) => item.id === id));
  if (unknown.length) return `no piece ${unknown.join(", ")} in the plan of phase ${phase.id}: nothing is changed`;
  const issued = pieces.filter((id) => phase.record.execution?.issued[id]);
  if (issued.length) return "issued pieces are canceled, not withdrawn";
  return null;
}

export const phaseFolder = (phaseId: string) => `.agents/phases/${phaseId}`;

/** What the drawing must cover (SMA p3_requirements): the base sections always, c4 and the event chain for system or mixed work. */
export function drawingRequirements(mode?: "screens" | "system" | "mixed"): string[] {
  return [...DRAWING_SECTIONS, ...(mode === "system" || mode === "mixed" ? DRAWING_SYSTEM_SECTIONS : [])];
}

/** Is a drawing needed: a piece that changes a screen (UI files) needs one; the PM can ask for one on any plan. */
export function designDecision(items: readonly PlanItem[], asked?: boolean): { decision: "needed" | "not_needed"; why: string; mode?: "screens" | "system" | "mixed"; motion?: string[]; requirements?: string[] } {
  const extra = { mode: designMode(items), motion: motionRows(items) };
  if (asked) return { decision: "needed", why: "the PM asked for a drawing", ...extra, requirements: drawingRequirements(extra.mode) };
  const ui = items.filter((item) => (Array.isArray(item.task.owns_paths) ? item.task.owns_paths as string[] : []).some((path) => UI_PATH.test(path)));
  return ui.length ? { decision: "needed", why: `pieces that change screens: ${ui.map((item) => item.id).join(", ")}`, ...extra, requirements: drawingRequirements(extra.mode) } : { decision: "not_needed", why: "no piece changes a screen" };
}

/** Design → execution: the drawing exists, an answer on feasibility, and a reviewer other than the designer saw it. */
export function designGate(record: PhaseRecord, specText?: string | null): GateResult {
  const design = record.design;
  if (!design) return { ok: false, why: ["the design decision is not made"] };
  if (design.decision === "not_needed") return { ok: true };
  const drawing = design.drawing;
  const why: string[] = [];
  if (!drawing?.paths.length) why.push("no drawing: the designer draws the screens into the phase's design folder and names the files");
  else {
    if (drawing.feasible === undefined) why.push("no feasibility answer: feasible, or the contradiction with the plan");
    if (drawing.feasible === false) why.push(`the drawing contradicts the plan: ${drawing.contradiction ?? "no reason given"} — return the phase to planning`);
    if (!drawing.reviewer) why.push("the drawing is not reviewed by a separate role");
    else if (drawing.reviewer === drawing.designer) why.push("the reviewer of the drawing is its designer: it must be a separate role");
  }
  const contract = uiContractGap(record, specText);
  if (contract) why.push(contract);
  why.push(...openQuestions(record, "design").map((question) => `open question ${question.id}: ${question.text}`));
  // Drawing confirmed (SMA tb_design_gate_confirmed): the person's yes counts only for the drawing hash it names; a redraw asks again.
  if (record.ownerWords) {
    const said = wordOf(record, "design");
    // The word carries the hash under `key` (the door's own stamp) or `sha` (the version stamp of pc_contract): either
    // one that differs from the drawing now voids the yes. A yes recorded before words were stamped carries neither
    // and keeps counting — a phase in flight is not asked twice for what its owner already confirmed.
    const signed = said?.key ?? said?.sha;
    if (said?.decision !== "yes" || (signed !== undefined && signed !== drawing?.sha256)) why.push("the drawing awaits the owner's word for this drawing (owner.words is on)");
  }
  return gate(why);
}
