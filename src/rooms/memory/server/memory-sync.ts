import { z } from "zod";
import {
  exportedFileName,
  hideRecordsOfFile,
  laneMemoryFileToCandidate,
  parseLaneMemoryFile,
  parseMemoryCandidates,
  renderLaneMemoryFile,
  storeMemoryRecords,
  type MemoryAudience,
  type MemoryCandidate,
  type MemoryRecord,
  type MemorySettings,
} from "@lane-pilot/memory-core";
import { getRun, type LanePilotDatabase } from "../../../database";
import { requirePmRun } from "../../../server/context";
import { registerObservedTool } from "../../../server/tool-result";
import type { ServerCore } from "../../../server/core";
import { memorySettingsFor } from "../../../server/insights";
import { sha256Hex } from "@lane-pilot/kit";

export const MEMORY_SYNC_TOOLS = ["lane_pilot_memory_import", "lane_pilot_memory_export"] as const;

/** Where claude-lane keeps file memory inside a project; generated names and subfolders are not records. */
export const LANE_MEMORY_DIR = ".agents/memory";
const GENERATED = new Set(["MEMORY.md", "TAGS.md", "GOLDEN.yaml", "_TEMPLATE.md"]);

type Place = { hostId: string; workspace: string };

async function placeForRun(ctx: ServerCore, projectId: string, runId: string): Promise<Place> {
  const run = getRun(ctx.db, runId);
  const config = await ctx.configForRun(projectId, run);
  if (!config?.hostId || !config.writerWorkspacePath) throw new Error("the run has no writer host and workspace yet");
  return { hostId: config.hostId, workspace: config.writerWorkspacePath };
}

