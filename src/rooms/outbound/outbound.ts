import { getAttempt, getRun, getTask, loadProjectSettings, onAttemptChanged } from "../storage";
import type { ServerCore } from "../core/server";

/**
 * The voice outward (SMA map: Task event webhook, Nine allowed fields, No address — silence). When a project names a webhook (setting
 * events.webhook_url, https only), each task that ends (accepted, blocked, canceled) is posted there as JSON with exactly nine fields and
 * nothing else: no contract, no output, no paths. No address, no post. The world version (SMA: World version number) grows with every
 * change of an attempt, so a screen or a client polls one number to know whether to read the board again.
 */
export const EVENT_FIELDS = ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"] as const;
export type TaskEvent = Record<(typeof EVENT_FIELDS)[number], string | number | null>;

const OUTBOUND_STATES = new Set(["accepted", "blocked", "canceled"]);
export const isOutboundState = (state: string) => OUTBOUND_STATES.has(state);

/** The body of one event: the nine fields, in order, each clipped; anything else the caller passes is dropped. */
export function taskEventBody(input: Partial<Record<string, unknown>>): TaskEvent {
  const clip = (value: unknown) => (value === undefined || value === null ? null : typeof value === "number" ? value : String(value).slice(0, 200));
  return Object.fromEntries(EVENT_FIELDS.map((field) => [field, clip(input[field])])) as TaskEvent;
}

let version = 0;
/** The world version: grows with every change of an attempt since the plugin started. */
export const worldVersion = () => version;

export function mountOutbound(ctx: Pick<ServerCore, "db" | "bb" | "log" | "isDisposed">): void {
  const sent = new Set<string>();
  const stop = onAttemptChanged((attemptId) => {
    version += 1;
    const attempt = getAttempt(ctx.db, attemptId);
    if (!attempt || !isOutboundState(attempt.state) || sent.has(`${attemptId}:${attempt.state}`)) return;
    const run = getRun(ctx.db, attempt.run_id);
    if (!run) return;
    const url = String(loadProjectSettings(ctx.db, run.project_id)["events.webhook_url"] ?? "").trim();
    if (!/^https:\/\/[^\s]+$/.test(url)) return;
    sent.add(`${attemptId}:${attempt.state}`);
    const contract = getTask(ctx.db, attempt.task_id)?.contract as { display_title?: string; title?: string; kind?: string } | undefined;
    const body = taskEventBody({ event: `task.${attempt.state}`, projectId: run.project_id, runId: run.id, taskId: attempt.task_id,
      title: contract?.display_title ?? contract?.title ?? null, kind: contract?.kind ?? null, state: attempt.state, attempt: attempt.attempt_no, at: Date.now() });
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
      .catch((cause: unknown) => ctx.log(`outbound: ${url.slice(0, 60)}: ${cause instanceof Error ? cause.message : String(cause)}`));
  });
  ctx.bb.onDispose(stop);
}
