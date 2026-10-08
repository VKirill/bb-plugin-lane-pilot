import type { AnamnesisRequest, ResponseOf, UpsertSummary } from "./ops";
import { anamnesisRequestSchema } from "./ops";
import { existsSync } from "node:fs";
import { collectSources } from "./collect";
import { renderCard, renderWhoami, type WhoamiRecord } from "./whoami";
import { anamnesisDbPath, openStore, type Store, type UpsertResult } from "./store";

/**
 * The host side of anamnesis: runs on the owner's machine and is the only code that opens the store. The hub sends a request,
 * gets an answer; the file never leaves the machine.
 */
export function summarizeUpserts(results: readonly UpsertResult[]): UpsertSummary {
  const counts: Record<string, number> = {}, reasons: Record<string, number> = {};
  for (const result of results) {
    counts[result.action] = (counts[result.action] ?? 0) + 1;
    if (result.reason) reasons[result.reason.split(":")[0]!] = (reasons[result.reason.split(":")[0]!] ?? 0) + 1;
  }
  return { counts, reasons, ids: results.flatMap((result) => (result.id && (result.action === "created" || result.action === "updated") ? [result.id] : [])).slice(0, 500) };
}

export type HostContext = { now?: number };

export async function executeRequest(request: AnamnesisRequest, store: Store, context: HostContext = {}): Promise<unknown> {
  const now = context.now ?? Date.now();
  switch (request.op) {
    case "status": {
      return { path: store.path, counts: store.counts(), sources: store.sources(), cutoff: store.cutoff(),
        loads: store.loads(5).map((load) => ({ id: load.id, at: load.at, mode: load.mode })) } satisfies ResponseOf<"status">;
    }
    case "upsert": {
      const results = store.transaction(() => {
        const stored = store.upsertMany(request.records, { actor: request.actor, reason: request.reason, now });
        if (request.checkpoint) store.setCheckpoint(request.checkpoint.source, request.checkpoint.at, request.checkpoint.detail ?? {}, now);
        return stored;
      });
      return summarizeUpserts(results) satisfies ResponseOf<"upsert">;
    }
    case "add": {
      const result = store.upsert(request.record, { actor: "owner", reason: request.reason, now });
      return { id: result.id, action: result.action, reason: result.reason } satisfies ResponseOf<"add">;
    }
    case "list": {
      const { op: _op, ...filter } = request;
      return { records: store.list(filter) } satisfies ResponseOf<"list">;
    }
    case "get": return { record: store.get(request.id, { includeSensitive: request.includeSensitive === true }) } satisfies ResponseOf<"get">;
    case "edit": return { record: store.edit(request.id, request.patch, request.reason, now) } satisfies ResponseOf<"edit">;
    case "history": return { history: store.history(request.id, request.limit) } satisfies ResponseOf<"history">;
    case "forget": {
      if ("id" in request) return { removed: store.forget(request.id, now) ? 1 : 0 } satisfies ResponseOf<"forget">;
      if ("all" in request) return { removed: store.forgetAll(now).removed } satisfies ResponseOf<"forget">;
      const dropped = store.forgetSource(request.source, now);
      return { removed: dropped.records, evidence: dropped.evidence } satisfies ResponseOf<"forget">;
    }
    case "collect": return await collectSources(request, store) satisfies ResponseOf<"collect">;
    case "whoami": {
      // Sensitive records are read so that they can be counted and held back; they leave this function only on the explicit flag.
      const records = store.list({ includeSensitive: true, statuses: ["confirmed", "draft"], limit: 2000 });
      const withEvidence: WhoamiRecord[] = request.detail === "full"
        ? records.map((record, index) => (index < 300 ? { ...record, evidence: store.get(record.id, { includeSensitive: true })?.evidence ?? [] } : record))
        : records;
      const { sections, detail, includeSensitive, includeDrafts, publicOnly } = request;
      return renderWhoami(withEvidence, { ...(sections ? { sections } : {}), ...(detail ? { detail } : {}), ...(includeSensitive ? { includeSensitive } : {}),
        ...(includeDrafts !== undefined ? { includeDrafts } : {}), ...(publicOnly ? { publicOnly } : {}) }) satisfies ResponseOf<"whoami">;
    }
    case "card": return renderCard(store.list({ includeSensitive: false, statuses: ["confirmed"], limit: 2000 }), { ...(request.maxChars ? { maxChars: request.maxChars } : {}), now }) satisfies ResponseOf<"card">;
    case "load_report": return { id: store.saveLoad(request.mode, request.report, now) } satisfies ResponseOf<"load_report">;
    case "sources": {
      if (request.set) store.setSource(request.set.source, request.set.enabled, now);
      return { sources: store.sources() } satisfies ResponseOf<"sources">;
    }
  }
}

/** The handler of the host method `anamnesis`. The file is opened for the call and closed after it. */
export async function anamnesisHandler(input: { requestedHostId: string; request: unknown }): Promise<{ hostId: string; response: unknown }> {
  const request = anamnesisRequestSchema.parse(input.request);
  // Reading, or planning a load, on a machine that has no store yet answers from an empty one in memory and leaves no file behind.
  const readOnly = request.op === "status" || request.op === "whoami" || request.op === "card" || request.op === "list" || request.op === "get" || request.op === "history"
    || (request.op === "collect" && request.mode === "plan") || (request.op === "sources" && !request.set);
  const store = readOnly && !existsSync(anamnesisDbPath()) ? openStore(":memory:") : openStore();
  try {
    return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, response: await executeRequest(request, store) };
  } finally {
    store.close();
  }
}
