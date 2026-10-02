export type ThreadCompletionDecision =
  | { ok:true; via:"turn_completed" }
  | { ok:false; via:"error"|"canceled"|"incomplete"; detail:string };

type TurnEvent = {
  type:"turn/started"|"turn/completed";
  threadId:string;
  seq:number;
  status:string|null;
  requestId:string|null;
};

function stringField(value:unknown, key:string): string | null {
  if (!value || typeof value !== "object") return null;
  const found = Reflect.get(value, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

function numberField(value:unknown, key:string): number | null {
  if (!value || typeof value !== "object") return null;
  const found = Reflect.get(value, key);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function readTurnEvent(event: unknown): TurnEvent | null {
  if (!event || typeof event !== "object") return null;
  const type = stringField(event, "type");
  if (type !== "turn/started" && type !== "turn/completed") return null;
  const data = Reflect.get(event, "data");
  const threadId = stringField(event, "threadId") ?? stringField(data, "threadId");
  const seq = numberField(event, "seq");
  if (!threadId || seq === null) return null;
  return {
    type,
    threadId,
    seq,
    status: type === "turn/completed" ? stringField(data, "status") : null,
    requestId:
      stringField(event, "clientRequestId")
      ?? stringField(data, "clientRequestId")
      ?? stringField(data, "turnId")
      ?? stringField(data, "requestId"),
  };
}

function currentSpawnTurn(threadId: string, events: unknown[]): { kind:"completed" } | { kind:"canceled"|"incomplete"; detail:string } {
  const rows = events
    .map(readTurnEvent)
    .filter((row): row is TurnEvent => row !== null && row.threadId === threadId)
    .sort((left, right) => left.seq - right.seq);
  if (rows.length === 0) return { kind:"incomplete", detail:"started_seq=none;turn=none" };
  const started = [...rows].reverse().find((row) => row.type === "turn/started");
  if (!started) return { kind:"incomplete", detail:"started_seq=none;turn=none" };
  const completed = rows.find((row) => {
    if (row.type !== "turn/completed" || row.seq <= started.seq) return false;
    if (started.requestId) return row.requestId === started.requestId;
    return true;
  });
  if (!completed) return { kind:"incomplete", detail:`started_seq=${started.seq};turn=none` };
  if (!completed.status) return { kind:"incomplete", detail:`started_seq=${started.seq};turn=missing_status` };
  if (completed.status === "completed") return { kind:"completed" };
  if (completed.status === "failed" || completed.status === "interrupted" || completed.status === "error") {
    return { kind:"canceled", detail:`turn_${completed.status}` };
  }
  return { kind:"incomplete", detail:`started_seq=${started.seq};turn=${completed.status}` };
}

export function decideThreadCompletion(input: {
  threadId:string;
  status:string|null;
  queuedWork?:string|null;
  events:unknown[];
  now?:number;
  /** After sending a follow-up, only a turn requested at or after this time counts; the previous one is already done. */
  requestedAfter?:number;
}): ThreadCompletionDecision {
  if ((input.status ?? "") === "error") return { ok:false, via:"error", detail:"thread_status_error" };
  if (input.requestedAfter !== undefined) {
    const rows = input.events.map(readWatched).filter((row): row is NonNullable<typeof row> => row !== null);
    const request = rows.filter((row) => row.type === "client/turn/requested").sort((a, b) => b.seq - a.seq)[0];
    const started = rows.filter((row) => row.type === "turn/started").sort((a, b) => b.seq - a.seq)[0];
    if (!request || request.createdAt === null || request.createdAt < input.requestedAfter) return { ok:false, via:"incomplete", detail:"follow_up_not_requested_yet" };
    if (!started || started.seq < request.seq) {
      // A provider may take the follow-up into the turn still running (turn/input/accepted, no new turn/started):
      // the end of that turn is the end of the follow-up.
      const accepted = rows.filter((row) => row.type === "turn/input/accepted" && row.seq > request.seq).sort((a, b) => a.seq - b.seq)[0];
      const ended = accepted && rows.filter((row) => row.type === "turn/completed" && row.seq > accepted.seq).sort((a, b) => a.seq - b.seq)[0];
      if (ended) {
        const status = stringField(ended.data, "status");
        if (status === "completed") return { ok:true, via:"turn_completed" };
        if (status === "failed" || status === "interrupted" || status === "error") return { ok:false, via:"canceled", detail:`turn_${status}` };
      }
      const failure = threadFailure(input.events, input.now);
      if (failure) return { ok:false, via:"error", detail:failure };
      return { ok:false, via:"incomplete", detail:accepted ? "follow_up_running" : "follow_up_not_started" };
    }
  }
  const current = currentSpawnTurn(input.threadId, input.events);
  if (current.kind === "canceled") return { ok:false, via:"canceled", detail:current.detail };
  if (current.kind === "completed") return { ok:true, via:"turn_completed" };
  const failure = threadFailure(input.events, input.now);
  if (failure) return { ok:false, via:"error", detail:failure };
  return {
    ok:false,
    via:"incomplete",
    detail:`status=${input.status || "unknown"};queuedWork=${input.queuedWork ?? "unknown"};${current.detail}`,
  };
}

/** Everything BB reports about a child thread's request: its start, its turn and the ways it can fail. */
export const THREAD_WATCH_EVENT_TYPES = [
  "client/turn/requested", "client/turn/rejected", "system/thread-provisioning", "thread/identity",
  "turn/started", "turn/input/accepted", "turn/completed", "provider/error", "system/error", "system/thread/interrupted",
] as const;

/** A provider that has not opened a session this long after the request is not going to. */
export const PROVIDER_START_LIMIT_MS = 180_000;

type WatchedEvent = { type:string; seq:number; createdAt:number|null; data:unknown };

function readWatched(event: unknown): WatchedEvent | null {
  const type = stringField(event, "type");
  const seq = numberField(event, "seq");
  if (!type || seq === null) return null;
  return { type, seq, createdAt:numberField(event, "createdAt"), data:Reflect.get(event as object, "data") };
}

const clip = (text: string | null) => (text ?? "").replace(/\s+/g, " ").slice(0, 200);

/**
 * Reads BB's own verdict on the latest request instead of a stopwatch: a terminal provider or system
 * error, an interrupted thread, a rejected turn or a failed provisioning ends the wait at once; a
 * provider that never opened a session is the one silence BB cannot report, so it gets a start limit.
 */
export function threadFailure(events: unknown[], now = Date.now()): string | null {
  const rows = events.map(readWatched).filter((row): row is WatchedEvent => row !== null).sort((a, b) => a.seq - b.seq);
  const request = [...rows].reverse().find((row) => row.type === "client/turn/requested");
  const current = rows.filter((row) => !request || row.seq > request.seq);
  for (const row of current) {
    if (row.type === "provider/error" && Reflect.get(row.data as object ?? {}, "willRetry") !== true) {
      return `provider_error:${clip(stringField(row.data, "message"))}`;
    }
    if (row.type === "system/error") {
      const attempt = numberField(row.data, "reconnectAttempt"), total = numberField(row.data, "reconnectTotal");
      if (attempt !== null && total !== null && attempt < total) continue;
      return `system_error:${stringField(row.data, "code") ?? "unknown"}:${clip(stringField(row.data, "message"))}`;
    }
    if (row.type === "system/thread/interrupted") {
      const cause = stringField(row.data, "cause");
      return `thread_interrupted:${stringField(row.data, "reason") ?? "unknown"}${cause ? `:${cause}` : ""}`;
    }
    if (row.type === "client/turn/rejected") {
      return `turn_rejected:${stringField(row.data, "reason") ?? "unknown"}:${clip(stringField(row.data, "message"))}`;
    }
    if (row.type === "system/thread-provisioning" && ["failed", "cancelled"].includes(stringField(row.data, "status") ?? "")) {
      return `provisioning_${stringField(row.data, "status")}`;
    }
  }
  const started = current.some((row) => row.type === "thread/identity" || row.type === "turn/started" || row.type === "turn/input/accepted");
  if (request && request.createdAt !== null && !started && now - request.createdAt > PROVIDER_START_LIMIT_MS) {
    return `provider_not_started:no session ${Math.round((now - request.createdAt) / 1000)}s after the request`;
  }
  return null;
}
