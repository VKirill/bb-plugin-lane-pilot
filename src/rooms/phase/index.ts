// Public API of phase: the migrations, the rails (stages, gates, returns, acceptance lines, the next action) and the book (the driver is behind ./server).
export { phaseMigrations } from "./migrations";
export {
  ACCEPTANCE_LINES, BOOK_SECTIONS, GENESIS, PHASE_STAGES, RETURN_STAGES, acceptanceLines, blindVerdict, brokenLink, canonical, contextSignature, designDecision,
  designGate, discussionGate, executionGate, issuable, lessonsNeeded, nextAction, partHash, phaseFolder, pieceProblems, planGate, planSignature, renderBook, staleAfterReturn, waveProblems,
} from "./logic";
export type { AcceptanceLine, BookPart, BookSection, ContextDoc, FrozenVerdict, GateResult, NextAction, Phase, PhaseRecord, PhaseStage, PhaseState, PlanItem, TaskFact } from "./logic";
export { getPhase, listParts, listPhases } from "./store";
export { intakeJudgment, isMachineMessage, pathClassJudgment } from "./intake";
