import { taskFamily } from "@lane-pilot/contracts";
import { getTask, listRunAttemptStates, listStageReceipts, type LanePilotDatabase } from "../storage";
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
const gateOf = (result: { ok: true } | { ok: false; why: string[] }) => (result.ok ? { ok: true as const, why: [] as string[] } : { ok: false as const, why: result.why });

/** The phase driver's facts, read-only (the same read the driver does in driver-docs.ts): the latest attempt of each
 * issued piece and its check receipts. */
function pieceFacts(db: LanePilotDatabase, phase: Phase): Map<string, TaskFact> {
  const out = new Map<string, TaskFact>();
  const issued = phase.record.execution?.issued ?? {};
  if (!phase.runId) return out;
  const attempts = listRunAttemptStates(db, phase.runId);
  const receipts = listStageReceipts(db, phase.runId)
    .filter((row) => ["plan-fact", "verification", "code-critique", "browser-qa"].includes(row.stageId));
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

/** A project's live and recently-done phases as board cards: the column is the stage, the detail is the next step. */
export function phaseBoardCards(db: LanePilotDatabase, input: { projectId: string | null; doneSince: number; limit?: number }): PhaseBoardItem[] {
  const out: PhaseBoardItem[] = [];
  for (const phase of listPhases(db, { ...(input.projectId ? { projectId: input.projectId } : {}), limit: input.limit ?? 100 })) {
    if (phase.state === "closed" && phase.updatedAt < input.doneSince) continue;
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
    out.push({
      kind: "phase", key: `phase:${phase.id}`, runId: phase.runId ?? phase.id, taskId: null,
      title: phase.title, techTitle: phase.id, taskKind: null, area: null, objective: clip(phase.goal, 160),
      projectId: phase.projectId, pmThreadId: phase.pmThreadId, column, state: phase.state, phase: boardPhase,
      stage: null, model: null, since: null, waitingFor: [], detail: clip(nextAction(phase, facts).text, 160),
      attemptNo: 0, threadId: null, attemptId: null, updatedAt: phase.updatedAt, held: false,
      gates: [{ name: "discussion", ...gateOf(discussionGate(phase.record)) }, { name: "plan", ...gateOf(planGate(phase.record)) }, { name: "design", ...gateOf(designGate(phase.record)) }],
      wave: waves.length && current !== undefined ? { n: waves.indexOf(current) + 1, m: waves.length } : null,
    });
  }
  return out;
}
