import { getRun } from "../../../storage";
import { bestEffort, maskCredentials, withoutSelectionMarkers } from "@lane-pilot/kit";
import { wfCountRunEvents } from "@lane-pilot/workflow-engine";
import { postOwnerItem } from "../../../owner-waiting";
import type { LanePilotDatabase } from "../../../storage";
import type { RunRow } from "../../../storage";
;
import { startedBySchedule } from "./workflow-runtime";
import { isWorkflowFollowed, isWorkflowNoticeSuppressed } from "../../../platform/server";
import { sendServiceMessage } from "../../../relay/server";
import { chatCode } from "../../../brief";
import type { LeadRoadApi } from "../../../contracts";
import { AFTER_ACCEPT, LP_TASK_PIPELINE, SELF_REPAIR, WORKTREE_CLEANUP } from "../../../contracts";

/**
 * The machine's own upkeep graphs: they tell no PM chat and post nothing to the owner's list (a failed one is the wall's and the next run's to settle).
 * The worktree cleanup's output carries a `report`, which a scheduled run would otherwise deliver as a line every hour; its daily pass posts the
 * one line a person needs itself, and a failed run is the schedule board's.
 */
const UPKEEP_WORKFLOWS = new Set<string>([
  AFTER_ACCEPT, SELF_REPAIR, WORKTREE_CLEANUP,
  "lp.rules-scan",
  "lp.owner-bell",
  "lp.owner-push",
  "lp.daily-report",
  "lp.backlog-scan",
  "lp.canary-check",
]);

export const WORKFLOW_NOTICE_STATUSES = ["succeeded", "failed", "blocked", "interrupted", "canceled", "not_verified"] as const;
export type WorkflowNoticeStatus = (typeof WORKFLOW_NOTICE_STATUSES)[number];

export type WorkflowNoticeKv = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

export type WorkflowNoticeSend = {
  sdk: { threads: { send: (request: never) => Promise<unknown>; get?: (request: { threadId: string }) => Promise<unknown> } };
  storage: { kv: WorkflowNoticeKv };
};

