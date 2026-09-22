export type IdempotencyTriple = { lanePilotRunId:string; lanePilotTaskId:string; attemptId:string };
export type ThreadSummary = { id:string };
export type ReconcilePort = {
  list(args:{limit:number; offset:number}): Promise<ThreadSummary[]>;
  metadata(threadId:string): Promise<Record<string,unknown>>;
};

export type ReconcileResult =
  | { kind:"found"; threadId:string }
  | { kind:"not_found" }
  | { kind:"blocked"; reason:"ambiguous"|"page_cap" }
  | { kind:"error"; message:string };

function matches(value: Record<string,unknown>, key: IdempotencyTriple): boolean {
  return value.lanePilotRunId === key.lanePilotRunId
    && value.lanePilotTaskId === key.lanePilotTaskId
    && value.attemptId === key.attemptId;
}

export async function reconcile(
  port: ReconcilePort,
  key: IdempotencyTriple,
  options: { limit?:number; maxPages?:number } = {},
): Promise<ReconcileResult> {
  const limit = options.limit ?? 50;
  const maxPages = options.maxPages ?? 20;
  const matchesFound: string[] = [];
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const items = await port.list({ limit, offset: page * limit });
      for (const item of items) {
        if (matches(await port.metadata(item.id), key)) matchesFound.push(item.id);
      }
      if (matchesFound.length > 1) return { kind:"blocked", reason:"ambiguous" };
      if (items.length < limit) {
        return matchesFound.length === 1
          ? { kind:"found", threadId:matchesFound[0]! }
          : { kind:"not_found" };
      }
    }
    return { kind:"blocked", reason:"page_cap" };
  } catch (cause) {
    return { kind:"error", message:cause instanceof Error ? cause.message : String(cause) };
  }
}
