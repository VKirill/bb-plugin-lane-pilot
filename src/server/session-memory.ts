import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { getRuleProposal, upsertLessonProposal } from "@lane-pilot/run-insights";
import { parseMemoryCandidates, searchMemoryRecords, storeMemoryRecords } from "@lane-pilot/memory-core";
import type { rpcContract } from "../contracts";
import { adoptRuleProposal, memorySettingsFor } from "./insights";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/**
 * Project memory for sessions on any machine — a PM chat, a terminal claude-lane session — so there is one memory,
 * on the hub, wherever the work runs. Claude Lane's lane-memory calls these through `bb plugin rpc call lane-pilot`.
 */
export function sessionMemoryRpc(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  return {
    // The project and section chain a folder on a machine belongs to: the deepest place that contains it.
    session_memory_project: async ({ hostId, path }) => {
      const target = resolve(path);
      const projects = await bb.sdk.projects.list({ includePersonal: true } as never).catch(() => [] as Array<{ id: string }>) as Array<{ id: string }>;
      let best: { projectId: string; scopes: string[]; length: number } | null = null;
      for (const project of projects) {
        for (const place of await services.docsPlaces(project.id).catch(() => [])) {
          const base = resolve(place.path);
          if (place.hostId !== hostId || !(target === base || target.startsWith(`${base}/`))) continue;
          if (!best || base.length > best.length) best = { projectId: project.id, scopes: place.scopes, length: base.length };
        }
      }
      return best ? { projectId: best.projectId, scopes: best.scopes } : { projectId: null, scopes: [] };
    },
    session_memory_write: async ({ projectId, kind, content, concepts, source }) => {
      const settings = memorySettingsFor(db, projectId);
      if (!settings.enabled) return { stored: false, id: null, reason: "memory_disabled" };
      let entries;
      try { entries = parseMemoryCandidates([{ kind, content, concepts }], { ...settings, coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER }); }
      catch (cause) { return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) }; }
      try {
        const result = storeMemoryRecords(db, { projectId, personalBot: settings.personalBot, audience: "subagent",
          sourceSha256: createHash("sha256").update(`session:${source ?? ""}`).digest("hex"), entries,
          coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget });
        return { stored: result.insertedIds.length > 0, id: result.insertedIds[0] ?? null, reason: result.insertedIds.length ? null : "duplicate" };
      } catch (cause) {
        return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    session_memory_search: async ({ projectId, query, limit }) => {
      const settings = memorySettingsFor(db, projectId);
      return { records: searchMemoryRecords(db, projectId, query, limit ?? 8, settings.searchEngine, "subagent", settings.personalBot)
        .map((record) => ({ id: record.id, kind: record.kind, content: record.content, concepts: record.concepts })) };
    },
    session_memory_core: async ({ projectId }) => {
      const rows = db.prepare("SELECT id, content FROM lane_pilot_memory WHERE project_id=? AND kind='core' AND audience='subagent' ORDER BY created_at")
        .all(projectId) as Array<{ id: string; content: string }>;
      return { records: rows };
    },
    // A lesson is a rule proposal: a repeat of a live rule counts towards it, a new one goes on trial within the cap.
    session_lesson: async ({ projectId, rule, evidence, scope }) => {
      const result = upsertLessonProposal(db, projectId, { rule, evidence, scope });
      const adopted = result.created ? Boolean(adoptRuleProposal(db, projectId, result.id)) : false;
      const proposal = getRuleProposal(db, projectId, result.id);
      return { proposalId: result.id, repeatOf: result.repeatOf, state: proposal?.state ?? "proposed", adopted };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "session_memory_project" | "session_memory_write" | "session_memory_search" | "session_memory_core" | "session_lesson">;
}
