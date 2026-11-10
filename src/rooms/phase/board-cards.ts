import { taskFamily } from "@lane-pilot/contracts";
import { getTask, listRunAttemptStates, listStageStatesForRun, type LanePilotDatabase } from "../storage";
import { designGate, discussionGate, nextAction, planGate, type Phase, type TaskFact } from "./logic";
import { listPhases } from "./store";

/** The board's phase row: identical in shape to a runs `BoardItem` (SMA m_sw_unit_card); runs builds the deck, phase
 * deals its own cards — the import edge stays phase→runs and the room cycle does not appear. */
export type PhaseBoardItem = {
  kind: "phase"; key: string; runId: string; taskId: null;
  title: string; techTitle: string; taskKind: null; area: null; objective: string | null;
  projectId: string | null; pmThreadId: string | null;
  column: "queued" | "running" | "checking" | "blocked" | "done"; state: string;
  phase: "planning" | "writing" | "checking" | "blocked" | "closed";
  stage: null; model: null; since: null;
  waitingFor: []; detail: string | null; attemptNo: 0; threadId: null; attemptId: null; updatedAt: number;
  held: false;
  /** The {ok, why} of the discussion, plan and design gates (SMA d_state). */
  gates: Array<{ name: "discussion" | "plan" | "design"; ok: boolean; why: string[] }>;
  /** The current wave out of the plan's waves («волна N из M»); null while the phase has no plan. */
  wave: { n: number; m: number } | null;
};

const clip = (text: string | null | undefined, max = 240) => (text ? text.replace(/\s+/g, " ").trim().slice(0, max) : null);
const piecesOf = (items: readonly { id: string; wave: number }[], wave: number) => items.filter((item) => item.wave === wave);

/** The phase driver's facts, read-only (the same read the driver does in driver-docs.ts): the latest attempt of each
 * issued piece and its check receipts. */
function pieceFacts(db: LanePilotDatabase, phase: Phase): Map<string, TaskFact> {
  const out = new Map<string, TaskFact>();
  const issued = phase.record.execution?.issued ?? {};
  if (!phase.runId) return out;
  const attempts = listRunAttemptStates(db, phase.runId);
  // Only the columns the card shows: stage states, never the result bodies.
  const receipts = listStageStatesForRun(db, phase.runId, ["plan-fact", "verification", "code-critique", "browser-qa"]);
  for (const [pieceId, taskId] of Object.entries(issued)) {
    const family = taskFamily(taskId);
    const mine = attempts.filter((row) => taskFamily(row.task_id) === family);
    const latestTask = mine.at(-1)?.task_id ?? taskId;
    const stage = (id: string) => (receipts.find((row) => row.taskId === latestTask && row.stageId === id)?.state ?? null) as TaskFact["planFact"];
    const contract = getTask(db, latestTask)?.contract as { qa_cases?: unknown[] } | undefined;
    out.set(pieceId, { taskId: latestTask, state: mine.at(-1)?.state ?? null, planFact: stage("plan-fact"), verification: stage("verification"), codeCritique: stage("code-critique") as TaskFact["codeCritique"], browserQa: stage("browser-qa"), qaPlanned: Array.isArray(contract?.qa_cases) && contract.qa_cases.length > 0 });
  }
  return out;
}

/** The one gate the card may show: the unmet gate of the phase's current stage; a closed phase and the later stages show none. */
function currentGate(phase: Phase): PhaseBoardItem["gates"] {
  if (phase.state === "closed") return [];
  const named = phase.stage === "discussion" ? { name: "discussion" as const, result: discussionGate(phase.record) }
    : phase.stage === "planning" ? { name: "plan" as const, result: planGate(phase.record) }
    : phase.stage === "design" ? { name: "design" as const, result: designGate(phase.record) } : null;
  return named && !named.result.ok ? [{ name: named.name, ok: false, why: named.result.why }] : [];
}

const reported = new Set<string>();

/** A project's live and recently-done phases as board cards: the column is the stage, the detail is the next step. One
 * broken phase record is skipped (and reported once through `onError`), never the whole board. */
export function phaseBoardCards(db: LanePilotDatabase, input: { projectId: string | null; doneSince: number; limit?: number; onError?: (message: string) => void }): PhaseBoardItem[] {
  const out: PhaseBoardItem[] = [];
  for (const phase of listPhases(db, { ...(input.projectId ? { projectId: input.projectId } : {}), limit: input.limit ?? 100 })) {
    if (phase.state === "closed" && phase.updatedAt < input.doneSince) continue;
    try {
      out.push(cardOf(db, phase));
    } catch (cause) {
      const message = `phase ${phase.id} left off the board: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (!reported.has(message)) { reported.add(message); input.onError?.(message); }
    }
  }
  return out;
}

function cardOf(db: LanePilotDatabase, phase: Phase): PhaseBoardItem {
  const facts = pieceFacts(db, phase);
  const column: PhaseBoardItem["column"] = phase.state === "closed" ? "done"
    : phase.state === "paused" || phase.state === "pause_requested" || phase.state === "stopped" ? "blocked"
    : phase.stage === "execution" ? "running"
    : phase.stage === "verification" || phase.stage === "acceptance" || phase.stage === "lessons" ? "checking" : "queued";
  const boardPhase: PhaseBoardItem["phase"] = phase.state === "closed" ? "closed"
    : column === "blocked" ? "blocked"
    : column === "running" ? "writing" : column === "checking" ? "checking" : "planning";
  const items = phase.record.plan?.items ?? [];
  const waves = [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);
  const issued = phase.record.execution?.issued ?? {};
  const current = waves.find((wave) => piecesOf(items, wave).some((item) => issued[item.id] && facts.get(item.id)?.state !== "accepted"))
    ?? waves.find((wave) => piecesOf(items, wave).some((item) => !issued[item.id])) ?? waves.at(-1);
  return {
    kind: "phase", key: `phase:${phase.id}`, runId: phase.runId ?? phase.id, taskId: null,
    title: phase.title, techTitle: phase.id, taskKind: null, area: null, objective: clip(phase.goal, 160),
    projectId: phase.projectId, pmThreadId: phase.pmThreadId, column, state: phase.state, phase: boardPhase,
    stage: null, model: null, since: null, waitingFor: [], detail: clip(nextAction(phase, facts).text, 160),
    attemptNo: 0, threadId: null, attemptId: null, updatedAt: phase.updatedAt, held: false,
    gates: currentGate(phase),
    wave: waves.length && current !== undefined ? { n: waves.indexOf(current) + 1, m: waves.length } : null,
  };
}
