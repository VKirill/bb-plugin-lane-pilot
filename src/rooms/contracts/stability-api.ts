import type { FailureClass } from "./failure-class";

export const PARKED_KEY = "stability:parked";

export type ParkedTask = {
  projectId:string; runId:string; taskId:string; pmThreadId:string; klass:FailureClass;
  reason:string; fingerprint:string; version:string; at:number; redrives:number;
  /** When the failed attempt started; a sibling dispatched after it took the task over. */
  since?:number;
};

export type ReconcileResult =
  | { kind:"found"; threadId:string }
  | { kind:"not_found" }
  | { kind:"blocked"; reason:"ambiguous"|"page_cap" }
  | { kind:"error"; message:string };

/** The resume pass over orphaned attempts, implemented by src/rooms/stability (createReconcile). */
export interface ResumeOrphansPort {
  resumeOrphans(projectId?: string, attemptIds?: readonly string[]): Promise<{ resumed:string[]; skipped:string[]; finished:string[] }>;
  /** Re-sends the stop of attempts left `cancel_requested` and ends the ones whose stop is seen (SMA m_confirm_later). */
  recheckCancels(): Promise<string[]>;
}

export interface StabilityPort {
  loadParked(): Promise<ParkedTask[]>;
  dropParked(match: (row: ParkedTask) => boolean): Promise<ParkedTask[]>;
  reconcileScanOpen(attemptId: string): boolean;
  adoptBlockedByFaults(now?: number): Promise<string[]>;
  restoreBreakers(): Promise<string[]>;
  sweep(now?: number, signal?: AbortSignal): Promise<string[]>;
  onTaskFailed(input: { projectId: string; runId: string; taskId: string; pmThreadId: string; state: string; reason: string; klass?: FailureClass }, now?: number): Promise<boolean>;
  breakerHolds(projectId: string, now?: number): string | null;
  diskHolds(hostId: string, path: string): Promise<string | null>;
}
