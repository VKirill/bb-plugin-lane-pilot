import { getRun } from "../../storage";
import type { LanePilotDatabase } from "../../storage";
import type { RunRow } from "../../storage";
import { LP_TASK_PIPELINE } from "../builtin";
import { startedBySchedule } from "./workflow-runtime";

export const WORKFLOW_NOTICE_STATUSES = ["succeeded", "failed", "blocked", "interrupted", "canceled"] as const;
export type WorkflowNoticeStatus = (typeof WORKFLOW_NOTICE_STATUSES)[number];

export type WorkflowNoticeKv = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

export type WorkflowNoticeSend = {
  sdk: { threads: { send: (request: never) => Promise<unknown> } };
  storage: { kv: WorkflowNoticeKv };
};

export function workflowNoticeKey(workflowRunId: string, status: string): string {
  return `pm-notice:workflow:${workflowRunId}:${status}`;
}

export function workflowEndedText(input: {
  workflowRunId: string;
  workflowId: string;
  status: string;
  reason: string | null;
  unmetGoalIds?: string[];
}): string {
  const lines = [`Workflow run ${input.workflowRunId} of ${input.workflowId} is ${input.status}.`];
  if (input.reason) lines.push(`Reason: ${input.reason}`);
  if (input.unmetGoalIds?.length) lines.push(`Unmet goals: ${input.unmetGoalIds.join(", ")}`);
  lines.push("Next: call lane_pilot_workflow_status with this workflowRunId for details.");
  return lines.join("\n");
}

const isNoticeStatus = (status: string): status is WorkflowNoticeStatus =>
  (WORKFLOW_NOTICE_STATUSES as readonly string[]).includes(status);

/** Send one PM message for a terminal or blocked run, or skip (schedule, no chat, already sent, not a PM workflow). */
export async function maybeNotifyWorkflowRun(input: {
  bb: WorkflowNoticeSend;
  log: (message: string) => void;
  run: Pick<RunRow, "id" | "workflow_id" | "idem_key" | "parent_run_id" | "status" | "reason" | "link_run_id">;
  pmThreadId: string | null;
  startedBySchedule: boolean;
  unmetGoalIds?: string[];
}): Promise<boolean> {
  const { run } = input;
  if (!isNoticeStatus(run.status)) return false;
  if (run.parent_run_id) return false;
  if (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:")) return false;
  if (input.startedBySchedule || !input.pmThreadId) return false;
  const key = workflowNoticeKey(run.id, run.status);
  if (await input.bb.storage.kv.get(key).catch(() => null)) return false;
  await input.bb.storage.kv.set(key, Date.now() as never).catch(() => undefined);
  const text = workflowEndedText({
    workflowRunId: run.id, workflowId: run.workflow_id, status: run.status, reason: run.reason,
    unmetGoalIds: run.status === "blocked" ? input.unmetGoalIds : undefined,
  });
  try {
    await input.bb.sdk.threads.send({
      threadId: input.pmThreadId, mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    } as never);
    return true;
  } catch (cause) {
    input.log(`Lane Pilot workflow ${run.id}: PM notice not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
}

export async function notifyWorkflowIfEnded(input: {
  bb: WorkflowNoticeSend;
  db: LanePilotDatabase;
  log: (message: string) => void;
  run: RunRow;
  unmetGoalIds?: string[];
}): Promise<boolean> {
  const linked = input.run.link_run_id ? getRun(input.db, input.run.link_run_id) : undefined;
  return maybeNotifyWorkflowRun({
    bb: input.bb, log: input.log, run: input.run,
    pmThreadId: linked?.pm_thread_id ?? null,
    startedBySchedule: startedBySchedule(input.db, input.run),
    unmetGoalIds: input.unmetGoalIds,
  });
}
