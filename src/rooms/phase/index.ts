// Public API of phase: the migrations, the rails (stages, gates, returns, acceptance lines, the next action) and the book (the driver is behind ./server).
export { phaseMigrations } from "./migrations";
export {
  ACCEPTANCE_LINES, BOOK_SECTIONS, GENESIS, OBSERVE_WINDOW_MS, PHASE_STAGES, RETURN_STAGES, acceptanceLines, blindVerdict, brokenLink, canonical, contextSignature, designDecision,
  designGate, discussionGate, drawingRequirements, executionGate, issuable, lessonsNeeded, nextAction, observationDue, observationOutcome, partHash, phaseFolder, phaseStageCells, pieceProblems, planGate, planSignature, renderBook, staleAfterReturn, waveProblems,
} from "./logic";
export type { AcceptanceLine, BookPart, BookSection, ContextDoc, FrozenVerdict, GateResult, NextAction, Phase, PhaseObservation, PhaseRecord, PhaseStage, PhaseStageCell, PhaseState, PlanItem, TaskFact } from "./logic";
export { getPhase, listParts, listPhases, listPhasePartsSince, resolvePhaseRef } from "./store";
export { phaseBoardCards } from "./board-cards";
export type { PhaseBoardItem } from "./board-cards";
export { intakeJudgment, isMachineMessage, pathClassJudgment } from "./intake";
export { coverageGaps, oneLine, ownsPathProblems, parkRoadmapRow, quickRow, rubricLine } from "./stages";
