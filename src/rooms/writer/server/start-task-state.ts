import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import type { RunBudget } from "@lane-pilot/resilience";
import type { FailureClass } from "../../contracts/failure-class";
import type { ReassignRequest } from "./reassign";
import type { getAttempt } from "../../storage";
import type { ServerCore } from "../../contracts/server";
import type { StartWriterTaskDeps } from "./start-writer-task";
import { isOwnFailure } from "./start-failure-records";

/** The writer selection an attempt ran with, kept for the receipts and the outcome note. */
export type WriterSelection = {
  providerId:string;model:string;reasoningLevel?:string;serviceTier?:"default"|"fast"|null;
  selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"};
};

/** The input startWriterTask is called with. */
export interface WriterTaskInput {
  projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
  config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
  /** The writer already has its turn in writerThreadId (the PM reopened the attempt): it is checked once the turn ends, without the waits. */
  turnSent?:boolean;
}

/** The shared locals of the writer pipeline: every stage reads and writes these. */
export interface WriterTaskState {
  attemptId: string;
  writerThreadId: string | undefined;
  writerSelection: WriterSelection | undefined;
  freshTask: TaskV2;
  freshConfig: PrototypeConfig;
  activeConfig: PrototypeConfig;
  activeTask: TaskV2;
  dirtBefore: DirtSnapshot[];
  baselineDirtBefore: DirtSnapshot[] | null;
  baselineWorkspacePath: string | null;
  executionPacketSha256: string | null;
  last: Record<string, unknown>;
  judged: { status: string; reason: string | null; klass: FailureClass; mast?: string; intervention?: string; streak?: number } | null;
  primaryFailure: Record<string, unknown> | null;
  /** A red check the same writer already failed the same way: the next attempt is the next writer, not this one again. */
  checkEscalation: string | null;
  /** The last failure that was the task's own (a stray file, a red check), not its provider's: a fallback writer avoids it too. */
  own: { failure: Record<string, unknown> | null };
  // The PM reassigned the task: the next writer continues the stopped one's worktree and starts with the requested model.
  pendingReassign: { from: ReturnType<typeof getAttempt>; request: ReassignRequest } | null;
  // The last failed attempt's worktree, kept until the next attempt starts or the fallback chain takes it over.
  unremovedWorktree: ReturnType<typeof getAttempt>;
  // An earlier task of the same family (a redispatch, a mainfix) that failed the same way stops the next one early.
  familyFailure: { state: string; reason: string | null } | null;
  acceptedAttemptId: string | null;
  pmReadContext: string;
  key: string;
  releaseWriterSlot: (() => void) | undefined;
  holdsLiveWriter: boolean;
  liveFolder: boolean;
  liveBackupId: string | null;
  policy: ReturnType<ServerCore["runPolicyFor"]>;
  baseSettings: Record<string, unknown>;
  writerOverlay: Awaited<ReturnType<StartWriterTaskDeps["pickWriter"]>>;
  runSettings: Record<string, unknown>;
  writerChoice: Record<string, unknown>;
  budget: RunBudget;
  runFolder: string;
  attemptsHere: number;
  halfBound: boolean;
  inSession: boolean;
  sessionStartedAt: number;
  previousTurn: { failure: string; diff: string | null; streamError?: boolean } | null;
}

/** Records a failure as the task's own when it is one (a stray file, a red check), not its provider's. */
export const noteOwnFailure = (state: WriterTaskState, outcome: Record<string, unknown>) => {
  if (isOwnFailure(outcome)) state.own.failure = outcome;
};
