import { z } from "zod";
import { ToolError, registerObservedTool, type ServerCore, type Services } from "../../core/server";
import { taskV2Schema } from "../../contracts";
import { PhaseRefusal } from "./driver";

const promise = z.object({ given: z.string().trim().min(1).max(600), when: z.string().trim().min(1).max(600), then: z.string().trim().min(1).max(600) }).strict();
const item = z.object({ id: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(200), wave: z.number().int().min(1).max(20), promise, task: taskV2Schema }).strict();
const phaseId = z.string().trim().min(1).max(40);

const params = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000), legacy: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("status"), phaseId: phaseId.optional() }).strict(),
  z.object({ action: z.literal("context"), phaseId, docs: z.array(z.string().trim().min(1).max(1024)).min(1).max(20),
    risks: z.object({ technical: z.string().max(600), product: z.string().max(600), operations: z.string().max(600), security: z.string().max(600) }).strict() }).strict(),
  z.object({ action: z.literal("plan"), phaseId, items: z.array(item).min(1).max(60), design: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("plan_check"), phaseId, decision: z.enum(["approve", "changes_requested"]), by: z.string().trim().min(1).max(120), summary: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal("drawing"), phaseId, paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(30), designer: z.string().trim().min(1).max(120), feasible: z.boolean(), contradiction: z.string().max(2000).optional(), reviewer: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({ action: z.literal("goal_audit"), phaseId, state: z.enum(["met", "unmet"]), by: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("lessons"), phaseId, analysis: z.string().trim().min(1).max(4000), author: z.string().trim().min(1).max(120), reviewer: z.string().trim().min(1).max(120), reviewedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("question"), phaseId, text: z.string().trim().min(1).max(1000), blocking: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("answer"), phaseId, questionId: z.string().trim().min(1).max(20), answer: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("word"), phaseId, turn: z.enum(["planning", "design", "issue", "wave", "acceptance", "uat"]), decision: z.enum(["yes", "no"]), text: z.string().trim().min(1).max(2000), wave: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ action: z.literal("wave_review"), phaseId, wave: z.number().int().min(1).max(20), state: z.enum(["passed", "failed"]), by: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("withdraw"), phaseId, pieces: z.array(z.string().trim().min(1).max(80)).min(1).max(60), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("revise"), phaseId, goal: z.string().trim().min(1).max(4000), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("correct"), phaseId, note: z.string().trim().min(1).max(4000), pieces: z.array(z.string().trim().min(1).max(80)).max(60).optional() }).strict(),
  z.object({ action: z.literal("return"), phaseId, to: z.enum(["discussion", "planning", "design", "execution"]), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("pause"), phaseId }).strict(),
  z.object({ action: z.literal("resume"), phaseId }).strict(),
  z.object({ action: z.literal("stop_wave"), phaseId }).strict(),
  z.object({ action: z.literal("compensate"), phaseId, note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("close"), phaseId, words: z.string().trim().min(1).max(2000) }).strict(),
]);

const json = (value: unknown) => JSON.stringify(value);

/** No autopilot flags: no action takes force, skip or auto; a phase moves only when its gates pass in code (SMA: No autopilot flags). */
export const NO_AUTOPILOT_FLAGS = ["force", "skip", "auto", "noGates"] as const;

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
            const phase = await api.open({ projectId: context.projectId, pmThreadId: context.threadId, title: input.title, goal: input.goal, legacy: input.legacy });
            return json({ phaseId: phase.id, stage: phase.stage, next: api.status(phase.id).next.text });
          }
          case "status": {
            if (!input.phaseId) return json({ phases: api.list({ pmThreadId: context.threadId, live: true }).map((phase) => ({ id: phase.id, title: phase.title, stage: phase.stage, state: phase.state })) });
            const status = api.status(input.phaseId);
            return json({ phaseId: status.phase.id, stage: status.phase.stage, state: status.phase.state, next: status.next.text, gates: status.gates, book: status.book.slice(0, 6000) });
          }
          case "context": return json(summary(await api.context({ phaseId: input.phaseId, docs: input.docs, risks: input.risks, by: context.threadId })));
          case "plan": return json(summary(api.plan({ phaseId: input.phaseId, items: input.items as never, design: input.design })));
          case "plan_check": return json(summary(await api.planCheck({ phaseId: input.phaseId, decision: input.decision, by: input.by, summary: input.summary })));
          case "drawing": return json(summary(await api.drawing({ phaseId: input.phaseId, paths: input.paths, designer: input.designer, feasible: input.feasible, contradiction: input.contradiction, reviewer: input.reviewer })));
          case "goal_audit": return json(summary(api.goalAudit({ phaseId: input.phaseId, state: input.state, by: input.by, summary: input.summary })));
          case "lessons": return json(summary(api.lessons({ phaseId: input.phaseId, analysis: input.analysis, author: input.author, reviewer: input.reviewer, reviewedHash: input.reviewedHash })));
          case "question": return json(summary(api.question({ phaseId: input.phaseId, text: input.text, blocking: input.blocking })));
          case "answer": return json(summary(api.answer({ phaseId: input.phaseId, questionId: input.questionId, answer: input.answer, by: "pm" })));
          case "word": return json(summary(api.word({ phaseId: input.phaseId, turn: input.turn, decision: input.decision, text: input.text, wave: input.wave, by: "owner via pm" })));
          case "wave_review": return json(summary(api.waveReview({ phaseId: input.phaseId, wave: input.wave, state: input.state, by: input.by, summary: input.summary })));
          case "withdraw": return json(summary(api.withdraw({ phaseId: input.phaseId, pieces: input.pieces, note: input.note, by: "pm" })));
          case "revise": return json(summary(api.revise({ phaseId: input.phaseId, goal: input.goal, note: input.note, by: "pm" })));
          case "correct": { const out = await api.correct({ phaseId: input.phaseId, note: input.note, pieces: input.pieces }); return json({ ...summary(out.phase), sent: out.sent }); }
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
