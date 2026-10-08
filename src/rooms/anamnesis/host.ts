import type { AnamnesisRequest, ResponseOf, UpsertSummary } from "./ops";
import { anamnesisRequestSchema } from "./ops";
import { existsSync } from "node:fs";
import { collectSources } from "./collect";
import { renderCard, renderWhoami, type WhoamiRecord } from "./whoami";
import { notesDir, notesStatus, syncNotes } from "./notes";
import { profileRecords } from "./profile-import";
import { renderYearReview } from "./year-review";
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

/** `notesDir` is where the portrait files live; absent, no file is read or written (tests of the store). */
export type HostContext = { now?: number; notesDir?: string };

/** The operations that change what the files say; each one is followed by a sync pass (the owner's edits are read first, then the files are written). */
const WRITES_NOTES = new Set(["upsert", "add", "edit", "forget", "collect", "import_profile", "purge_technical", "sources"]);

export async function executeRequest(request: AnamnesisRequest, store: Store, context: HostContext = {}): Promise<unknown> {
  const response = await execute(request, store, context);
  const wrote = request.op === "collect" ? request.mode === "run" : request.op === "sources" ? request.set !== undefined : request.op === "purge_technical" ? request.dryRun !== true : WRITES_NOTES.has(request.op);
  // The files never fail an operation: a problem is in the answer of `notes` and is tried again at the next change.
  if (wrote && context.notesDir) syncNotes(store, context.notesDir, context.now ?? Date.now());
  return response;
}

async function execute(request: AnamnesisRequest, store: Store, context: HostContext): Promise<unknown> {
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
      const { sections, detail, includeSensitive, includeDrafts, publicOnly, year, locale } = request;
      if (year !== undefined) return renderYearReview(records, { year, now, ...(includeSensitive ? { includeSensitive } : {}), ...(includeDrafts !== undefined ? { includeDrafts } : {}), ...(publicOnly ? { publicOnly } : {}) }) satisfies ResponseOf<"whoami">;
      return renderWhoami(withEvidence, { ...(locale ? { locale } : {}), ...(sections ? { sections } : {}), ...(detail ? { detail } : {}), ...(includeSensitive ? { includeSensitive } : {}),
        ...(includeDrafts !== undefined ? { includeDrafts } : {}), ...(publicOnly ? { publicOnly } : {}) }) satisfies ResponseOf<"whoami">;
    }
    case "card": return renderCard(store.list({ includeSensitive: false, statuses: ["confirmed"], limit: 2000 }), { ...(request.maxChars ? { maxChars: request.maxChars } : {}), now }) satisfies ResponseOf<"card">;
    case "import_profile": {
      const { records, skipped } = profileRecords(request.profile, now);
      const reason = "moved from the memory-profile card";
      const results = store.transaction(() => records.map((record) => {
        const result = store.upsert(record, { actor: "owner", reason, now });
        // The card was the owner's own text: a record that already existed as a draft is confirmed with it.
        const stored = result.id && result.action !== "invalid" && result.action !== "ignored" ? store.get(result.id, { includeSensitive: true }) : null;
        if (stored && stored.status !== "confirmed") store.edit(stored.id, { status: "confirmed" }, reason, now);
        return result;
      }));
      const summary = summarizeUpserts(results);
      return { imported: results.filter((result) => result.id && result.action !== "invalid" && result.action !== "ignored").length, ids: summary.ids, skipped, reasons: summary.reasons } satisfies ResponseOf<"import_profile">;
    }
    case "purge_technical": return store.purgeTechnical({ ...(request.dryRun ? { dryRun: true } : {}) }) satisfies ResponseOf<"purge_technical">;
    case "notes": return (request.sync && context.notesDir ? syncNotes(store, context.notesDir, now) : notesStatus(context.notesDir ?? null)) satisfies ResponseOf<"notes">;
    case "loads": return { loads: store.loads(request.limit ?? 10).map((load) => ({ id: load.id, at: load.at, mode: load.mode, report: (load.report && typeof load.report === "object" && !Array.isArray(load.report) ? load.report : {}) as Record<string, unknown> })) } satisfies ResponseOf<"loads">;
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
  const readOnly = request.op === "status" || request.op === "whoami" || request.op === "card" || request.op === "list" || request.op === "get" || request.op === "history" || request.op === "loads"
    || (request.op === "collect" && request.mode === "plan") || (request.op === "sources" && !request.set) || (request.op === "purge_technical" && request.dryRun === true) || (request.op === "notes" && !request.sync);
  const store = readOnly && !existsSync(anamnesisDbPath()) ? openStore(":memory:") : openStore();
  try {
    return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, response: await executeRequest(request, store, { notesDir: notesDir() }) };
  } finally {
    store.close();
  }
}
