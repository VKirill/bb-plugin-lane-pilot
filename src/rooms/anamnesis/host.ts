import type { AnamnesisRequest, HostRequest, ResponseOf, UpsertSummary } from "./ops";
import { anamnesisRequestSchema, hostRequestSchema } from "./ops";
import { existsSync } from "node:fs";
import { collectSources, scanSources } from "./collect";
import { renderCard, renderWhoami, type WhoamiRecord } from "./whoami";
import { applyNotesWrites, notesDir, notesDirListing, notesStatus, syncNotes } from "./notes";
import { profileRecords } from "./profile-import";
import { renderYearReview } from "./year-review";
import { anamnesisDbPath, openStore, type Store, type UpsertResult } from "./store";

/**
 * Two halves of anamnesis (M1b): `executeRequest` is the store-op executor — the hub runs it against its own tables;
 * `anamnesisHandler` is what remains on the owner's machine: the collection scans (raw records go back to the hub,
 * which stores them through the same door), the portrait files' read and write, and the read-only `export` of the
 * legacy file for the one-off migration. The host keeps no store.
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

/** The operations that change what the files say; each one is followed by a notes sync (the owner's edits are read first, then the files are written). */
const WRITES_NOTES = new Set(["upsert", "add", "edit", "forget", "collect", "import_profile", "purge_technical", "sources"]);

/** Whether an op is followed by a notes sync — the file store does it in `executeRequest`, the hub in `ask`. */
export const writesNotes = (request: AnamnesisRequest): boolean =>
  request.op === "collect" ? request.mode === "run"
    : request.op === "sources" ? request.set !== undefined
    : request.op === "purge_technical" ? request.dryRun !== true
    : WRITES_NOTES.has(request.op);

export async function executeRequest(request: AnamnesisRequest, store: Store, context: HostContext = {}): Promise<unknown> {
  const response = await execute(request, store, context);
  // The files never fail an operation: a problem is in the answer of `notes` and is tried again at the next change.
  if (writesNotes(request) && context.notesDir) syncNotes(store, context.notesDir, context.now ?? Date.now());
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
      const modelWritten = request.profile.authoredBy === "model";
      const results = store.transaction(() => records.map((record) => {
        const result = store.upsert(record, { actor: modelWritten ? "auto:memory-profile" : "owner", reason, now });
        // The card was the owner's own text: a record that already existed as a draft is confirmed with it. A field the model wrote stays a draft.
        const stored = !modelWritten && result.id && result.action !== "invalid" && result.action !== "ignored" ? store.get(result.id, { includeSensitive: true }) : null;
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

/** The handler of the host method `anamnesis`: collection scans, the portrait files, and the migration export. No store ops. */
export async function anamnesisHandler(input: { requestedHostId: string; request: unknown }): Promise<{ hostId: string; response: unknown }> {
  const request = hostRequestSchema.parse(input.request);
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  switch (request.op) {
    case "collect": {
      // Raw scans only: the hub stores the records through its own store door.
      return { hostId, response: { mode: request.mode, sources: await scanSources(request) } };
    }
    case "notes_read": {
      return { hostId, response: notesDirListing(notesDir(), request.full === true) };
    }
    case "notes_write": {
      const result = applyNotesWrites(notesDir(), request.writes);
      const wrote = new Set(result.wrote);
      return { hostId, response: { written: result.written, files: request.writes.map((write) => ({ name: write.name, wrote: wrote.has(write.name) })) } };
    }
    case "export": {
      // Read-only: a machine without the file answers an empty export and no file is created.
      const store = existsSync(anamnesisDbPath()) ? openStore() : openStore(":memory:");
      try { return { hostId, response: { tables: store.exportAll() } }; }
      finally { store.close(); }
    }
  }
}
