import { isWholeConsent } from "../../tasks";
import { INTAKE_KINDS, SERVICE_KINDS, isMachineMessage, type IntakeKind, type ServiceKind } from "../../contracts";

export { INTAKE_KINDS, SERVICE_KINDS, isMachineMessage, type IntakeKind, type ServiceKind };

/** Above this many characters a message the rules cannot place is taken as heavy: a goal, not a fix. */
export const HEAVY_LENGTH = 700;

/**
 * A one-line request the LP database alone can answer: the status, what runs now, the latest results, a cancel. Short lines only:
 * a long message that mentions «status» is a task.
 */
const SERVICE_RULES: Array<[ServiceKind, RegExp]> = [
  ["cancel", /^(?:отмени|останови|cancel|stop)\s+(?:задач[а-яё]*|task)\s+\S+[\s.!]*$/i],
  ["current", /^(?:что (?:сейчас )?(?:идёт|идет|выполняется|в работе)|what(?:'s| is) (?:running|in progress)(?: now)?)[\s?.!]*$/i],
  ["results", /^(?:покажи (?:последние )?результаты|что (?:уже )?(?:готово|сделано)|show (?:the )?(?:latest |last )?results)[\s?.!]*$/i],
  ["status", /^(?:статус|status|как дела|как успехи|how(?:'s| is) it going)[\s?.!]*$/i],
];
export function serviceByRules(text: string): ServiceKind | null {
  const clean = text.trim();
  if (clean.includes("\n") || clean.length > 80) return null;
  return SERVICE_RULES.find(([, pattern]) => pattern.test(clean))?.[0] ?? null;
}

/** What the code settles alone; `confident: false` means the length rule only guessed and no machine start follows. */
export function intakeByRules(text: string): { kind: IntakeKind; confident: boolean; service?: ServiceKind } {
  const clean = text.trim();
  if (isWholeConsent(clean)) return { kind: "consent", confident: true };
  const service = serviceByRules(clean);
  if (service) return { kind: "service", confident: true, service };
  // One line that ends with «?» is a question at any length (ph_82dfc9db78, 2026-10-31: «Есть предложения как улучшить дизайн… на
  // телефонах?», 135 characters, went to the judgment, was read as heavy); a short request is small.
  if (!clean.includes("\n") && clean.endsWith("?")) return { kind: "question", confident: true };
  if (clean.length <= 80 && !clean.includes("\n")) return { kind: "small", confident: false };
  return { kind: clean.length > HEAVY_LENGTH ? "heavy" : "small", confident: false };
}

/** The one goal a user intake run is for: the owner's request, guessed from the message. A user workflow will not close verified without it. */
export function intakeRunGoals(text: string): Array<{ id: "request"; done_when: string; evidence: string; guess: true }> {
  const title = text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) || "Owner's request";
  return [{ id: "request", done_when: `The owner's request is done: ${title}`.slice(0, 600), evidence: "the workflow output status is closed and its comment says what changed", guess: true }];
}

/** A title from the owner's words: the first line, at most 80 characters. */
export function intakeTitle(text: string): string {
  const first = text.trim().split("\n").find((line) => line.trim())?.trim() ?? "Цель владельца";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** What the dispatch tool tells a PM the first time it hands out the work of a request that is a new process (SMA: processes become small graphs). */
export function processHint(): string {
  return "This request of the owner is a new process: a routine the system should run again and again. In Matvey's system a new process becomes a small graph, not one-off code: " +
    "suggest the Workflow architect, or draft it yourself with lane_pilot_workflow_draft (action get, patch, test); publishing waits for the owner's yes; then run it with lane_pilot_route. " +
    "If the request is in fact one-off work, dispatch it again: this hint is given once per request.";
}

/** The PM's note when the owner's process is a graph the catalog already has: run that one, no new graph is built. */
export function publishedHint(found: { graphId: string; name: string; confidence: number }): string {
  return `[Lane Pilot intake] The owner's request matches the published graph ${found.graphId} («${found.name}», router confidence ${found.confidence}). No workflow architect was started for it. If it fits, start it (lane_pilot_route with the owner's words, then lane_pilot_run_workflow {workflowId: \"${found.graphId}\"}); if it does not, say why and build a new one (lane_pilot_forge).`;
}
