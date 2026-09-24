export type IdempotencyTriple = { lanePilotRunId:string; lanePilotTaskId:string; attemptId:string };
export type HolderIdentity = { lanePilotRunId:string; lanePilotTaskId:string; workspaceAttemptId:string };
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

function matchesHolder(value: Record<string,unknown>, key: HolderIdentity): boolean {
  return value.role === "workspace-provisioner"
    && value.lanePilotRunId === key.lanePilotRunId
    && value.lanePilotTaskId === key.lanePilotTaskId
    && value.workspaceAttemptId === key.workspaceAttemptId;
}

async function scan(
  port: ReconcilePort,
  predicate:(metadata:Record<string,unknown>)=>boolean,
  options: { limit?:number; maxPages?:number } = {},
): Promise<ReconcileResult> {
  const limit = options.limit ?? 50;
  const maxPages = options.maxPages ?? 20;
  const matchesFound: string[] = [];
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const items = await port.list({ limit, offset: page * limit });
      for (const item of items) {
        if (predicate(await port.metadata(item.id))) matchesFound.push(item.id);
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

export async function reconcile(
  port: ReconcilePort,
  key: IdempotencyTriple,
  options: { limit?:number; maxPages?:number } = {},
): Promise<ReconcileResult> {
  return scan(port, (metadata) => matches(metadata, key), options);
}

export async function reconcileHolder(
  port: ReconcilePort,
  key: HolderIdentity,
  options: { limit?:number; maxPages?:number } = {},
): Promise<ReconcileResult> {
  return scan(port, (metadata) => matchesHolder(metadata, key), options);
}

export type CriticIdentity = { lanePilotRunId:string; lanePilotTaskId:string; stageId:string; role:string };

export async function reconcileCritic(
  port: ReconcilePort,
  key: CriticIdentity,
  options: { limit?:number; maxPages?:number } = {},
): Promise<ReconcileResult> {
  return scan(port, (metadata) => (
    metadata.role === key.role
    && metadata.lanePilotRunId === key.lanePilotRunId
    && metadata.lanePilotTaskId === key.lanePilotTaskId
    && metadata.stageId === key.stageId
  ), options);
}
