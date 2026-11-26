import { z } from "zod";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { ToolError, type ServerCore } from "../../../contracts/server";
import { registerObservedTool } from "../../../platform/server";
import { loadProjectSettings } from "../../../storage";
import { loadIdentity } from "../../identity";
import { LEAD_CLASSES } from "../../models/tick";
import { parseLeadSettings } from "../../settings";
import { addRoad, doneRoad, getRoad, rejectRoad, renderRoadTree, roadCounts, roadTree } from "../repositories/road-repository";
import { listTicks } from "../repositories/tick-repository";

const roadId = z.string().min(1).max(60);
const evidence = z.array(z.object({ kind: z.enum(["run", "task", "file", "note", "url", "metric"]), ref: z.string().min(1).max(500), label: z.string().max(120).optional() }).strict()).max(12);
const leadClass = z.string().max(40).refine((cls) => (LEAD_CLASSES as readonly string[]).includes(cls), { message: `one of ${LEAD_CLASSES.join(", ")}` });

export const leadToolParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("road"), projectId: z.string().min(1).max(200).nullable().optional(), history: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("road_add"), title: z.string().min(1).max(300), kind: z.enum(["direction", "option"]), why: z.string().min(1).max(2000), parentId: roadId.optional(),
    projectId: z.string().min(1).max(200).nullable().optional(), source: z.enum(["owner", "lead"]).default("lead"), evidence: evidence.optional(), costEstimate: z.string().max(120).optional(), class: leadClass.optional() }).strict(),
  z.object({ action: z.literal("road_reject"), roadId, why: z.string().min(10).max(2000) }).strict(),
  z.object({ action: z.literal("road_done"), roadId, note: z.string().max(600).optional() }).strict(),
]);

export function mountLeadTool(ctx: ServerCore): void {
  const { db } = ctx;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_lead",
    description: "The lead's («Штурман») own tool: the state of the road tree, add/reject/done branches.",
    instructions: "status: the tree's counts and last ticks. road {projectId?, history?}: the tree as text. road_add {title, kind: direction|option, why, parentId?, projectId?, source, evidence?, costEstimate?, class?}. road_reject {roadId, why}. road_done {roadId, note?}.",
    parameters: leadToolParams,
    execute: async (input) => {
      switch (input.action) {
        case "status": {
          const settings = parseLeadSettings(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID));
          const identity = loadIdentity();
          const ticks = listTicks(db, 5);
          return json({
            enabled: settings.enabled,
            identity: { sha: identity.sha.slice(0, 12), path: identity.path },
            road: roadCounts(db),
            lastTicks: ticks.map((tick) => ({ id: tick.id, status: tick.status, startedAt: new Date(tick.started_at).toISOString(), proposed: JSON.parse(tick.proposed_json ?? "[]").length, costUsd: (tick.cost_micro_usd ?? 0) / 1_000_000 })),
            budgetDailyUsd: settings.budgetDailyUsd,
            maxProposals: settings.maxProposals,
          });
        }
        case "road": return renderRoadTree(roadTree(db, { ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), history: input.history ?? false })) || "The road tree is empty.";
        case "road_add": {
          let parentId = input.parentId ?? null;
          if (input.kind === "option" && !parentId) {
            const projectId = input.projectId ?? null;
            const id = `dir:${projectId ?? "hub"}`;
            parentId = (getRoad(db, id) ?? addRoad(db, { id, projectId, title: projectId ? `${projectId}: directions` : "Above projects", kind: "direction", source: "lead", why: "the root the lead files a project's branches under when a branch names no parent" })).id;
          }
          try {
            const row = addRoad(db, { parentId, projectId: input.projectId ?? null, title: input.title, kind: input.kind, source: input.source, why: input.why, evidence: input.evidence, costEstimate: input.costEstimate ?? null, class: input.class ?? null });
            return json({ roadId: row.id, state: row.state, parentId: row.parent_id });
          } catch (cause) { throw new ToolError(cause instanceof Error ? cause.message : String(cause), { code: "lead_refused", retryable: false, sideEffects: "none" }); }
        }
        case "road_reject": {
          let ok = false;
          try { ok = rejectRoad(db, input.roadId, input.why, "lead-chat"); } catch (cause) { throw new ToolError(cause instanceof Error ? cause.message : String(cause), { code: "lead_refused", retryable: false, sideEffects: "none" }); }
          if (!ok) throw new ToolError(`branch ${input.roadId} is not open, proposed or later (or does not exist)`, { code: "lead_refused", retryable: false, sideEffects: "none" });
          return json({ roadId: input.roadId, state: "rejected" });
        }
        case "road_done": {
          if (!doneRoad(db, input.roadId, input.note)) throw new ToolError(`branch ${input.roadId} cannot be marked done from its state (or does not exist)`, { code: "lead_refused", retryable: false, sideEffects: "none" });
          return json({ roadId: input.roadId, state: "done" });
        }
      }
    },
  });
}
