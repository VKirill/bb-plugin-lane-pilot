import { getRun } from "../../storage";
import { postOwnerItem } from "../../owner-waiting";
import type { LanePilotDatabase } from "../../storage";
import type { RunRow } from "../../storage";
import { AFTER_ACCEPT, DOCS_MAINTENANCE, DOCS_NIGHT, LP_TASK_PIPELINE } from "../builtin";
import { startedBySchedule } from "./workflow-runtime";

/** The machine's own upkeep graphs: they tell no PM chat and post nothing to the owner's list (a failed one is the wall's and the next run's to settle). */
const UPKEEP_WORKFLOWS = new Set<string>([AFTER_ACCEPT, DOCS_NIGHT, DOCS_MAINTENANCE]);

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
  lines.push(input.workflowId === "errand"
    ? "Next: call lane_pilot_wait_errand with this workflowRunId for the report."
    : input.workflowId === "council"
      ? "Next: call lane_pilot_council_status (with runId) for the feed and the reason."
      : "Next: call lane_pilot_workflow_status with this workflowRunId for details.");
  return lines.join("\n");
}

/** The text a scheduled run was for: its first non-empty output field named like a report (`report_md`, `summary`, `digest`…). */
export function deliverable(outputJson: string | null): string | null {
  let output: Record<string, unknown>;
  try { output = JSON.parse(outputJson ?? "null") as Record<string, unknown>; } catch { return null; }
  if (!output || typeof output !== "object") return null;
  const name = Object.keys(output).find((key) => /(_md|^report|^summary|^digest|^message|^text)$/.test(key) && typeof output[key] === "string" && (output[key] as string).trim());
  return name ? (output[name] as string).trim().slice(0, 12_000) : null;
}

/** Starter graphs whose PM tool waits for the run and returns its result (graph ids of the browser tools). */
const PM_WAITS_FOR = new Set(["browser-step", "lp.browser-qa"]);

const isNoticeStatus =(status: string): status is WorkflowNoticeStatus =>
  (WORKFLOW_NOTICE_STATUSES as readonly string[]).includes(status);

/** Send one PM message for a terminal or blocked run, or skip (schedule, no chat, already sent, not a PM workflow). */
export async function maybeNotifyWorkflowRun(input: {
  bb: WorkflowNoticeSend;
  log: (message: string) => void;
  run: Pick<RunRow, "id" | "workflow_id" | "idem_key" | "parent_run_id" | "status" | "reason" | "link_run_id"> & Partial<Pick<RunRow, "output_json">>;
  pmThreadId: string | null;
  startedBySchedule: boolean;
  unmetGoalIds?: string[];
}): Promise<boolean> {
  const { run } = input;
  if (!isNoticeStatus(run.status)) return false;
  if (run.parent_run_id) return false;
  if (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:")) return false;
  // The upkeep after an accepted task (memory, project life) is the machine's: a notice per task would wake the PM for nothing.
  if (UPKEEP_WORKFLOWS.has(run.workflow_id)) return false;
  // A phase's stage run reports through the phase's gates and book; a notice of each one had the PM step into the machine's stage (live, 2026-10-25).
  if (run.idem_key?.startsWith("phase:")) return false;
  // The browser tools wait for their graph and answer with its result: a notice would wake the PM a second time.
  if (PM_WAITS_FOR.has(run.workflow_id)) return false;
  // A council that decided has told the PM itself (its `decide` step names the page and the next tasks); one that failed or was stopped is told here.
  if (run.workflow_id === "council" && run.status === "succeeded") return false;
  if (!input.pmThreadId) return false;
  // A scheduled run is not watched live, but what it was scheduled for (a report, a digest) is the owner's: the PM shows it. Its
  // failures are the schedule board's to tell (the live weekly report reached no one, 2026-10-25).
  const delivered = input.startedBySchedule ? (run.status === "succeeded" ? deliverable(run.output_json ?? null) : null) : undefined;
  if (input.startedBySchedule && !delivered) return false;
  const key = workflowNoticeKey(run.id, run.status);
  if (await input.bb.storage.kv.get(key).catch(() => null)) return false;
  await input.bb.storage.kv.set(key, Date.now() as never).catch(() => undefined);
  const text = delivered
    ? `Lane Pilot: the scheduled run ${run.id} of ${run.workflow_id} finished. Show the owner this result in this chat as it is (no summary, nothing to act on; its helper's own completion may follow: it is the same result, say nothing about it):\n\n${delivered}`
    : workflowEndedText({
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

/** The workflows that post their own line to the owner's list when they end well (the scheduled agent's routine). */
const OWN_REPORT_WORKFLOWS = new Set(["agent-routine"]);

/**
 * The end of a run that has no PM chat to tell: one line on the owner's list instead, with a push when it went wrong. The same cases as the
 * PM notice: a scheduled run reports only the result it was scheduled for (its failures are the schedule board's), any other run reports its end.
 */
export function reportEndToOwner(db: LanePilotDatabase, run: RunRow, scheduled: boolean, unmetGoalIds?: string[]): boolean {
  if (!isNoticeStatus(run.status) || run.parent_run_id || !run.project_id || run.link_run_id) return false;
  if (run.workflow_id === LP_TASK_PIPELINE || UPKEEP_WORKFLOWS.has(run.workflow_id) || run.idem_key?.startsWith("lp-task:") || run.idem_key?.startsWith("phase:")) return false;
  const delivered = run.status === "succeeded" ? deliverable(run.output_json ?? null) : null;
  if (scheduled && !delivered) return false;
  if (run.status === "succeeded" && (OWN_REPORT_WORKFLOWS.has(run.workflow_id) || !delivered)) return false;
  const failed = run.status !== "succeeded";
  const why = delivered ?? workflowEndedText({ workflowRunId: run.id, workflowId: run.workflow_id, status: run.status, reason: run.reason, unmetGoalIds: run.status === "blocked" ? unmetGoalIds : undefined });
  return postOwnerItem(db, {
    key: `workflow-end:${run.id}:${run.status}`, source: "workflow", kind: `workflow_${run.status}`, projectId: run.project_id, wake: failed,
    what: `«${run.workflow_id}» (run ${run.id}) ${failed ? `is ${run.status}` : "finished"}`, why,
  }).created;
}

export async function notifyWorkflowIfEnded(input: {
  bb: WorkflowNoticeSend;
  db: LanePilotDatabase;
  log: (message: string) => void;
  run: RunRow;
  unmetGoalIds?: string[];
}): Promise<boolean> {
  const linked = input.run.link_run_id ? getRun(input.db, input.run.link_run_id) : undefined;
  if (!input.run.link_run_id) return reportEndToOwner(input.db, input.run, startedBySchedule(input.db, input.run), input.unmetGoalIds);
  return maybeNotifyWorkflowRun({
    bb: input.bb, log: input.log, run: input.run,
    pmThreadId: linked?.pm_thread_id ?? null,
    startedBySchedule: startedBySchedule(input.db, input.run),
    unmetGoalIds: input.unmetGoalIds,
  });
}
