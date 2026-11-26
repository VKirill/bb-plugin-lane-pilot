/**
 * Pure input shapes needed by the evolution comparison and trial-gating models.
 * Kept independent of storage/room modules so `evolve/models/*` remains runtime-neutral.
 */

export type BenchResult = {
  taskId: string;
  state: "accepted" | "not_accepted" | "error" | "skipped_budget";
  accepted: boolean;
  stagesPassed: number;
  stagesFailed: number;
  tokens: number | null;
  costUsd: number | null;
  costState: "measured" | "partial" | "not_measured";
  seconds: number | null;
  runId?: string;
  position?: number;
  benchTaskId?: string | null;
  lpRunId?: string | null;
  attempts?: number;
  reason?: string | null;
  recordedAt?: number;
};

export type NoiseMetrics = {
  unstableTasks: string[];
  flipShare: number;
  costRel: number | null;
  secondsRel: number | null;
  stagesSlack: number;
  tasks: number;
};

export type NoiseRecord = {
  armA: string;
  armB: string;
  noise: NoiseMetrics;
  id?: string;
  setId?: string;
  createdAt?: number;
};

export type ArmAttempt = {
  taskId: string;
  state: string;
  attemptNo: number;
  arm: "new" | "old";
  blockingFindings: number;
  attemptId?: string;
  createdAt?: number;
};
