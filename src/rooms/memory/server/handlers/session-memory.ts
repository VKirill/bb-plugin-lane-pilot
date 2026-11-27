import { evalMemoryImport, formatImportEval, formatImportSummary, maskImportContent, pmTopIds, runMemoryImport, type ImportReport } from "../services/import";
import { embedForDoor } from "../services/embeddings";
import { resolve } from "node:path";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { NOTHING_RELEVANT, listActiveMemoryRows, listMemoryReceipts, memoryConceptsJson, memoryWithoutTrace, projectUsesSections, resolveProjectKind, sharedScope, UNASSIGNED_SCOPE, memoryClaimIssue, parseMemoryCandidates, storeMemoryRecordsKeepingOverflow } from "@lane-pilot/memory-core";
import type { rpcContract } from "../../../contracts";
import { memorySettingsFor } from "../services/memory-settings";
import { explicitMemorySearch } from "../services/memory-search";
import { listCoreMemoryForSession } from "../services/session-memory";
import type { ServerCore } from "../../../contracts/server";

import { sha256Hex } from "@lane-pilot/kit";
import { threadMemoryBlock } from "../services/thread-block";
import { loadProjectSettings, projectHasScopedRun, taskTimelineRow } from "../../../storage";

import type { DocsApi } from "../../../docs/server";
import type { MemoryConflictsApi } from "../services/memory-conflicts";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsPlaces: DocsApi["docsPlaces"];
  memoryConflicts: Pick<MemoryConflictsApi, "detect" | "eraseRecord">;
}

