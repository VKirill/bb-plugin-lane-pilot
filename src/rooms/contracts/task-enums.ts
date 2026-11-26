/** Shared value domains of task contracts: who started the task, and how hard the code critic looks at it. */
/** `lead`: a task of work the lead («Штурман») handed over. It runs under the project's PM chat but is not that chat's work. */
export const BIRTH_KINDS = ["pm", "workflow", "backlog", "redo", "lead"] as const;
export type BirthKind = (typeof BIRTH_KINDS)[number];

/**
 * The birth kind chooses the gates: the topic-loop guard protects against the PM's repeated tries, not the backlog's.
 */
export const BIRTH_GATES: Record<Exclude<BirthKind, "redo">, { promise: "warn" | "skip"; topicLoop: boolean; drawing: boolean }> = {
  pm: { promise: "warn", topicLoop: true, drawing: true },
  lead: { promise: "warn", topicLoop: true, drawing: true },
  backlog: { promise: "warn", topicLoop: false, drawing: true },
  workflow: { promise: "warn", topicLoop: true, drawing: true },
};
/** The gates of a birth: a redo gets the promise and drawing gates of the birth it redoes; the topic-loop guard never stops a
 *  redo — the machine issued it, and a refused redo leaves its task with nobody to send it again. */
export function birthGates(birth: BirthKind | string | null | undefined, redone?: BirthKind | string | null) {
  const kind = birth === "redo" ? (redone ?? "pm") : (birth ?? "pm");
  const gates = BIRTH_GATES[(kind as Exclude<BirthKind, "redo">) in BIRTH_GATES ? (kind as Exclude<BirthKind, "redo">) : "pm"];
  return birth === "redo" ? { ...gates, topicLoop: false } : gates;
}

export const CODE_CRITIC_DEFAULTS = ["off", "medium", "high"] as const;
export type CodeCriticDefault = (typeof CODE_CRITIC_DEFAULTS)[number];

export const isCodeCriticDefault = (value: unknown): value is CodeCriticDefault => (CODE_CRITIC_DEFAULTS as readonly unknown[]).includes(value);
