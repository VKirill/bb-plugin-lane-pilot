import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";
import { isWholeConsent } from "../tasks";

/**
 * Rails by default (SMA: the one-turn engine and «every heavy request goes through the phase graph»). Matvey's machine reads the
 * owner's message before any model does: a whole-message «yes», a question, a small job and a heavy goal take different roads,
 * and a heavy goal is driven by the daemon through the phase, the orchestrator only switched on at its turns. Here the code
 * settles what it can (a consent, a short message) and Jev the rest; without Jev a long message is heavy.
 */
export const INTAKE_KINDS = ["heavy", "small", "batch", "question", "consent"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Lane Pilot's own notices, other threads' messages and system frames are not the owner's request. */
const MACHINE_TEXT = [/^\s*\[?lane pilot\b/i, /^\s*\[bb message from/i, /^\s*<task-notification/i, /^\s*\[system/i, /^\s*\[lane pilot phase\]/i];
export const isMachineMessage = (text: string) => MACHINE_TEXT.some((pattern) => pattern.test(text));

const CONSENT = /^(да|ага|угу|ок|окей|ok|okay|yes|yep|го|гоу|давай|делай|согласен|согласна|принято|подтверждаю|поехали|\+|\+\+)[\s.!)]*$/i;
/** Above this many characters a message the judgment could not read is taken as heavy: a goal, not a fix. */
export const HEAVY_WITHOUT_JEV = 700;

/** What the code settles alone; `confident: false` goes to Jev. */
export function intakeByRules(text: string): { kind: IntakeKind; confident: boolean } {
  const clean = text.trim();
  if (isWholeConsent(clean) || CONSENT.test(clean)) return { kind: "consent", confident: true };
  if (clean.length <= 80 && !clean.includes("\n")) return { kind: clean.endsWith("?") ? "question" : "small", confident: true };
  return { kind: clean.length > HEAVY_WITHOUT_JEV ? "heavy" : "small", confident: false };
}

export const INTAKE_JUDGMENT_ID = "intake.weight";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const intakeJudgment = defineJudgment<{ text: string }, { kind: IntakeKind }>({
  id: INTAKE_JUDGMENT_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ owner_message: clip(input.text, 4_000) }),
  questions: () => ({
    weight: choice(
      "The owner wrote `owner_message` to the project manager of a software project. What kind of request is it? Judge by the work it asks for, not by its length or tone.",
      {
        heavy: "A goal that needs several tasks that depend on each other, a design or architecture decision, a new feature or section, a redesign, a migration, or work whose result has to be planned and accepted as a whole.",
        small: "One concrete change a single task can make: a fix, a tweak, a copy or style edit, one page or one endpoint.",
        batch: "A list of several independent small fixes or edits, each one task, none needing a plan.",
        question: "A question or a request for information, a report or a status; it asks for no change to the project.",
        consent: "Agreement, a yes, an approval of what was proposed, or a short go-ahead.",
      },
    ),
  }),
  thresholds: {
    min_p: { default: 0.55, min: 0.4, max: 0.95, about: "least probability of the chosen kind" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "weight");
    if (!pick || pick.p < t.min_p!) return { decision: { kind: "small" } };
    return { decision: { kind: (INTAKE_KINDS as readonly string[]).includes(pick.top) ? (pick.top as IntakeKind) : "small" } };
  },
  fallback: () => ({ kind: "small" }),
  describe: (decision) => decision.kind,
});

/** A phase title from the owner's words: the first line, at most 80 characters. */
export function intakeTitle(text: string): string {
  const first = text.trim().split("\n").find((line) => line.trim())?.trim() ?? "Цель владельца";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** What the dispatch tool tells a PM that tries to hand out a heavy request's work by hand. */
export function railsRefusal(phase: { id: string; title: string; stage: string }, next: string): string {
  return `This request of the owner is a phase on rails: Lane Pilot opened phase ${phase.id} «${phase.title}» (stage ${phase.stage}) for it. ` +
    `Its pieces are issued by the phase once the plan is admitted, not dispatched by hand. Do the stage's step now: ${next} ` +
    `(lane_pilot_phase). If the owner's request is in fact one small task, close the phase in words (lane_pilot_phase {action:"close", phaseId, words}) and dispatch it.`;
}
