import { z } from "zod";
import { registerObservedTool, type Services } from "../../platform/server";
import { ToolError, type ServerCore } from "../../contracts/server";
import { listDecisions } from "./journal";
import { LEAD_CLASSES } from "./rights";
import { addRoad, getRoad, renderRoadTree, roadTree } from "./road";

/**
 * `lane_pilot_lead`: the one tool of the lead's chat (src/rooms/lead/lead-agent.ts). It reads the state and the journal, keeps the road tree
 * (add with a reason, reject with a reason, mark done), starts a tick and records the owner's word on a proposal given in the chat. It has no
 * way to dispatch, schedule, spend or send: a session that asks for those is told where they live.
 */
const roadId = z.string().min(1).max(60);
const evidence = z.array(z.object({ kind: z.enum(["run", "task", "file", "note", "url", "metric"]), ref: z.string().min(1).max(500), label: z.string().max(120).optional() }).strict()).max(12);
const leadClass = z.string().max(40).refine((cls) => LEAD_CLASSES.includes(cls), { message: `one of ${LEAD_CLASSES.join(", ")}` });

export const leadToolParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("road"), projectId: z.string().min(1).max(200).nullable().optional(), history: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("road_add"), title: z.string().min(1).max(300), kind: z.enum(["direction", "option"]), why: z.string().min(1).max(2000), parentId: roadId.optional(),
    projectId: z.string().min(1).max(200).nullable().optional(), source: z.enum(["owner", "lead"]).default("lead"), evidence: evidence.optional(), costEstimate: z.string().max(120).optional(), class: leadClass.optional() }).strict(),
  z.object({ action: z.literal("road_reject"), roadId, why: z.string().min(10).max(2000) }).strict(),
  z.object({ action: z.literal("road_done"), roadId, note: z.string().max(600).optional() }).strict(),
  z.object({ action: z.literal("journal"), class: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("tick_now") }).strict(),
  z.object({ action: z.literal("decide"), roadId, decision: z.enum(["yes", "later", "no"]), text: z.string().max(600).optional() }).strict(),
]);

export function mountLeadTool(ctx: ServerCore, services: Services): void {
  const { db } = ctx;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_lead",
    description: "The lead's («Штурман») own tool: the state of the road and the rights, the road tree (add, reject with a reason, mark done), the decision journal, one tick now, the owner's word on a proposal given in this chat.",
    instructions: "status: the tree's counts, the open proposals, the tier of every class with its exam numbers, the next and the last ticks. road {projectId?, history?}: the tree as text (history adds rejected and done branches with their reasons). road_add {title, kind: direction|option, why, parentId? (an option needs one; without it the branch goes under the project's root direction), projectId? (null = above projects), source: owner when it is the owner's idea, lead when yours, evidence?, costEstimate?, class?}. road_reject {roadId, why}: why is at least 10 characters; the branch stays in the history with the reason. road_done {roadId, note?}. journal {class?, limit?}: the newest decisions with the prediction and the verdict. tick_now: one tick outside the cron (a graph; its receipt appears in status). decide {roadId, decision: yes|later|no, text?}: only when the owner gave his word on that proposal in this chat. This tool cannot dispatch writers, start workflows, create schedules, spend or send: work goes through the project's PM chat or a proposal the owner accepts.",
    parameters: leadToolParams,
    execute: async (input) => {
      const lead = services.lead;
      switch (input.action) {
        case "status": {
          const state = await lead.state();
          return json({
            enabled: state.settings.enabled, nextTickAt: state.nextTickAt ? new Date(state.nextTickAt).toISOString() : null, running: state.running?.id ?? null,
            identity: { sha: state.identity.sha.slice(0, 12), path: state.identity.path },
            road: state.road, proposalsOpen: state.proposalsOpen, journal: state.journal,
            rights: state.rights.map((row) => ({ class: row.class, tier: row.tier, actsVia: row.actsVia })),
            exam: state.exam.map((exam) => ({ class: exam.class, n: exam.n, decided: exam.k, wilsonLb: exam.wilsonLb, coverage: exam.coverage, kappa: exam.kappa, would: exam.tier, reasons: exam.reasons })),
            lastTicks: state.ticks.slice(0, 5).map((tick) => ({ id: tick.id, status: tick.status, startedAt: new Date(tick.started_at).toISOString(), proposed: JSON.parse(tick.proposed_json ?? "[]").length, costUsd: (tick.cost_micro_usd ?? 0) / 1_000_000 })),
            budgetDailyUsd: state.settings.budgetDailyUsd, maxProposals: state.settings.maxProposals,
          });
        }
        case "road": return renderRoadTree(roadTree(db, { ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), history: input.history ?? false })) || "The road tree is empty.";
        case "road_add": {
          let parentId = input.parentId ?? null;
          if (input.kind === "option" && !parentId) {
            // The project's root direction, made on first use, so an idea from the chat never fails for want of a parent.
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
          try { ok = lead.settle(input.roadId, "reject", "lead-chat", input.why); } catch (cause) { throw new ToolError(cause instanceof Error ? cause.message : String(cause), { code: "lead_refused", retryable: false, sideEffects: "none" }); }
          if (!ok) throw new ToolError(`branch ${input.roadId} is not open, proposed or later (or does not exist)`, { code: "lead_refused", retryable: false, sideEffects: "none" });
          return json({ roadId: input.roadId, state: "rejected" });
        }
        case "road_done": {
          if (!lead.settle(input.roadId, "done", "lead-chat", input.note)) throw new ToolError(`branch ${input.roadId} cannot be marked done from its state (or does not exist)`, { code: "lead_refused", retryable: false, sideEffects: "none" });
          return json({ roadId: input.roadId, state: "done" });
        }
        case "journal": return json(listDecisions(db, { class: input.class, limit: input.limit ?? 20 }).map((row) => ({
          id: row.id, surface: row.surface, class: row.class, risk: row.risk, split: row.split, predicted: row.prediction_json ? JSON.parse(row.prediction_json) : null,
          answered: row.answer_json ? JSON.parse(row.answer_json) : null, by: row.answered_by, verdict: row.judge_verdict, ownerLabel: row.owner_label, at: new Date(row.created_at).toISOString(),
        })));
        case "tick_now": {
          const result = await lead.runTick("manual");
          if (!result.ok) throw new ToolError(result.reason, { code: "lead_tick_not_started", retryable: true, sideEffects: "none" });
          return json(result);
        }
        case "decide": {
          const result = await lead.decide(input.roadId, input.decision, input.text, "lead-chat");
          if (!result.ok) throw new ToolError(result.reason, { code: "lead_refused", retryable: false, sideEffects: "none" });
          return json({ roadId: result.road.id, state: result.road.state, verdict: result.verdict, handover: result.handover });
        }
      }
    },
  });
}