function joinPath(base: string, path: string): string {
  return path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** Top-level `.md` records of the memory folder; drafts, episodes and the index live in subfolders and are skipped. */
export async function listMemoryFiles(ctx: ServerCore, place: Place): Promise<Array<{ name: string; path: string }>> {
  const dir = `${place.workspace}/${LANE_MEMORY_DIR}`;
  const listed = await ctx.bb.sdk.files.listPaths({ hostId: place.hostId, path: dir, includeFiles: true, includeDirectories: false, includeHidden: true, limit: 1000 }).catch(() => null);
  if (!listed || !Array.isArray(listed.paths)) return [];
  return listed.paths
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md") && !GENERATED.has(entry.name))
    .map((entry) => ({ name: entry.name, path: joinPath(dir, entry.path) }))
    .filter((entry) => !entry.path.slice(dir.length + 1).includes("/"));
}

export type MemoryImportResult = { runId: string; files: number; imported: number; /** Records hidden because their file is no longer active or its date passed. */ hidden: number; skipped: Array<{ file: string; reason: string }>; state: "imported" | "skipped"; reason?: string };

/** File records become SQLite records; the same claim imported twice is one record. */
export async function importFileMemory(ctx: ServerCore, input: { projectId: string; runId: string }): Promise<MemoryImportResult> {
  const { db } = ctx;
  const settings = memorySettingsFor(db, input.projectId);
  const base = { runId: input.runId, files: 0, imported: 0, hidden: 0, skipped: [] as MemoryImportResult["skipped"] };
  if (!settings.enabled) return { ...base, state: "skipped", reason: "memory_disabled" };
  const place = await placeForRun(ctx, input.projectId, input.runId);
  const files = await listMemoryFiles(ctx, place);
  const byAudience = new Map<MemoryAudience, MemoryCandidate[]>();
  for (const file of files) {
    // Lane Pilot's own exports: the database holds them already, and a revoked rule must not come back from its file.
    if (file.name.startsWith("lp-")) { base.skipped.push({ file: file.name, reason: "exported by Lane Pilot" }); continue; }
    const read = await ctx.bb.sdk.files.read({ hostId: place.hostId, rootPath: place.workspace, path: file.path }).catch(() => null);
    const text = read && typeof read === "object" ? Reflect.get(read, "content") : null;
    if (typeof text !== "string") { base.skipped.push({ file: file.name, reason: "unreadable" }); continue; }
    const parsed = parseLaneMemoryFile(text);
    if (!parsed) { base.skipped.push({ file: file.name, reason: "no front matter or id" }); continue; }
    const mapped = laneMemoryFileToCandidate(parsed);
    if (!mapped) {
      // The file stopped being true after an earlier import: the record it made stops reaching writers.
      base.hidden += hideRecordsOfFile(db, input.projectId, settings.personalBot, parsed.id, parsed.status === "superseded" ? "superseded" : "expired").length;
      base.skipped.push({ file: file.name, reason: parsed.status === "active" ? "expired" : `status ${parsed.status}` });
      continue;
    }
    try {
      const [candidate] = parseMemoryCandidates([{ kind: mapped.candidate.kind, content: mapped.candidate.content, concepts: mapped.candidate.concepts }], { ...settings, coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER });
      const { sourceFileId, validUntil } = mapped.candidate;
      byAudience.set(mapped.audience, [...(byAudience.get(mapped.audience) ?? []), { ...candidate!, sourceFileId, ...(validUntil != null ? { validUntil } : {}) }]);
    } catch (cause) {
      base.skipped.push({ file: file.name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  const sourceSha256 = sha256Hex(files.map((file) => file.path).join("\n"));
  let imported = 0;
  for (const [audience, entries] of byAudience) {
    const store = (batch: MemoryCandidate[]) => storeMemoryRecords(db, { projectId: input.projectId, personalBot: settings.personalBot, audience, sourceSha256, entries: batch, origin: "import", coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget }).insertedIds.length;
    try { imported += store(entries); } catch {
      for (const entry of entries) { try { imported += store([entry]); } catch { base.skipped.push({ file: entry.concepts[0] ?? "?", reason: "memory budget reached" }); } }
    }
  }
  return { ...base, files: files.length, imported, state: "imported" };
}

export type MemoryExportResult = { runId: string; records: number; written: number; existing: number; removed: number; state: "exported" | "skipped"; reason?: string };

function listAllRecords(db: LanePilotDatabase, projectId: string, personalBot: string): Array<MemoryRecord & { audience: MemoryAudience }> {
  const rows = db.prepare("SELECT id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND status='active' ORDER BY created_at ASC")
    .all(projectId, personalBot) as Array<{ id: string; project_id: string; personal_bot: string; kind: "core" | "note"; audience: MemoryAudience; content: string; concepts_json: string; source_sha256: string; created_at: number }>;
  return rows.map((row) => ({ id: row.id, projectId: row.project_id, personalBot: row.personal_bot, kind: row.kind, audience: row.audience, content: row.content, concepts: JSON.parse(row.concepts_json) as string[], sourceSha256: row.source_sha256, createdAt: row.created_at }));
}

/** SQLite records become lane-memory files for the CLI hooks; files that already exist are left alone. */
export async function exportFileMemory(ctx: ServerCore, input: { projectId: string; runId: string }): Promise<MemoryExportResult> {
  const { db } = ctx;
  const settings: MemorySettings = memorySettingsFor(db, input.projectId);
  const base = { runId: input.runId, records: 0, written: 0, existing: 0, removed: 0 };
  if (!settings.enabled) return { ...base, state: "skipped", reason: "memory_disabled" };
  const place = await placeForRun(ctx, input.projectId, input.runId);
  const present = new Set((await listMemoryFiles(ctx, place)).map((file) => file.name));
  const records = listAllRecords(db, input.projectId, settings.personalBot);
  let written = 0, existing = 0, removed = 0;
  const wanted = new Set(records.map((record) => exportedFileName(record)));
  for (const record of records) {
    const name = exportedFileName(record);
    if (present.has(name)) { existing += 1; continue; }
    await ctx.bb.sdk.files.write({ hostId: place.hostId, rootPath: place.workspace, path: `${place.workspace}/${LANE_MEMORY_DIR}/${name}`, content: renderLaneMemoryFile(record, record.audience), contentEncoding: "utf8", createParents: true, expectedSha256: null });
    written += 1;
  }
  // The files mirror the database: a record deleted there (a revoked rule, a cleaned lesson) leaves the folder too.
  for (const name of present) {
    if (!name.startsWith("lp-") || wanted.has(name)) continue;
    await ctx.bb.sdk.files.remove({ hostId: place.hostId, rootPath: place.workspace, path: `${place.workspace}/${LANE_MEMORY_DIR}/${name}` }).then(() => { removed += 1; }, () => undefined);
  }
  return { ...base, records: records.length, written, existing, removed, state: "exported" };
}

export function mountMemorySync(ctx: ServerCore): void {
  const { bb, db } = ctx;
  registerObservedTool(bb.agents, {
    name: "lane_pilot_memory_import",
    description: "Import the project's file memory (.agents/memory/*.md written by claude-lane) into Lane Pilot's project memory on the hub.",
    instructions: "Use from the active Lane Pilot PM thread, once per project or after the CLI side wrote new records. Sensitivity maps to audience: public → export, internal → subagent, sensitive → owner. Duplicates are not stored twice.",
    parameters: z.object({ runId: z.string().min(1) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      return JSON.stringify(await importFileMemory(ctx, { projectId: context.projectId, runId: params.runId }), null, 2);
    },
  });
  registerObservedTool(bb.agents, {
    name: "lane_pilot_memory_export",
    description: "Mirror Lane Pilot's project memory (the source of truth) into .agents/memory files so terminal claude-lane sessions read the same memory.",
    instructions: "Use from the active Lane Pilot PM thread after maintenance or rule decisions. New records are written, lp-* files whose record is gone are removed; hand-written files are never touched. The CLI's lane-memory rebuilds its index on the next run.",
    parameters: z.object({ runId: z.string().min(1) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      return JSON.stringify(await exportFileMemory(ctx, { projectId: context.projectId, runId: params.runId }), null, 2);
    },
  });
}