/** Resolves the project and deepest section scope chain that contains `path` on `hostId`. */
export async function projectScopeOf(
  ctx: Pick<ServerCore, "bb" | "log">,
  services: Pick<Services, "docsPlaces">,
  { hostId, path }: { hostId: string; path: string },
): Promise<{ projectId: string | null; scopes: string[] }> {
  const target = resolve(path);
  const projects = await ctx.bb.sdk.projects.list({ includePersonal: true } as never) as Array<{ id: string }>;
  let best: { projectId: string; scopes: string[]; length: number } | null = null;
  for (const project of projects) {
    for (const place of await services.docsPlaces(project.id).catch((cause: unknown) => { ctx.log(`session memory: docs places of ${project.id} unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return []; })) {
      const base = resolve(place.path);
      if (place.hostId !== hostId || !(target === base || target.startsWith(`${base}/`))) continue;
      if (!best || base.length > best.length) best = { projectId: project.id, scopes: place.scopes, length: base.length };
    }
  }
  return best ? { projectId: best.projectId, scopes: best.scopes } : { projectId: null, scopes: [] };
}

/**
 * Project memory on the hub, for any machine. (2026-10-29) lane-memory no longer calls these.
 */
export function sessionMemoryRpc(ctx: ServerCore, services: Services) {
  const { db } = ctx;
  return {
    // The project and section chain a folder on a machine belongs to: the deepest place that contains it.
    session_memory_project: ({ hostId, path }) => projectScopeOf(ctx, services, { hostId, path }),
    memory_import: async ({ source, projectId, jsonl, dryRun }) => {
      const texts: string[] = [];
      for (const raw of jsonl.split("\n")) { try { const line = JSON.parse(raw) as { content?: unknown }; if (typeof line.content === "string") texts.push(maskImportContent(line.content)); } catch { /* the import reports the bad line */ } }
      const vectors = await embedForDoor(texts);
      const report = runMemoryImport({ db, projectId, source, jsonl, settings: memorySettingsFor(loadProjectSettings(db, projectId)), dryRun: dryRun === true, vectors });
      return { ...report, summary: formatImportSummary(report) };
    },
    memory_import_eval: async ({ report }) => {
      const typed = report as unknown as ImportReport;
      const settings = memorySettingsFor(loadProjectSettings(db, typed.projectId));
      const result = evalMemoryImport(typed, (query) => pmTopIds(db, typed.projectId, query, settings));
      return { ...result, summary: formatImportEval(result) };
    },
    session_memory_write: async ({ projectId, kind, content, concepts, source, chain }) => {
      const settings = memorySettingsFor(loadProjectSettings(db, projectId));
      if (!settings.enabled) return { stored: false, id: null, reason: "memory_disabled" };
      let entries;
      try { entries = parseMemoryCandidates([{ kind, content, concepts }], { ...settings, coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER }); }
      catch (cause) { return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) }; }
      // A list packed into one record is refused at the door (memory.single_claim): one record carries one claim.
      if (settings.singleClaim) for (const entry of entries) { const issue = memoryClaimIssue(entry.content); if (issue) return { stored: false, id: null, reason: issue }; }
      const vectors = await embedForDoor(entries.map((entry) => entry.content));
      try {
        const result = storeMemoryRecordsKeepingOverflow(db, { vectorOf: (content) => vectors.get(content), projectId, personalBot: settings.personalBot, audience: "subagent",
          sourceSha256: sha256Hex(`session:${source ?? ""}`), entries, scope: chain?.length ? chain
            : resolveProjectKind(settings.projectKind, projectUsesSections(db, projectId, projectHasScopedRun)) === "umbrella"
              // Root work of an umbrella is project work: shared as project:root; only an undefined source is unassigned.
              ? concepts?.some((concept) => /^shared/.test(concept)) ? sharedScope(concepts.find((concept) => /^shared:/.test(concept))?.split(":")[1])
                : source ? sharedScope("root") : [...UNASSIGNED_SCOPE]
              : [],
          // One CLI session is one voice: its note reaches writers once a second source states it or a day has passed.
          trust: "observed", origin: "session",
          coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget });
        try { services.memoryConflicts.detect(projectId, new Set(result.insertedIds)); } catch { /* the write stands; the conflict check is retried by the next write */ }
        const id = result.insertedIds[0] ?? result.corroboratedIds[0] ?? result.duplicateIds[0] ?? null;
        return { stored: result.insertedIds.length > 0, id, reason: result.insertedIds.length ? null : result.corroboratedIds.length ? "corroborated" : "duplicate" };
      } catch (cause) {
        return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    session_memory_search: async ({ projectId, query, limit, chain }) => {
      const settings = memorySettingsFor(loadProjectSettings(db, projectId));
      // The session sees its own fresh notes. A missing chain is the project root, not every section.
      const result = await explicitMemorySearch(db, { projectId, query, limit: limit ?? 8, memory: settings, chain: chain ?? [], umbrella: resolveProjectKind(settings.projectKind, projectUsesSections(db, projectId, projectHasScopedRun)) === "umbrella" });
      const records = result.records.map((record) => ({ id: record.id, kind: record.kind, content: record.content, concepts: record.concepts }));
      if (!records.length) return { records, nothingRelevant: true, message: NOTHING_RELEVANT };
      return { records };
    },
    // Proven facts first (accepted, then used, then newest). A missing chain is the project root. Observed notes still in quarantine stay out.
    session_memory_core: async ({ projectId, chain }) => {
      const settings = memorySettingsFor(loadProjectSettings(db, projectId));
      const rows = listCoreMemoryForSession(db, projectId, settings.personalBot, chain ?? [], settings.scope ?? "section");
      return { records: rows, receipts: listMemoryReceipts(db as never, projectId, 10) };
    },
    // The same block contributeInstructions gives an ordinary thread (M2); the drill reads it for a thread id.
    memory_thread_block: async ({ projectId, threadId }) => ({ block: threadMemoryBlock(db, { projectId, threadId }) }),
    memory_records_list: async ({ projectId }) => {
      const rows = listActiveMemoryRows(db as never, projectId, 500);
      const noTrace = new Set(memoryWithoutTrace(db as never, projectId).map((row) => row.id));
      const runIdByTaskId = new Map<string, string | null>();
      const resolveOriginRunId = (taskId: string | null): string | null => {
        if (!taskId) return null;
        if (!runIdByTaskId.has(taskId)) {
          runIdByTaskId.set(taskId, taskTimelineRow(db, taskId)?.run_id ?? null);
        }
        return runIdByTaskId.get(taskId) ?? null;
      };
      return {
        records: rows.map((row) => {
          let concepts: string[] = [];
          try { concepts = JSON.parse(row.concepts_json) as string[]; } catch { concepts = []; }
          return {
            id: row.id, kind: row.kind, audience: row.audience, content: row.content, concepts,
            createdAt: row.created_at, rule: concepts.includes("rule"), useCount: row.use_count,
            acceptedCount: row.accepted_count, originTaskId: row.origin_task_id,
            originRunId: resolveOriginRunId(row.origin_task_id),
            sourceFileId: row.source_file_id,
            noTrace: noTrace.has(row.id), origin: row.origin,
            scope: (() => {
              try {
                const v = JSON.parse(row.scope_json ?? "[]") as unknown;
                return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
              } catch { return []; }
            })(),
            sources: row.sources,
          };
        }),
      };
    },
    memory_record_delete: async ({ projectId, id }) => {
      const conceptsJson = memoryConceptsJson(db as never, projectId, id);
      if (conceptsJson === null) return { deleted: false, reason: "not_found", leftovers: [] };
      if (conceptsJson.includes('"rule"')) return { deleted: false, reason: "rule", leftovers: [] };
      const leftovers = services.memoryConflicts.eraseRecord(projectId, id);
      return { deleted: true, reason: leftovers.length ? `leftovers: ${leftovers.join(",")}` : null, leftovers };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "memory_import" | "memory_import_eval" | "session_memory_project" | "session_memory_write" | "session_memory_search" | "session_memory_core" | "memory_thread_block" | "memory_records_list" | "memory_record_delete">;
}
