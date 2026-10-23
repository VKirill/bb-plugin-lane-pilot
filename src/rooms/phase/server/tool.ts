import { z } from "zod";
import { ToolError, registerObservedTool, type ServerCore, type Services } from "../../core/server";
import { taskV2Schema } from "../../contracts";
import { PhaseRefusal } from "./driver";

const promise = z.object({ given: z.string().trim().min(1).max(600), when: z.string().trim().min(1).max(600), then: z.string().trim().min(1).max(600) }).strict();
const item = z.object({ id: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(200), wave: z.number().int().min(1).max(20), promise, task: taskV2Schema }).strict();
const phaseId = z.string().trim().min(1).max(40);

const params = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("status"), phaseId: phaseId.optional() }).strict(),
  z.object({ action: z.literal("context"), phaseId, docs: z.array(z.string().trim().min(1).max(1024)).min(1).max(20) }).strict(),
  z.object({ action: z.literal("plan"), phaseId, items: z.array(item).min(1).max(60), design: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("plan_check"), phaseId, decision: z.enum(["approve", "changes_requested"]), by: z.string().trim().min(1).max(120), summary: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal("drawing"), phaseId, paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(30), designer: z.string().trim().min(1).max(120), feasible: z.boolean(), contradiction: z.string().max(2000).optional(), reviewer: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({ action: z.literal("goal_audit"), phaseId, state: z.enum(["met", "unmet"]), by: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("lessons"), phaseId, analysis: z.string().trim().min(1).max(4000), reviewer: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("return"), phaseId, to: z.enum(["discussion", "planning", "design", "execution"]), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("pause"), phaseId }).strict(),
  z.object({ action: z.literal("resume"), phaseId }).strict(),
  z.object({ action: z.literal("stop_wave"), phaseId }).strict(),
  z.object({ action: z.literal("compensate"), phaseId, note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("close"), phaseId, words: z.string().trim().min(1).max(2000) }).strict(),
]);

const json = (value: unknown) => JSON.stringify(value);

/** The PM's one tool for phases: it reports what each stage produced; the phase driver decides, in code, whether the phase moves on. */
export function registerPhaseTool(ctx: ServerCore, services: Services): void {
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_phase",
    description: "A phase on rails: the owner's goal taken through discussion, planning, design, execution, verification, acceptance and lessons; Lane Pilot checks each stage in code and moves the phase.",
    instructions: "Use for a goal bigger than one task. `open` (title, goal) starts a phase at discussion. Lane Pilot then tells you, at every turn, the one thing the stage needs; do that and report it here: `context` (docs: the discussion's files in the project — Lane Pilot reads and signs them), `plan` (items: each {id, title, wave, promise:{given, when, then}, task:<task-v2 with the same id>}; depends_on only on pieces of earlier waves), `plan_check` (the independent checker's decision), `drawing` (paths, designer, feasible, reviewer — another role than the designer), `goal_audit` (the lp.close audit: met or unmet), `lessons` (analysis and its reviewer). You do not dispatch the plan's pieces: Lane Pilot issues each wave itself once the plan is admitted and the previous wave is accepted, runs the blind verification and the acceptance lines, and tells you what holds. A refusal lists exactly which gate failed. Controls: `return` (to an earlier stage with a note — from execution back to discussion is allowed), `pause` / `resume`, `stop_wave` (cancels the queued pieces), `compensate` (reverts the accepted pieces), `close` (with the words why it ends). `status` shows the phase, its next action and its book.",
    parameters: params,
    execute: async (input, context) => {
      const api = services.phases;
      try {
        switch (input.action) {
          case "open": {
            const phase = api.open({ projectId: context.projectId, pmThreadId: context.threadId, title: input.title, goal: input.goal });
            return json({ phaseId: phase.id, stage: phase.stage, next: api.status(phase.id).next.text });
          }
          case "status": {
            if (!input.phaseId) return json({ phases: api.list({ pmThreadId: context.threadId, live: true }).map((phase) => ({ id: phase.id, title: phase.title, stage: phase.stage, state: phase.state })) });
            const status = api.status(input.phaseId);
            return json({ phaseId: status.phase.id, stage: status.phase.stage, state: status.phase.state, next: status.next.text, gates: status.gates, book: status.book.slice(0, 6000) });
          }
          case "context": return json(summary(await api.context({ phaseId: input.phaseId, docs: input.docs, by: context.threadId })));
          case "plan": return json(summary(api.plan({ phaseId: input.phaseId, items: input.items as never, design: input.design })));
          case "plan_check": return json(summary(api.planCheck({ phaseId: input.phaseId, decision: input.decision, by: input.by, summary: input.summary })));
          case "drawing": return json(summary(await api.drawing({ phaseId: input.phaseId, paths: input.paths, designer: input.designer, feasible: input.feasible, contradiction: input.contradiction, reviewer: input.reviewer })));
          case "goal_audit": return json(summary(api.goalAudit({ phaseId: input.phaseId, state: input.state, by: input.by, summary: input.summary })));
          case "lessons": return json(summary(api.lessons({ phaseId: input.phaseId, analysis: input.analysis, reviewer: input.reviewer })));
          case "return": return json(summary(api.returnTo({ phaseId: input.phaseId, to: input.to, note: input.note, by: "pm" })));
          case "pause": case "resume": return json(summary(api.setState({ phaseId: input.phaseId, state: input.action, by: "pm" })));
          case "close": return json(summary(api.setState({ phaseId: input.phaseId, state: "close", words: input.words, by: "pm" })));
          case "stop_wave": { const out = await api.stopWave({ phaseId: input.phaseId }); return json({ ...summary(out.phase), canceled: out.canceled }); }
          case "compensate": { const out = await api.compensate({ phaseId: input.phaseId, note: input.note }); return json({ ...summary(out.phase), reverted: out.results }); }
        }
      } catch (cause) {
        if (cause instanceof PhaseRefusal) throw new ToolError(`${cause.message}${cause.why.length ? `: ${cause.why.join("; ")}` : ""}`, { code: "phase_gate", retryable: false, sideEffects: "none" });
        throw cause;
      }
      function summary(phase: { id: string; stage: string; state: string }) {
        return { phaseId: phase.id, stage: phase.stage, state: phase.state, next: api.status(phase.id).next.text };
      }
    },
  });
}
