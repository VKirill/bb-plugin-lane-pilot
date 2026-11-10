/** Shared value domains of task contracts: who started the task, and how hard the code critic looks at it. */
/** `lead`: a task of work the lead («Штурман») handed over. It runs under the project's PM chat but is not that chat's work. */
export const BIRTH_KINDS = ["pm", "workflow", "backlog", "phase", "redo", "bench", "lead"] as const;
export type BirthKind = (typeof BIRTH_KINDS)[number];

export const CODE_CRITIC_DEFAULTS = ["off", "medium", "high"] as const;
export type CodeCriticDefault = (typeof CODE_CRITIC_DEFAULTS)[number];

export const isCodeCriticDefault = (value: unknown): value is CodeCriticDefault => (CODE_CRITIC_DEFAULTS as readonly unknown[]).includes(value);
