import type { ServerCore, Services } from "../../core/server";
import type { BookSection, JournalStep, Phase, PhaseCandidate, PhaseRecord, PhaseStage, PhaseState, PlanItem, RiskKey, TaskFact, WordTurn } from "../logic";
import type { CandidateTree, createCandidates } from "./candidate";
import type { PhaseReactions } from "./reactions";
import type { DesignJournalLine, DrawingCritique } from "../../design-eval";

export class PhaseRefusal extends Error {
  constructor(message: string, readonly why: string[] = []) { super(message); }
}

/** A stage's name in the owner's words (the rows on «Ждут владельца» and the wall's subject). */
export const STAGE_RU: Record<string, string> = { discussion: "обсуждение", planning: "планирование", design: "проектирование", execution: "исполнение", lessons: "уроки" };

type Reported = { phaseId: string; by?: string };
type CandidateKit = ReturnType<typeof createCandidates>;
type ReviewerRead = { author: string; reviewer: string; inputSha: string } | { why: string };

/**
 * The whole surface the phase driver's pieces share. The driver builds it once (`createPhaseDriver`), the pieces install their
 * functions on it, and every function reaches the others through it — so a piece holds only its own logic and never imports another
 * piece. The external calls (learning, notices, metrics) come in as `reactions`, handed in by the composition root.
 */
export type DriverTools = {
  ctx: ServerCore;
  services: Services;
  db: ServerCore["db"];
  bb: ServerCore["bb"];
  now: () => number;
  reactions: PhaseReactions;

  // ------------------------------------------------------------ shared reads and the book
  mustGet(id: string): Phase;
  savePhase(id: string, patch: { stage?: PhaseStage; state?: PhaseState; record?: PhaseRecord; runId?: string | null; at: number }): void;
  book(phase: Pick<Phase, "id">, section: BookSection, kind: string, text: string): void;
  move(phase: Phase, stage: PhaseStage, record: PhaseRecord, why: string): void;
  facts(phase: Phase): Map<string, TaskFact>;
  readFile(phase: Phase, path: string): Promise<{ sha256: string; sizeBytes: number }>;
  readText(phase: Phase, path: string): Promise<string | null>;
  writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[]; commit: string | null }>;
  writeBook(phase: Phase): Promise<void>;
  redoId(pieceId: string, runId: string | null): string;
  pmCheckoutPath(phase: Phase): Promise<string | null>;
  candidates(phase: Phase): CandidateKit | null;

  // ------------------------------------------------------------ the journal and the learning door
  journalSteps(wfRunId: string): JournalStep[] | null;
  checkerRunBinding(phase: Phase, wfRunId: string, decision: "approve" | "changes_requested"): string | null;
  reviewerRead(phase: Phase, runId: string, node: string, analysis: string): ReviewerRead;
  writeLesson(phase: Phase, text: string): string | null;
  settleLesson(phase: Phase, decision: "yes" | "no"): void;

  // ------------------------------------------------------------ state transitions
  open(input: { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean }): Promise<Phase>;
  context(input: Reported & { docs: string[]; risks?: Partial<Record<RiskKey, string>>; requirements?: string[]; decisions?: string[]; appetite?: string; noGos?: string[] }): Promise<Phase>;
  plan(input: Reported & { items: PlanItem[]; design?: boolean; alreadyMet?: string; fromRun?: string }): Phase;
  planCheck(input: Reported & { decision: "approve" | "changes_requested"; by: string; summary?: string; wfRunId?: string }): Promise<Phase>;
  drawing(input: Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string; critique?: DrawingCritique; lesson?: string }): Promise<Phase>;
  goalAudit(input: Reported & { state: "met" | "unmet"; by: string; summary: string }): Phase;
  lessons(input: Reported & { analysis: string; reviewRun: string; reviewerNode?: string }): Phase;
  question(input: Reported & { text: string; blocking: boolean }): Phase;
  answer(input: Reported & { questionId: string; answer: string }): Phase;
  word(input: Reported & { turn: WordTurn; decision: "yes" | "no"; text: string; wave?: number; useful?: boolean; limits?: boolean; key?: string }): Promise<Phase>;
  waveReview(input: Reported & { wave: number; state: "passed" | "failed"; by: string; summary: string }): Phase;
  withdraw(input: Reported & { pieces: string[]; note: string }): Phase;
  revise(input: Reported & { goal: string; note: string }): Phase;
  correct(input: Reported & { note: string; pieces?: string[] }): Promise<{ phase: Phase; sent: string[] }>;
  returnTo(input: Reported & { to: PhaseStage; note: string }): Phase;
  setState(input: Reported & { state: "pause" | "resume" | "stop" | "close"; words?: string }): Phase;
  stop(input: Reported & { words?: string }): Promise<{ phase: Phase; canceled: string[]; unconfirmed: string[] }>;
  stopWave(input: Reported): Promise<{ phase: Phase; canceled: string[] }>;
  compensate(input: Reported & { note: string }): Promise<{ phase: Phase; results: Array<{ taskId: string; state: string; detail?: string }> }>;
  admitIfReady(phase: Phase): Phase;

  // ------------------------------------------------------------ step execution
  issue(phase: Phase): Promise<Phase>;
  candidateTree(phase: Phase, candidate: PhaseCandidate, base: string): Promise<CandidateTree | null | { wait: string }>;
  candidateGoal(phase: Phase): Promise<PhaseCandidate["goal"] | null>;
  candidateHeads(phase: Phase): Promise<Record<string, string>>;
  landCandidate(phase: Phase): Promise<"landed" | "held">;
  recheckStale(phase: Phase): Promise<void>;
  drive(phase: Phase): Promise<Phase>;
  finishClosed(phase: Phase): Promise<Phase>;
  poke(phase: Phase & { pokedKey?: string | null }): Promise<void>;
  proofCurrency(phase: Phase): Promise<string | null>;
  exhaust(phase0: Phase, input: { kind: "stage" | "replan"; stage: string; why: string }): Promise<void>;
};

export type { DesignJournalLine };
