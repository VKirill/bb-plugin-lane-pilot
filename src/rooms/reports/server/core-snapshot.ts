import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The core facts the daily report's SQL reads, fetched through the SDK and injected into the child runner's in-memory
 * `core` schema — the plugin never attaches the real `bb.db` (a second SQLite copy of it in this process once killed
 * the hub with SIGBUS; see native-agent/server/profile-check.ts history). Sections degrade on their own: a failed
 * projects read shows project ids instead of names, a failed coverage read leaves the block «не проверено» — never a
 * silent omission.
 *
 * Coverage boundary (stated, not hidden): `threads.list` covers archived and hidden threads but always excludes
 * deleted ones, so helpers deleted inside the window are absent from the snapshot — the coverage line can undercount
 * them. The route orders by project/pinned/createdAt-desc, not globally by createdAt, so every listed row is checked
 * and a page cap throws into `degraded` rather than truncating silently. The old SQL keyed coverage on
 * `thread_plugin_metadata.plugin_id like '%lane-pilot%'`, not on the spawning plugin, so no originPluginId filter is
 * applied: foreign-origin threads carrying Lane Pilot metadata stay in the window.
 */
export type CoreSnapshot = {
  projects: { id: string; name: string | null }[];
  threads: { id: string; created_at: number }[];
  threadPluginMetadata: { thread_id: string; plugin_id: string; metadata_json: string }[];
};
export type CoreSnapshotResult = { snapshot: CoreSnapshot; degraded: string[] };

const PAGE = 200;
/** 25 pages of 200 = 5000 threads scanned; past it the window cannot be proven complete. */
const MAX_PAGES = 25;
const METADATA_CHUNK = 200;

/** `threads.created_at` arrives in the column's own unit on old rows; the report window is milliseconds. */
const toMs = (at: number): number => (at > 100_000_000_000 ? at : at * 1000);

export async function coreSnapshotViaSdk(bb: BbPluginApi, sinceMs: number): Promise<CoreSnapshotResult> {
  const degraded: string[] = [];
  const snapshot: CoreSnapshot = { projects: [], threads: [], threadPluginMetadata: [] };

  try {
    const rows = await bb.sdk.projects.list({});
    if (!Array.isArray(rows)) throw new Error("projects.list returned a non-array response");
    for (const row of rows) {
      if (typeof row?.id === "string") snapshot.projects.push({ id: row.id, name: typeof row.name === "string" ? row.name : null });
    }
  } catch (cause) {
    degraded.push(`projects: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  try {
    const threadsApi = bb.sdk.threads;
    if (typeof threadsApi.list !== "function" || typeof threadsApi.experimental_listPluginMetadata !== "function") {
      throw new Error("this BB has no batched plugin-metadata read (SDK threads.experimental_listPluginMetadata)");
    }
    const candidates: { id: string; created_at: number }[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await threadsApi.list({ includeHidden: true, limit: PAGE, offset: page * PAGE });
      if (!Array.isArray(rows)) throw new Error("threads.list returned a non-array response");
      for (const row of rows) {
        if (typeof row.createdAt === "number") {
          const created_at = toMs(row.createdAt);
          if (created_at >= sinceMs) candidates.push({ id: row.id, created_at });
        }
      }
      if (rows.length < PAGE) break;
      if (page === MAX_PAGES - 1) throw new Error(`more than ${MAX_PAGES * PAGE} threads scanned; the coverage window cannot be read completely`);
    }
    const ids = candidates.map((row) => row.id);
    const metadata = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += METADATA_CHUNK) {
      const result = await threadsApi.experimental_listPluginMetadata({ pluginId: "lane-pilot", threadIds: ids.slice(i, i + METADATA_CHUNK) });
      if (!Array.isArray(result?.threads)) throw new Error("experimental_listPluginMetadata returned a malformed response");
      for (const row of result.threads) {
        if (typeof row.threadId === "string" && row.metadata && typeof row.metadata === "object") metadata.set(row.threadId, row.metadata);
      }
    }
    for (const row of candidates) {
      snapshot.threads.push(row);
      const meta = metadata.get(row.id);
      if (meta !== undefined) snapshot.threadPluginMetadata.push({ thread_id: row.id, plugin_id: "lane-pilot", metadata_json: JSON.stringify(meta) });
    }
  } catch (cause) {
    degraded.push(`graph coverage: ${cause instanceof Error ? cause.message : String(cause)}`);
    snapshot.threads = [];
    snapshot.threadPluginMetadata = [];
  }

  return { snapshot, degraded };
}
