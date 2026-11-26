import { isServiceNoticeText } from "./service-notice";

export const INTAKE_KINDS = ["heavy", "small", "batch", "process", "question", "consent", "reply", "service"] as const;
export const SERVICE_KINDS = ["status", "current", "cancel", "results"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Lane Pilot's own notices, other threads' messages and system frames are not the owner's request. */
// The end notice of a workflow run (pm-notice.ts) too: read as the owner's request, each one started another issue-quick, whose own end notice
// started the next (live 2026-10-26, Vampirism Fire: wfrun_400875d6… → wfrun_71f91820… → …, every one «too vague»).
const MACHINE_TEXT = [/^\s*\[bb message from/i, /^\s*<task-notification/i, /^\s*\[system/i, /^\s*Workflow run wfrun_[\w-]+ of /i,
  // pmPrompt() is recorded by BB as source=spawn, initiator=user, too: its activation instruction is not an owner's goal.
  /^\s*You are the Lane Pilot PM(?:\. Do not write production code yourself\.| in the selected role\.)\r?\nRun id: lprun_[\w-]+\./,
];
// Lane Pilot's own notices come from the shared classifier: exact machine templates only, so a genuine owner line that
// starts with the plugin's name («Lane Pilot, исправь …») stays an owner message (the old /^lane pilot\b/ swallowed it).
export const isMachineMessage = (text: string) => isServiceNoticeText(text) || MACHINE_TEXT.some((pattern) => pattern.test(text));

/** The last owner request of a PM chat as the intake read it. */
export type IntakeRecord = {
  requestId: string;
  kind: IntakeKind;
  by: "rules" | "jev";
  phaseId: string | null;
  at: number;
  hinted?: boolean;
  /** The small-task graph the machine started for the request (issue-quick): the PM does not dispatch it by hand. */
  wfRunId?: string;
  /** The workflow architect's chat the machine started to build a process the request described. */
  architectThreadId?: string;
  /** A published graph the request matched: the PM is told to run it, and no architect builds a second one. */
  hint?: { graphId: string; confidence: number };
};

export type HandOverStarted = { started: true; via: "phase" | "issue-quick" | "issue-batch" | "issue-full" | "full-lifecycle"; id: string };
export type HandOverResult = HandOverStarted | { started: false; kind: IntakeKind | null; reason: string };

/** Structural port for the PM intake classifier and hand-over service used by tools, lead, and schedules. */
export interface PhaseIntake {
  take(threadId: string): Promise<IntakeRecord | null>;
  dispatchRefusal(threadId: string, options?: { hint?: boolean }): Promise<string | null>;
  launchRefusal(threadId: string): Promise<string | null>;
  classify(text: string): Promise<{ kind: IntakeKind; by: "rules" }>;
  handOver(input: { projectId: string; pmThreadId: string; runId: string; text: string; key: string; origin: string }): Promise<HandOverResult>;
}
