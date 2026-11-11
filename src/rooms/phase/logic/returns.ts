import { PHASE_STAGES, type PhaseRecord, type PhaseStage, type WordTurn } from "./record";

/** The stages a return to `to` makes stale: everything after it is decided again. */
export function staleAfterReturn(to: PhaseStage, record: PhaseRecord): PhaseRecord {
  const next: PhaseRecord = { ...record };
  const order = PHASE_STAGES.indexOf(to);
  // The signed documents are kept aside: back at discussion they are the PM's or the owner's correction to sign again, not a reason to analyse anew.
  if (order <= PHASE_STAGES.indexOf("discussion")) { if (next.context) next.signedBefore = { docs: next.context.docs.map((doc) => doc.path), risks: next.context.risks, decisions: next.context.decisions, appetite: next.context.appetite, noGos: next.context.noGos }; delete next.context; }
  if (order <= PHASE_STAGES.indexOf("planning") && next.plan) next.plan = { ...next.plan, critique: undefined, admittedSha: undefined, admittedAt: undefined };
  // Back at discussion the plan rounds start over: the round limit's own refusal sends the phase there, and with the count kept the
  // phase stayed wedged for good (ph_82dfc9db78, 2026-10-31: «returned it, the counter did not reset»).
  if (order <= PHASE_STAGES.indexOf("discussion") && next.plan) next.plan = { ...next.plan, rounds: 0 };
  if (order <= PHASE_STAGES.indexOf("design")) delete next.design;
  if (order <= PHASE_STAGES.indexOf("execution")) { delete next.verification; delete next.acceptance; }
  delete next.lessons;
  const later = (stage: string) => PHASE_STAGES.indexOf(stage as PhaseStage) >= order;
  // The issue and wave words are execution turns: a return to (or before) execution revokes them, so a new scope needs a new
  // permission (SMA bi_revise). Before this mapping they matched no stage and survived every return.
  const stageOfTurn = (turn: WordTurn) => turn === "context" ? "discussion" : turn === "uat" ? "acceptance" : turn === "lesson" ? "lessons" : turn === "issue" || turn === "wave" ? "execution" : turn;
  if (next.words) next.words = next.words.filter((word) => !later(stageOfTurn(word.turn)));
  // A return to execution takes the preparation back too (SMA px_return_exec): the candidate's frozen heads and goal check
  // belong to the verdict it now leaves; every piece's issued contract print is withdrawn, so each is issued again as the
  // next redo of its family — execution queues one attempt higher.
  if (to === "execution") {
    if (next.candidate) next.candidate = { ...next.candidate, verified: undefined, goal: undefined };
    if (next.execution?.issuedSha) next.execution = { ...next.execution, issuedSha: Object.fromEntries(Object.keys(next.execution.issuedSha).map((id) => [id, "returned"])) };
  }
  return next;
}
