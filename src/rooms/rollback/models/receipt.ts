import type { PrototypeConfig, TaskV2 } from "../../contracts";

export type TaskReceiptKind = "reverify" | "revert";
export type TaskReceiptState = "passed" | "failed" | "merged" | "dry_run" | "refused" | "error";

export type TaskReceipt = {
  id: number;
  at: number;
  kind: TaskReceiptKind;
  projectId: string;
  runId: string;
  taskId: string;
  attemptId: string | null;
  baseSha: string | null;
  changeSha: string | null;
  resultCommit: string | null;
  state: TaskReceiptState;
  summary: string;
  detail: unknown;
};

export type RollbackItem = {
  command: string;
  exitCode: number;
  ok: boolean;
  hostError?: true;
  tail: string;
  /** Output hashes of this run (SMA ar_receipt); expectedStdoutSha256/outputChanged are filled against the recorded verification. */
  stdoutSha256?: string;
  expectedStdoutSha256?: string;
  outputChanged?: boolean;
};

export type RollbackResult = {
  ok: boolean;
  state: TaskReceiptState;
  taskId: string;
  attemptId: string | null;
  /** The commit the accepted work started from, and the merge that put it in main. */
  base: string | null;
  change: string | null;
  summary: string;
  /** With a refusal: the one thing to do next. */
  next?: string;
  items?: RollbackItem[];
  receiptId?: number;
  [extra: string]: unknown;
};

export type RollbackTarget = {
  taskId: string;
  task: TaskV2;
  runId: string;
  projectId: string;
  hostId: string;
  basePath: string;
  config: PrototypeConfig;
};
