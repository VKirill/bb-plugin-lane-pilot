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
}): ThreadCompletionDecision {
  if ((input.status ?? "") === "error") return { ok:false, via:"error", detail:"thread_status_error" };
  const current = currentSpawnTurn(input.threadId, input.events);
  if (current.kind === "canceled") return { ok:false, via:"canceled", detail:current.detail };
  if (current.kind === "completed") return { ok:true, via:"turn_completed" };
  return {
    ok:false,
    via:"incomplete",
    detail:`status=${input.status || "unknown"};queuedWork=${input.queuedWork ?? "unknown"};${current.detail}`,
  };
}
