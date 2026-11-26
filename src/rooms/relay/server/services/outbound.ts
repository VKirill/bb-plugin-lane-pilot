import { SETTING_EVENTS_WEBHOOK_URL } from "@lane-pilot/settings-catalog";
import { isOutboundState, taskEventBody } from "../../models/outbound";
import { readOutboundAttemptContext, readOutboundSettings } from "../repositories/relay-repository";
import { invalidateRpcTags } from "../../../platform/server";
import type { LanePilotDatabase } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";

let version = 0;
/** The UI version: grows with every change of an attempt since the plugin started. */
export const uiVersion = () => version;

/**
 * The one sanctioned outbound path for events that are not a task's end (SMA k_lib_notify): the same webhook, the same
 * https-only check, the same nine-field clip. An unset address means no post; the caller names `event` and `state`.
 */
export async function postEvent(db: LanePilotDatabase, projectId: string, input: Partial<Record<string, unknown>>, log: (message: string) => void = () => undefined): Promise<boolean> {
  const url = String(readOutboundSettings(db, projectId)[SETTING_EVENTS_WEBHOOK_URL] ?? "").trim();
  if (!/^https:\/\/[^\s]+$/.test(url)) return false;
  const body = taskEventBody({ ...input, projectId, at: input.at ?? Date.now() });
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    .catch((cause: unknown) => log(`outbound: ${url.slice(0, 60)}: ${cause instanceof Error ? cause.message : String(cause)}`));
  return true;
}

export function onOutboundAttemptChanged(ctx: Pick<ServerCore, "db" | "bb" | "log">, sent: Set<string>, attemptId: string): void {
  version += 1;
  // Watched `ui_version` reads (SDK useRpcQuery) refetch at once; an older BB has no invalidate and keeps its interval (B-9).
  invalidateRpcTags(ctx.bb, ["ui_version"]);
  const context = readOutboundAttemptContext(ctx.db, attemptId);
  if (!context) return;
  const { attempt, run, contract } = context;
  if (!isOutboundState(attempt.state) || sent.has(`${attemptId}:${attempt.state}`)) return;
  const url = String(readOutboundSettings(ctx.db, run.project_id)[SETTING_EVENTS_WEBHOOK_URL] ?? "").trim();
  if (!/^https:\/\/[^\s]+$/.test(url)) return;
  sent.add(`${attemptId}:${attempt.state}`);
  const body = taskEventBody({
    event: `task.${attempt.state}`,
    projectId: run.project_id,
    runId: run.id,
    taskId: attempt.task_id,
    title: contract?.display_title ?? contract?.title ?? null,
    kind: contract?.kind ?? null,
    state: attempt.state,
    attempt: attempt.attempt_no,
    at: Date.now(),
  });
  void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    .catch((cause: unknown) => ctx.log(`outbound: ${url.slice(0, 60)}: ${cause instanceof Error ? cause.message : String(cause)}`));
}
