/** What the server and the screens agree on for live updates: one channel per project, a small «what changed» payload. */
export const LP_REALTIME_KINDS = ["helpers", "council", "rules", "workflow", "workflow-draft", "schedule"] as const;
export type LpRealtimeKind = (typeof LP_REALTIME_KINDS)[number];
/** `runId` rides on a `workflow` signal (the run whose steps changed), `draftId` on a `workflow-draft` one (the draft that was patched). */
export type LpRealtimeSignal = { kind: LpRealtimeKind; threadId?: string; runId?: string; draftId?: string };
/** The channel id of the screens that belong to no project (the global Workflows library): every workflow change is sent there too. */
export const LP_ALL_PROJECTS = "-";

/** BB broadcasts a plugin signal to every connected client, so the project is part of the channel name. */
export const lpChannel = (projectId: string): string => `lp:${projectId}`;

export function parseLpSignal(payload: unknown): LpRealtimeSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const { kind, threadId, runId, draftId } = payload as { kind?: unknown; threadId?: unknown; runId?: unknown; draftId?: unknown };
  if (typeof kind !== "string" || !(LP_REALTIME_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as LpRealtimeKind, ...(typeof threadId === "string" ? { threadId } : {}), ...(typeof runId === "string" ? { runId } : {}), ...(typeof draftId === "string" ? { draftId } : {}) };
}

/** While the live connection is up the screens re-read on the server's signal; this slow poll only catches a missed one. */
export const LIVE_FALLBACK_MS = 30_000;
/** Without the live connection (connecting, reconnecting) the screens poll the way they did before signals. */
export const OFFLINE_POLL_MS = 4_000;
