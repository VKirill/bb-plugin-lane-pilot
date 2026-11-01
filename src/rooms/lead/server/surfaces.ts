import type { JevSettings } from "@lane-pilot/jev";
import { answerDecision, askDecision, type Db } from "./journal";

/**
 * The two surfaces of the first release (roadmap §2.4): a task's landing word (the attempt waits in finish.ts, the PM or a screen records
 * the owner's yes or no) and a phase's turn (the driver asks on «Ждут владельца», `word()` records). Both are a yes or a no, so the
 * options are fixed; later surfaces (the owner list's actions, permits, rule proposals) bring their own.
 */
export const WORD_OPTIONS = ["yes", "no"] as const;
const clip = (text: string | undefined, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? "");

export const wordDecisionId = (runId: string, family: string) => `words:${runId}:${family}`;
export const phaseDecisionId = (phaseId: string, turn: string, wave?: number) => `phase:${phaseId}:${turn}${wave !== undefined ? `:${wave}` : ""}`;

export type WordTask = { title: string; risk?: string; objective?: string; invariants?: readonly string[] };

export function wordSituation(task: WordTask, family: string): Record<string, unknown> {
  return { question: "land this verified task on main?", task: clip(task.title, 300), risk: task.risk ?? null, objective: clip(task.objective, 600), invariants: (task.invariants ?? []).slice(0, 6), family };
}

/** finish.ts: the attempt starts waiting for the word. */
export const askTaskWord = (db: Db, input: { runId: string; projectId: string; family: string; task: WordTask }, settings?: JevSettings, now?: number) =>
  askDecision(db, { id: wordDecisionId(input.runId, input.family), surface: "words", class: "landing", risk: input.task.risk ?? null, projectId: input.projectId, runId: input.runId,
    situation: wordSituation(input.task, input.family), options: WORD_OPTIONS }, settings, now);

/** lane_pilot_queue word, the task_word RPC: the owner's word is recorded. */
export const answerTaskWord = (db: Db, runId: string, family: string, decision: "yes" | "no", text: string, by: string, now?: number) => {
  try { answerDecision(db, wordDecisionId(runId, family), { option: decision, text }, by, now); } catch { /* journal only */ }
};

export type WordPhase = { id: string; projectId: string; runId: string | null; title: string; goal: string; stage: string };

export function phaseSituation(phase: WordPhase, turn: string, wave: number | undefined, ask: string): Record<string, unknown> {
  return { question: `the owner's word at ${turn}${wave !== undefined ? ` (wave ${wave})` : ""}`, phase: clip(phase.title, 300), goal: clip(phase.goal, 600), stage: phase.stage, ask: clip(ask, 600) };
}

/** The phase driver: a turn asks for the word (the same moment it posts on «Ждут владельца»). */
export const askPhaseWord = (db: Db, phase: WordPhase, turn: string, wave: number | undefined, ask: string, settings?: JevSettings, now?: number) =>
  askDecision(db, { id: phaseDecisionId(phase.id, turn, wave), surface: "phase", class: "process", projectId: phase.projectId, runId: phase.runId,
    situation: phaseSituation(phase, turn, wave, ask), options: WORD_OPTIONS }, settings, now);

export const answerPhaseWord = (db: Db, phaseId: string, turn: string, wave: number | undefined, decision: "yes" | "no", text: string, by: string, now?: number) => {
  try { answerDecision(db, phaseDecisionId(phaseId, turn, wave), { option: decision, text }, by, now); } catch { /* journal only */ }
};
