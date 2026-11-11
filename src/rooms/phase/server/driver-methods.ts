import { installAdmissionMethods } from "./driver-methods-admission";
import { installControlMethods } from "./driver-methods-control";
import { installDesignMethods } from "./driver-methods-design";
import { installInspectMethods } from "./driver-methods-inspect";
import { installWordMethods } from "./driver-methods-words";
import type { DriverBase } from "./driver-tools";
import type { Docs } from "./driver-docs";
import type { Journal } from "./driver-journal";

export type { OpenInput, ContextInput, PlanInput, PlanCheckInput } from "./driver-methods-admission";
export type { DrawingInput, GoalAuditInput, LessonsInput } from "./driver-methods-design";
export type { QuestionInput, AnswerInput, WordInput, WaveReviewInput } from "./driver-methods-words";
export type { WithdrawInput, ReviseInput, CorrectInput, ReturnToInput, SetStateInput, StopInput, StopWaveInput, CancelPieceInput, DecideInput, InterruptInput } from "./driver-methods-control";
export type { CompensateInput, UatLineInput } from "./driver-methods-inspect";

/**
 * The phase's state transitions: every method the PM, the owner or the machine calls to move a phase between its stages, and the
 * gates that admit a plan. Each one reads the phase, checks its gate in code, records the decision in the book and returns the
 * phase as it now is. The side effects on other rooms go through `tools.reactions`.
 */
export type MethodsTools = DriverBase & Docs & Journal;
export type Methods = ReturnType<typeof installMethods>;
export function installMethods(tools: MethodsTools) {
  const admission = installAdmissionMethods(tools);
  const control = installControlMethods(tools);
  const design = installDesignMethods(tools, { returnTo: control.returnTo });
  const words = installWordMethods(tools, { returnTo: control.returnTo, admitIfReady: admission.admitIfReady });
  const inspect = installInspectMethods(tools);
  return { ...admission, ...design, ...words, ...control, ...inspect };
}
