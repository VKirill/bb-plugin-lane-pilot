import { isTerminalAttemptState } from "@lane-pilot/contracts";

/**
 * The voice outward (SMA map: Task event webhook, Nine allowed fields, No address — silence). When a project names a webhook (setting
 * events.webhook_url, https only), each task that ends (accepted, blocked, canceled) is posted there as JSON with exactly nine fields and
 * nothing else: no contract, no output, no paths. No address, no post.
 */
export const EVENT_FIELDS = ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"] as const;
export type TaskEvent = Record<(typeof EVENT_FIELDS)[number], string | number | null>;

export const isOutboundState = (state: string) => isTerminalAttemptState(state);

/** The body of one event: the nine fields, in order, each clipped; anything else the caller passes is dropped. */
export function taskEventBody(input: Partial<Record<string, unknown>>): TaskEvent {
  const clip = (value: unknown) => (value === undefined || value === null ? null : typeof value === "number" ? value : String(value).slice(0, 200));
  return Object.fromEntries(EVENT_FIELDS.map((field) => [field, clip(input[field])])) as TaskEvent;
}
