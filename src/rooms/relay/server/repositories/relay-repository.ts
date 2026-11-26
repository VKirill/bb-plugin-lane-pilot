import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { taskFamily } from "@lane-pilot/contracts";
import {
  getAttempt,
  getRun,
  getRunSettingsScopes,
  getTask,
  latestGateRun,
  latestGateRunForTask,
  latestTaskAttemptState,
  listProjectAttemptStates,
  listUnreportedTaskOutcomes,
  loadProjectSettings,
  loadPrototypeConfig,
  markTaskOutcomesReported,
  pmHasTasksAtWork,
  pmTasksWaiting,
  toldPmDirectly,
  type LanePilotDatabase,
  type TaskOutcome,
} from "../../../storage";
import type { RelayItem } from "../../models/relay";

const KEY = "relay:items";
const NOTICE_SINCE_KEY = "relay:task-notices-since";

export async function loadRelayItems(kv: BbPluginApi["storage"]["kv"]): Promise<RelayItem[]> {
  const value = await kv.get(KEY);
  return Array.isArray(value) ? value as RelayItem[] : [];
}

export async function saveRelayItems(kv: BbPluginApi["storage"]["kv"], items: RelayItem[]): Promise<void> {
  await kv.set(KEY, items as never);
}

export async function loadTaskOutcomesSince(kv: BbPluginApi["storage"]["kv"], db: LanePilotDatabase, now: () => number): Promise<TaskOutcome[]> {
  const since = await kv.get(NOTICE_SINCE_KEY);
  if (typeof since !== "number") {
    await kv.set(NOTICE_SINCE_KEY, now() as never);
    return [];
  }
  return listUnreportedTaskOutcomes(db, since);
}

export function readRelayTaskStates(db: LanePilotDatabase, projectId: string, taskIds: string[]): Record<string, string | null> {
  return Object.fromEntries(taskIds.map((task) => [task, latestTaskAttemptState(db, projectId, task)]));
}

export function findLatestFamilyMember(db: LanePilotDatabase, projectId: string, taskId: string): { taskId: string; state: string | null } | null {
  const family = taskFamily(taskId);
  const rows = listProjectAttemptStates(db, projectId);
  const member = rows.find((row) => taskFamily(row.task_id) === family);
  return member ? { taskId: member.task_id, state: member.state } : null;
}

export function readPmTasksAtWork(db: LanePilotDatabase, pmThreadId: string): Array<string | { taskId: string; reason: string | null }> {
  const waiting = new Map(pmTasksWaiting(db, pmThreadId).map((row) => [row.taskId, row.reason]));
  return pmHasTasksAtWork(db, pmThreadId).map((taskId) => waiting.has(taskId) ? { taskId, reason: waiting.get(taskId)! } : taskId);
}

export function wasOutcomeToldDirectly(db: LanePilotDatabase, row: TaskOutcome): boolean {
  return toldPmDirectly(db, row.pmThreadId, row.taskId, row.at);
}

export function markRelayOutcomesReported(db: LanePilotDatabase, rows: TaskOutcome[], at: number): void {
  markTaskOutcomesReported(db, rows, at);
}

export function readRelayPrototypeConfig(db: LanePilotDatabase, projectId: string) {
  return loadPrototypeConfig(db, projectId);
}

export function readRelayGateContext(db: LanePilotDatabase, row: TaskOutcome) {
  const found = latestGateRunForTask(db, row.projectId, row.taskId);
  if (found) return { found, settings: null, hasPriorGateRun: true };
  const settings = loadProjectSettings(db, row.projectId, getRunSettingsScopes(db, getAttempt(db, row.attemptId)?.run_id ?? ""));
  return { found: null, settings, hasPriorGateRun: Boolean(latestGateRun(db, row.projectId)) };
}

export function hasPendingTaskOutcomes(db: LanePilotDatabase): boolean {
  return listUnreportedTaskOutcomes(db, 0).length > 0;
}

export function readOutboundSettings(db: LanePilotDatabase, projectId: string): Record<string, unknown> {
  return loadProjectSettings(db, projectId);
}

export function readOutboundAttemptContext(db: LanePilotDatabase, attemptId: string) {
  const attempt = getAttempt(db, attemptId);
  if (!attempt) return null;
  const run = getRun(db, attempt.run_id);
  if (!run) return null;
  const contract = getTask(db, attempt.task_id)?.contract as { display_title?: string; title?: string; kind?: string } | undefined;
  return { attempt, run, contract };
}
