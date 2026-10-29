import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";
import { isWholeConsent } from "../tasks";

/**
 * Rails by default (SMA: the one-turn engine and «every heavy request goes through the phase graph»). Matvey's machine reads the
 * owner's message before any model does: a whole-message «yes», a question, a small job and a heavy goal take different roads,
 * and a heavy goal is driven by the daemon through the phase, the orchestrator only switched on at its turns. Here the code
 * settles what it can (a consent, a short message) and Jev the rest; without Jev a long message is heavy.
 */
export const INTAKE_KINDS = ["heavy", "small", "batch", "process", "question", "consent", "reply"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Lane Pilot's own notices, other threads' messages and system frames are not the owner's request. */
// The end notice of a workflow run (pm-notice.ts) too: read as the owner's request, each one started another issue-quick, whose own end notice
// started the next (live 2026-10-26, Vampirism Fire: wfrun_400875d6… → wfrun_71f91820… → …, every one «too vague»).
const MACHINE_TEXT = [/^\s*\[?lane pilot\b/i, /^\s*\[bb message from/i, /^\s*<task-notification/i, /^\s*\[system/i, /^\s*\[lane pilot phase\]/i, /^\s*Workflow run wfrun_[\w-]+ of /i,
  // pmPrompt() is recorded by BB as source=spawn, initiator=user, too: its activation instruction is not an owner's goal.
  /^\s*You are the Lane Pilot PM(?:\. Do not write production code yourself\.| in the selected role\.)\r?\nRun id: lprun_[\w-]+\./,
];
export const isMachineMessage = (text: string) => MACHINE_TEXT.some((pattern) => pattern.test(text));

const CONSENT = /^(да|ага|угу|ок|окей|ok|okay|yes|yep|го|гоу|давай|делай|согласен|согласна|принято|подтверждаю|поехали|\+|\+\+)[\s.!)]*$/i;
/** Above this many characters a message the judgment could not read is taken as heavy: a goal, not a fix. */
export const HEAVY_WITHOUT_JEV = 700;

/** What the code settles alone; `confident: false` goes to Jev. */
export function intakeByRules(text: string): { kind: IntakeKind; confident: boolean } {
  const clean = text.trim();
  if (isWholeConsent(clean) || CONSENT.test(clean)) return { kind: "consent", confident: true };
  // A short line is settled only as a question; a short request goes to the judgment (it may be a remark, not a job).
  if (clean.length <= 80 && !clean.includes("\n") && clean.endsWith("?")) return { kind: "question", confident: true };
  if (clean.length <= 80 && !clean.includes("\n")) return { kind: "small", confident: false };
  return { kind: clean.length > HEAVY_WITHOUT_JEV ? "heavy" : "small", confident: false };
}

export const INTAKE_JUDGMENT_ID = "intake.weight";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const intakeJudgment = defineJudgment<{ text: string; previous?: string | null }, { kind: IntakeKind }>({
  id: INTAKE_JUDGMENT_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  // The PM's last words in the chat: «sign in yourself» is a reply to the PM's question about a sign-in, not a new task (live 2026-10-25).
  stateBuilder: (input) => ({ owner_message: clip(input.text, 4_000), ...(input.previous ? { pm_last_message: clip(input.previous, 1_500) } : {}) }),
  questions: () => ({
    weight: choice(
      "The owner wrote `owner_message` to the project manager of a software project. What kind of request is it? Judge by the work it asks for, not by its length or tone.",
      {
        heavy: "A goal that needs several tasks that depend on each other, a design or architecture decision, a new feature or section, a redesign, a migration, or work whose result has to be planned and accepted as a whole.",
        small: "One concrete change a single task can make: a fix, a tweak, a copy or style edit, one page or one endpoint.",
        batch: "A list of several independent small fixes or edits, each one task, none needing a plan.",
        process: "A new recurring routine or way of working the system itself should run again and again: a pipeline, a regular job, a checklist to repeat for every new item, «each time X do Y», «every week …».",
        question: "A question or a request for information, a report or a status; it asks for no change to the project.",
        consent: "Agreement, a yes, an approval of what was proposed, or a short go-ahead.",
        reply: "A reply about work already under way in this chat (`pm_last_message` shows what): an answer to the PM's question, a permission or an instruction for a helper or task that is running, a correction of how it does it, or a remark, complaint or feedback on how the work goes («why do you ask me?», «it takes too long»). It asks for no new piece of work.",
      },
    ),
  }),
  thresholds: {
    min_p: { default: 0.55, min: 0.4, max: 0.95, about: "least probability of the chosen kind" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "weight");
    // Unsure is not a job: «small» here started a build on remarks the judgment could not place (live 2026-10-26: 8 of 13 issue-quick
    // runs of one chat ended «too vague»). A reply starts nothing; the PM reads the message in its turn.
    if (!pick || pick.p < t.min_p!) return { decision: { kind: "reply" } };
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

/** What the dispatch tool tells a PM the first time it hands out the work of a request that is a new process (SMA: processes become small graphs). */
export function processHint(): string {
  return "This request of the owner is a new process: a routine the system should run again and again. In Matvey's system a new process becomes a small graph, not one-off code: " +
    "have the forge write it as a workflow (lane_pilot_forge {action:\"draft\", kind:\"workflow\", name, brief}), lint it when the Creator's task is accepted, and enable it; then run it with lane_pilot_route. " +
    "If the request is in fact one-off work, dispatch it again: this hint is given once per request.";
}