export function workflowNoticeKey(workflowRunId: string, status: string, transition?: number): string {
  return `pm-notice:workflow:${workflowRunId}:${status}${transition ? `:${transition}` : ""}`;
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

/** Tell the linked PM an asynchronous run's outcome, or deliver the report a scheduled run was for. */
export async function maybeNotifyWorkflowRun(input: {
  bb: WorkflowNoticeSend;
  log: (message: string) => void;
  run: Pick<RunRow, "id" | "workflow_id" | "idem_key" | "parent_run_id" | "status" | "reason" | "link_run_id"> & Partial<Pick<RunRow, "output_json">>;
  pmThreadId: string | null;
  startedBySchedule: boolean;
  unmetGoalIds?: string[];
  /** Journal run-event count naming this terminal transition; absent on paths without journal events (legacy key). */
  transition?: number;
  /** How long a followed run's notice waits for the PM's turn to end (tests shorten it). */
  followWaitMs?: number;
}): Promise<boolean> {
  const { run } = input;
  if (!isNoticeStatus(run.status)) return false;
  if (run.parent_run_id) return false;
  if (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:")) return false;
  // The upkeep after an accepted task (memory, project life) is the machine's: a notice per task would wake the PM for nothing.
  if (UPKEEP_WORKFLOWS.has(run.workflow_id)) return false;
  // A phase's stage run reports through the phase's gates and book; a notice of each one had the PM step into the machine's stage (live, 2026-10-25).
  if (run.idem_key?.startsWith("phase:")) return false;
  // The browser and synchronous scout tools wait for their graph and answer with its result: a notice would wake the PM a second time.
  if (PM_WAITS_FOR.has(run.workflow_id) || run.idem_key?.startsWith("scout:")) return false;
  if (!input.pmThreadId) return false;
  if (!input.startedBySchedule && !run.link_run_id) return false;
  const key = workflowNoticeKey(run.id, run.status, input.transition);
  // The PM has been waiting on this run: let its current turn end before deciding, so a wait call that comes right after the end reads it alone.
  if (!input.startedBySchedule && isWorkflowFollowed(run.id)) await untilPmTurnEnds(input.bb, input.pmThreadId, () => isWorkflowNoticeSuppressed(run.id), input.followWaitMs);
  if (!input.startedBySchedule && isWorkflowNoticeSuppressed(run.id)) {
    await bestEffort(input.log, "workflow notice record", input.bb.storage.kv.set(key, Date.now() as never), undefined);
    return false;
  }
  const delivered = run.status === "succeeded" ? deliverable(run.output_json ?? null) : null;
  // A scheduled run delivers the report it was for; anything else scheduled stays silent (its schedule board carries it).
  if (input.startedBySchedule && !delivered) return false;
  // A chat-started run is awaited asynchronously — its tool answered with the run id and the chat went idle, so its end
  // must reach it once with the actual outcome: a bare «succeeded» is not the business result, and a failed run has no
  // graph report left to carry it (the 0.1.573 status card covers only the synchronous PM_WAITS_FOR tools).
  const body = input.startedBySchedule ? delivered! : chatOutcome(run, input.unmetGoalIds);
  const text = input.startedBySchedule
    ? `Lane Pilot: the scheduled run ${run.id} of ${run.workflow_id} finished. Show the owner this result in this chat as it is (no summary, nothing to act on):\n\n${body}`
    : `## Lane Pilot · ${run.workflow_id}\n\nRun \`${run.id}\` ended ${run.status} (engine status).\n\n${body}`;
  if (await input.bb.storage.kv.get(key)) return false;
  await bestEffort(input.log, "workflow notice record", input.bb.storage.kv.set(key, Date.now() as never), undefined);
  try {
    await sendServiceMessage(input.bb as never, { threadId: input.pmThreadId, mode: "queue-if-active", text });
    return true;
  } catch (cause) {
    input.log(`Lane Pilot workflow ${run.id}: PM notice not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
}

const PM_FOLLOW_WAIT_MS = 30 * 60_000;
const PM_FOLLOW_POLL_MS = 2_000;

/** Waits until the PM chat is idle (or `done` holds, or the bound passes); an unreadable chat counts as idle. */
async function untilPmTurnEnds(bb: WorkflowNoticeSend, threadId: string, done: () => boolean, waitMs = PM_FOLLOW_WAIT_MS): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!done() && Date.now() < deadline) {
    const thread = await bb.sdk.threads.get?.({ threadId }).catch(() => null) as { status?: unknown } | null | undefined;
    if (!thread || ["idle", "error", "stopped"].includes(String(thread.status ?? "idle"))) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(PM_FOLLOW_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
}

/** What a chat-started run's end tells its PM: the bounded actual output (engine success is not the business result),
 * or the failure's reason and unmet goals. Marker and
 * credential hygiene is applied to whatever engine output is embedded. */
function chatOutcome(
  run: { status: string; reason: string | null; output_json?: string | null },
  unmetGoalIds?: string[],
): string {
  const clean = (text: string): string => maskCredentials(withoutSelectionMarkers(text)).text.slice(0, 12_000).trim();
  if (run.status === "succeeded") {
    const raw = run.output_json ?? "";
    try {
      const output: unknown = JSON.parse(raw);
      if (typeof output === "string") return clean(output) || "succeeded; the run recorded no output.";
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const record = output as Record<string, unknown>;
        const status = typeof record.status === "string" ? `Output status: ${record.status}\n\n` : "";
        const fields = Object.entries(record).filter(([key]) => key !== "status" || typeof record.status !== "string").map(([key, value]) =>
          `### ${key}\n\n${typeof value === "string" ? value : chatCode(JSON.stringify(value, null, 2), "json")}`);
        return clean(status + fields.join("\n\n")) || "succeeded; the run recorded no output.";
      }
    } catch { /* Keep malformed output visible as recorded, without inventing an outcome. */ }
    return clean(raw) || "succeeded; the run recorded no output.";
  }
  const unmet = run.status === "blocked" && unmetGoalIds?.length ? ` Unmet goals: ${unmetGoalIds.join(", ")}.` : "";
  return clean(`Reason: ${run.reason ?? "not recorded"}.${unmet}`);
}

/** A run's end status in the owner's words. */
const END_RU: Record<string, string> = { failed: "завершился с ошибкой", blocked: "остановился: не хватает ответа или условия", canceled: "отменён", timed_out: "не уложился во время" };

/** The workflows that post their own line to the owner's list when they end well (the scheduled agent's routine). */
const OWN_REPORT_WORKFLOWS = new Set(["agent-routine"]);

/**
 * The end of a run that has no PM chat to tell: one line on the owner's list instead, with a push when it went wrong. A scheduled run reports
 * only the result it was scheduled for (its failures are the schedule board's); any other unlinked run reports its end.
 */
export function reportEndToOwner(db: LanePilotDatabase, run: RunRow, scheduled: boolean, unmetGoalIds?: string[]): boolean {
  if (!isNoticeStatus(run.status) || run.parent_run_id || !run.project_id || run.link_run_id) return false;
  if (run.workflow_id === LP_TASK_PIPELINE || UPKEEP_WORKFLOWS.has(run.workflow_id) || run.idem_key?.startsWith("lp-task:") || run.idem_key?.startsWith("phase:")) return false;
  // The machine's own graphs started by its crons (the night loop's lp.* graphs, the lead's tick) have no owner behind them: their end is a fact of the
  // log and the wall, and the lead reads their failures every tick (0.1.456: 22 such lines sat on the owner's list). A scheduled run that delivers a report is his.
  if (!scheduled && (run.workflow_id.startsWith("lp.") || run.workflow_id === "lead-tick")) return false;
  const delivered = run.status === "succeeded" ? deliverable(run.output_json ?? null) : null;
  if (scheduled && !delivered) return false;
  if (run.status === "succeeded" && (OWN_REPORT_WORKFLOWS.has(run.workflow_id) || !delivered)) return false;
  const failed = run.status !== "succeeded";
  const unmet = run.status === "blocked" && unmetGoalIds?.length ? ` Не выполнены цели: ${unmetGoalIds.join(", ")}.` : "";
  const why = delivered ?? `${run.reason ? `Причина: ${run.reason}.` : "Причина не записана."}${unmet}`;
  return postOwnerItem(db, {
    key: `workflow-end:${run.id}:${run.status}`, source: "workflow", kind: `workflow_${run.status}`, reason: failed ? "red" : "decision", projectId: run.project_id, wake: failed,
    what: `Процесс «${run.workflow_id}» ${failed ? END_RU[run.status] ?? `закончился со статусом ${run.status}` : "завершился"}`, why,
    evidence: [{ kind: "run", ref: run.id, label: "запуск сценария" }],
  }).created;
}

export async function notifyWorkflowIfEnded(input: {
  leadRoad?: LeadRoadApi;
  bb: WorkflowNoticeSend;
  db: LanePilotDatabase;
  log: (message: string) => void;
  run: RunRow;
  unmetGoalIds?: string[];
}): Promise<boolean> {
  // Work the lead («Штурман») handed over runs under the project's latest PM chat, which may be about something else entirely: its end
  // goes back to the lead's road, never into that chat (live 2026-11-03: an issue-quick block landed in an unrelated app-design chat).
  const leadRoad = leadRoadOf(input.run.idem_key);
  if (leadRoad && input.leadRoad) { settleLeadRun(input.db, input.leadRoad, input.run, leadRoad, input.unmetGoalIds); return false; }
  const linked = input.run.link_run_id ? getRun(input.db, input.run.link_run_id) : undefined;
  if (!input.run.link_run_id) return reportEndToOwner(input.db, input.run, startedBySchedule(input.db, input.run), input.unmetGoalIds);
  // The journal's run-event count names the terminal transition: it grows on every status move and ignores step/goal
  // noise, so a re-run that ends the same way still earns its own notice while a burst of events for one end shares
  // one key. Read it now — before the queue — because by the time a queued notice runs a newer transition may exist.
  const transition = wfCountRunEvents(input.db, input.run.id, "run") || undefined;
  return enqueueRunNotice(input.bb.storage.kv, input.run.id, () => maybeNotifyWorkflowRun({
    bb: input.bb, log: input.log, run: input.run,
    pmThreadId: linked?.pm_thread_id ?? null,
    startedBySchedule: startedBySchedule(input.db, input.run),
    unmetGoalIds: input.unmetGoalIds,
    transition,
  }));
}

/**
 * A run's end writes several journal rows back to back and every one of them reaches the notifier: unserialized,
 * they all read the same terminal status and race the kv claim (live 2026-11-15: one `blocked` end sent two
 * identical PM notices). Notices for one run go one at a time, scoped to the kv store they claim against — the kv
 * key, not this queue, stays the durable dedup, and a settled tail frees its slot.
 */
const noticeQueues = new WeakMap<object, Map<string, Promise<unknown>>>();

function enqueueRunNotice<T>(kv: object, runId: string, task: () => Promise<T>): Promise<T> {
  let byRun = noticeQueues.get(kv);
  if (!byRun) noticeQueues.set(kv, (byRun = new Map()));
  const tail = (byRun.get(runId) ?? Promise.resolve()).then(task, task);
  byRun.set(runId, tail);
  const settled = () => { if (byRun.get(runId) === tail) byRun.delete(runId); };
  void tail.then(settled, settled);
  return tail;
}

/** The road branch a lead hand-over started this run for (intake key `intake:<pm thread>:lead:<road id>`), else null. */
export function leadRoadOf(idemKey: string | null | undefined): string | null {
  return /^intake:[^:]+:lead:(road_[\w-]+)/.exec(idemKey ?? "")?.[1] ?? null;
}

function settleLeadRun(db: LanePilotDatabase, road: LeadRoadApi, run: RunRow, roadId: string, unmetGoalIds?: string[]): void {
  if (!isNoticeStatus(run.status)) return;
  if (run.status === "succeeded") { road.doneRoad(db, roadId, `run ${run.id} of ${run.workflow_id} succeeded`); return; }
  const unmet = unmetGoalIds?.length ? `; unmet goals: ${unmetGoalIds.join(", ")}` : "";
  road.reopenRoad(db, roadId, `handed run ${run.id} of ${run.workflow_id} ended ${run.status}: ${run.reason ?? "no reason"}${unmet}`);
}
