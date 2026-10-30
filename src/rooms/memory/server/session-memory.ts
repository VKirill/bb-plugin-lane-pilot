import { resolve } from "node:path";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { getRuleProposal, upsertLessonProposal } from "@lane-pilot/run-insights";
import { DEFAULT_RELEVANCE_FLOOR, NOTHING_RELEVANT, projectUsesSections, resolveProjectKind, sharedScope, UNASSIGNED_SCOPE, memoryVisibilitySql, parseMemoryCandidates, relevantRecords, searchMemoryRecords, storeMemoryRecordsKeepingOverflow } from "@lane-pilot/memory-core";
import type { rpcContract } from "../../contracts";
import { adoptRuleProposal, memorySettingsFor } from "../../self-repair/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { sha256Hex } from "@lane-pilot/kit";

/**
 * Project memory on the hub, for any machine. (2026-10-29) Claude Lane's lane-memory no longer calls these.
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
    session_memory_write: async ({ projectId, kind, content, concepts, source, chain }) => {
      const settings = memorySettingsFor(db, projectId);
      if (!settings.enabled) return { stored: false, id: null, reason: "memory_disabled" };
      let entries;
      try { entries = parseMemoryCandidates([{ kind, content, concepts }], { ...settings, coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER }); }
      catch (cause) { return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) }; }
      try {
        const result = storeMemoryRecordsKeepingOverflow(db, { projectId, personalBot: settings.personalBot, audience: "subagent",
          sourceSha256: sha256Hex(`session:${source ?? ""}`), entries, scope: chain?.length ? chain
            : resolveProjectKind(settings.projectKind, projectUsesSections(db, projectId)) === "umbrella"
              ? concepts?.some((concept) => /^shared/.test(concept)) ? sharedScope(concepts.find((concept) => /^shared:/.test(concept))?.split(":")[1]) : [...UNASSIGNED_SCOPE]
              : [],
          // One CLI session is one voice: its note reaches writers once a second source states it or a day has passed.
          trust: "observed", origin: "session",
          coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget });
        try { services.memoryConflicts.detect(projectId, new Set(result.insertedIds)); } catch { /* the write stands; the conflict check is retried by the next write */ }
        const id = result.insertedIds[0] ?? result.corroboratedIds[0] ?? null;
        return { stored: result.insertedIds.length > 0, id, reason: result.insertedIds.length ? null : result.corroboratedIds.length ? "corroborated" : "duplicate" };
      } catch (cause) {
        return { stored: false, id: null, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    session_memory_search: async ({ projectId, query, limit, chain }) => {
      const settings = memorySettingsFor(db, projectId);
      // The session sees its own fresh notes. A missing chain is the project root, not every section.
      const wanted = limit ?? 8;
      // The floor drops records, so the search looks further than the limit to fill it; a query nothing clears gets the explicit «nothing» next to the empty list.
      const found = searchMemoryRecords(db, projectId, query, Math.min(100, Math.max(40, wanted * 4)), settings.searchEngine, "subagent", settings.personalBot, { includeObserved: true, chain: chain ?? [], umbrella: resolveProjectKind(settings.projectKind, projectUsesSections(db, projectId)) === "umbrella" });
      const records = relevantRecords(db, projectId, query, found, { audience: "subagent", personalBot: settings.personalBot, floor: settings.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR }).slice(0, wanted)
        .map((record) => ({ id: record.id, kind: record.kind, content: record.content, concepts: record.concepts }));
      return records.length ? { records } : { records, nothingRelevant: true, message: NOTHING_RELEVANT };
    },
    // Proven facts first (accepted, then used, then newest). A missing chain is the project root. Observed notes still in quarantine stay out.
    session_memory_core: async ({ projectId, chain }) => {
      const settings = memorySettingsFor(db, projectId);
      const rows = db.prepare(`SELECT id, content FROM lane_pilot_memory m WHERE m.project_id=? AND m.kind='core' AND m.audience='subagent' AND m.personal_bot=? AND ${memoryVisibilitySql(db, "m", { chain: chain ?? [] })} ORDER BY m.accepted_count DESC, m.use_count DESC, m.created_at DESC`)
        .all(projectId, settings.personalBot) as Array<{ id: string; content: string }>;
      return { records: rows };
    },
    // A lesson is a rule proposal: a repeat of a live rule counts towards it, a new one goes on trial within the cap.
    session_lesson: async ({ projectId, rule, evidence, scope, audience, always }) => {
      // audience may be `specialist:<id>` (wider than RuleAudience — the column is TEXT); the employee's slice reads it back.
      const result = upsertLessonProposal(db, projectId, { rule, evidence, scope, audience: audience as never, always });
      // audience `specialist:<id>` also appends a dated line to `lp.role.lines` — the section the specialist's brief renders.
      const employee = /^specialist:([\w-]{1,60})$/.exec(audience ?? "")?.[1];
      if (employee) {
        const { recordRoleLine } = await import("../../native-agent");
        await recordRoleLine(ctx.bb.storage.kv, projectId, employee, rule).catch(() => undefined);
      }
      const adopted = result.created ? Boolean(adoptRuleProposal(db, projectId, result.id)) : false;
      const proposal = getRuleProposal(db, projectId, result.id);
      return { proposalId: result.id, repeatOf: result.repeatOf, state: proposal?.state ?? "proposed", adopted };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "session_memory_project" | "session_memory_write" | "session_memory_search" | "session_memory_core" | "session_lesson">;
}
