export type CriticStats = {
  stage: string; runs: number; approved: number; blocked: number; skipped: number; blockShare: number | null;
  /** What became of a blocked task: a later dispatch of it was accepted, sent again without acceptance, or never sent again. */
  afterBlock: { fixedAndAccepted: number; sentAgainNotAccepted: number; dropped: number };
  /** Approved tasks that later failed on a contract mistake the critic is there to catch. */
  missed: { count: number; examples: Array<{ taskId: string; reason: string }> };
  /** Share of tasks accepted on their first attempt, reviewed by this critic or not. */
  firstTryAccepted: { reviewed: { tasks: number; share: number | null }; notReviewed: { tasks: number; share: number | null } };
  /** How often the verdict predicted the outcome (accepted as-is, redone, or rolled back), overall and per model. */
  calibration: CriticCalibration;
};

/** A stage with at least this many labeled verdicts and under half of them right is a weak critic. */
export const CRITIC_CALIBRATION_MIN = 4;

export type CriticCalibration = {
  labeled: number; hits: number; accuracy: number | null; low: boolean;
  byModel: Array<{ model: string; labeled: number; hits: number; accuracy: number | null; low: boolean }>;
};
