import { z } from "zod";
import { ToolError, registerObservedTool, type ServerCore, type Services } from "../../core/server";
import { taskV2Schema } from "../../contracts";
import { PhaseRefusal } from "./driver";
import { autoDue } from "./auto-stages";
import { STAGE_RUBRICS } from "../stages";
import { WORD_TURNS } from "../logic";

/**
 * A PM often sends a list, an object, a number or a yes/no as JSON text ("[\"a.md\"]"), mostly when the tool's schema came
 * through ToolSearch (live phase ph_9ed0f7f04b, 2026-10-24: its first context report was refused for it). Such a field also takes
 * the JSON text of its own type.
 */
function asJson<S extends z.ZodType>(schema: S) {
  // preprocess, not union: a union's failure reports «Invalid input» and hides the field's real reasons; a preprocessed string
  // reaches the one schema, so the error names the path (items.2.task.project_cwd: required). PH1.
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value) as unknown; } catch { return value; }
  }, schema);
}

const promise = z.object({ given: z.string().trim().min(1).max(600), when: z.string().trim().min(1).max(600), then: z.string().trim().min(1).max(600) }).strict();
// The machine's own plan format keeps `covers` inside the task (plan.json tasks[].covers); lift it to the item before the strict
// task schema rejects the key. project_cwd the tool fills from the phase's checkout — the phase knows its project (PH1).
const item = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const row = value as { covers?: unknown; task?: unknown };
  if (!row.task || typeof row.task !== "object" || !("covers" in row.task)) return value;
  const { covers: taskCovers, ...task } = row.task as Record<string, unknown>;
  return { ...row, task, covers: row.covers ?? taskCovers };
}, z.object({ id: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(1000), wave: z.number().int().min(1).max(20), promise, task: taskV2Schema.extend({ project_cwd: z.string().startsWith("/").optional() }),
  covers: z.array(z.string().trim().min(1).max(40)).max(40).optional() }).strict());
const phaseId = z.string().trim().min(1).max(40);

export const phaseToolParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), title: z.string().trim().min(1).max(1000), goal: z.string().trim().min(1).max(4000), legacy: asJson(z.boolean()).optional(), roadmapRow: z.string().regex(/^\d+(\.\d+)*$/).optional() }).strict(),
  z.object({ action: z.literal("status"), phaseId: phaseId.optional() }).strict(),
  z.object({ action: z.literal("next"), phaseId }).strict(),
  z.object({ action: z.literal("rubric"), stage: z.enum(["discussion", "planning", "design", "execution", "verification", "acceptance", "lessons"]).optional(), phaseId: phaseId.optional() }).strict(),
  z.object({ action: z.literal("context"), phaseId, docs: asJson(z.array(z.string().trim().min(1).max(1024)).min(1).max(20)),
    risks: asJson(z.object({ value: z.string().max(600), usability: z.string().max(600), feasibility: z.string().max(600), viability: z.string().max(600), security: z.string().max(600).optional() }).strict()),
    appetite: z.string().trim().min(1).max(600), noGos: asJson(z.array(z.string().trim().min(1).max(300)).min(1).max(30)),
    requirements: asJson(z.array(z.string().trim().min(1).max(40)).max(100)).optional(), decisions: asJson(z.array(z.string().trim().min(1).max(40)).max(100)).optional() }).strict(),
  z.object({ action: z.literal("plan"), phaseId, items: asJson(z.array(item).min(1).max(60)), design: asJson(z.boolean()).optional() }).strict(),
  z.object({ action: z.literal("plan_check"), phaseId, decision: z.enum(["approve", "changes_requested"]), by: z.string().trim().min(1).max(120), summary: z.string().max(2000).optional(), wfRunId: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ action: z.literal("drawing"), phaseId, paths: asJson(z.array(z.string().trim().min(1).max(1024)).min(1).max(30)), designer: z.string().trim().min(1).max(120), feasible: asJson(z.boolean()), contradiction: z.string().max(2000).optional(), reviewer: z.string().trim().min(1).max(120).optional(),
    critique: asJson(z.object({ scores: z.record(z.string(), z.number().int().min(0).max(3)), verdict: z.enum(["pass", "rework"]), notes: z.string().max(2000) }).strict()).optional(), lesson: z.string().trim().min(5).max(300).optional() }).strict(),
  z.object({ action: z.literal("goal_audit"), phaseId, state: z.enum(["met", "unmet"]), by: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000) }).strict(),
  // The lessons name the workflow run whose reviewer step read them; author, reviewer and the read are taken from its journal (SMA p7_saw_bytes).
  z.object({ action: z.literal("lessons"), phaseId, analysis: z.string().trim().min(1).max(4000), reviewRun: z.string().trim().min(1).max(120), reviewerNode: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ action: z.literal("question"), phaseId, text: z.string().trim().min(1).max(1000), blocking: asJson(z.boolean()).default(true) }).strict(),
  z.object({ action: z.literal("answer"), phaseId, questionId: z.string().trim().min(1).max(20), answer: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("word"), phaseId, turn: z.enum(WORD_TURNS), decision: z.enum(["yes", "no"]), text: z.string().trim().min(1).max(2000), wave: z.number().int().min(1).max(20).optional(),
    useful: asJson(z.boolean()).optional(), limits: asJson(z.boolean()).optional(),
    /** The acceptance package the owner was shown (status ownerWord.acceptanceKey): a yes counts only for that package. */ key: z.string().trim().max(64).optional() }).strict(),
  z.object({ action: z.literal("wave_review"), phaseId, wave: asJson(z.number().int().min(1).max(20)), state: z.enum(["passed", "failed"]), by: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("withdraw"), phaseId, pieces: asJson(z.array(z.string().trim().min(1).max(80)).min(1).max(60)), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("revise"), phaseId, goal: z.string().trim().min(1).max(4000), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("correct"), phaseId, note: z.string().trim().min(1).max(4000), pieces: asJson(z.array(z.string().trim().min(1).max(80)).max(60)).optional() }).strict(),
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
    instructions: "With the project setting phase.rails on (off by default) the machine drives the train: when the owner's message is a heavy goal, Lane Pilot opens its phase and runs the stages itself — the analysis and CONTEXT.md, the plan with its critic, the waves, the wave review, the goal audit — and reports them through the gates; a small job or a batch goes down the small-task graph on its own. You are the door: you talk with the owner, answer the stages' questions (`answer`), relay the owner's corrections (`revise`, `return`, `correct`) and report only what Lane Pilot leaves to you (the drawing, the lessons); a report of a stage the machine runs is refused. A stage whose workflow failed twice, or a verification that failed after two machine replans, is not handed to you: the machine cuts the scope (withdraws what is not proved, closes the phase on what is, or stops it when nothing is), starts the hunters, writes the backlog item and the owner's morning line, and sends you one notice. `open` (title, goal) starts a phase at discussion yourself. Lane Pilot then tells you, at every turn, the one thing the stage needs; do that and report it here: `context` (docs: the discussion's files in the project — Lane Pilot reads and signs them), `plan` (items: each {id, title, wave, promise:{given, when, then}, task:<task-v2 with the same id>}; depends_on only on pieces of earlier waves), `plan_check` (the independent checker's decision), `drawing` (paths, designer, feasible, reviewer — another role than the designer), `goal_audit` (the lp.close audit: met or unmet), `lessons` (analysis and its reviewer). You do not dispatch the plan's pieces: Lane Pilot issues each wave itself once the plan is admitted and the previous wave is accepted, runs the blind verification and the acceptance lines, and tells you what holds. A refusal lists exactly which gate failed. Controls: `return` (to an earlier stage with a note — from execution back to discussion is allowed), `pause` / `resume`, `stop_wave` (cancels the queued pieces), `compensate` (reverts the accepted pieces), `close` (with the words why it ends). `status` shows the phase, its next action and its book; `next` only the next step; `rubric` the order of work and the blocking antipatterns of a stage. Open a roadmap row with roadmapRow (lane-plan ROADMAP.md): when the phase closes Lane Pilot writes SUMMARY.md, marks the row and STATE, and names the next row (with phase.autonomous on it opens it). A piece may name covers:[requirement and locked decision ids] — the plan must cover every id given at context.",
    parameters: phaseToolParams,
    execute: async (input, context) => {
      const api = services.phases;
      try {
        // A stage the machine runs — or would run on its next pass — is not reported by the PM: the machine drives the train, the PM is
        // the door (Matvey #31766). It reports only what the machine leaves to it: the drawing, the lessons (a stage whose tries are spent is ended by the machine: auto-stages `exhausted`).
        const OWN: Record<string, string[]> = { context: ["analyze", "resign"], plan: ["plan"], plan_check: ["plan"], wave_review: ["review"], goal_audit: ["close"], lessons: ["lessons"], drawing: ["draw"] };
        if (OWN[input.action] && "phaseId" in input && input.phaseId) {
          const phase = api.status(input.phaseId).phase;
          const auto = phase.record.auto;
          const due = autoDue(phase);
          if (auto || (due && OWN[input.action]!.includes(due.kind))) {
            throw new PhaseRefusal(`Lane Pilot runs this stage itself${auto ? ` (run ${auto.wfRunId})` : " on its next pass"}; its result goes through the gates by itself and you get the next step. Do not report it; tell the owner where the phase is if he asks, and answer the stage's questions (answer) when they come.`);
          }
        }
        switch (input.action) {
          case "open": {
            const phase = await api.open({ projectId: context.projectId, pmThreadId: context.threadId, title: input.title, goal: input.goal, legacy: input.legacy, roadmapRow: input.roadmapRow });
            return json({ phaseId: phase.id, stage: phase.stage, next: api.status(phase.id).next.text });
          }
          case "status": {
            if (!input.phaseId) return json({ phases: api.list({ pmThreadId: context.threadId, live: true }).map((phase) => ({ id: phase.id, title: phase.title, stage: phase.stage, state: phase.state })) });
            const status = api.status(input.phaseId);
            // bookHead: the last part's hash, which names the book this status was read from.
            return json({ phaseId: status.phase.id, stage: status.phase.stage, state: status.phase.state, next: status.next.text, bookHead: status.bookHead, gates: status.gates, book: status.book.slice(0, 6000) });
          }
          case "next": { const status = api.status(input.phaseId); return json({ phaseId: input.phaseId, stage: status.phase.stage, next: status.next.text, waitsForYou: status.next.waitsForPm, bookHead: status.bookHead }); }
          case "rubric": {
            // Without a stage the phase's own stage is meant (a PM asked for the rubric of its phase by phaseId alone).
            const stage = input.stage ?? (input.phaseId ? api.status(input.phaseId).phase.stage : undefined);
            if (!stage || !(stage in STAGE_RUBRICS)) throw new PhaseRefusal("rubric names a stage (discussion … lessons), or a phaseId whose phase is at one");
            return json({ stage, ...STAGE_RUBRICS[stage as keyof typeof STAGE_RUBRICS] });
          }
          case "context": return json(summary(await api.context({ phaseId: input.phaseId, docs: input.docs, risks: input.risks, appetite: input.appetite, noGos: input.noGos, requirements: input.requirements, decisions: input.decisions, by: context.threadId })));
          case "plan": {
            // PH1: the machine's own plan format keeps `covers` inside the task (plan.json tasks[].covers); the item carries them
            // either way — task.covers is lifted to item.covers. project_cwd falls back to the PM chat's checkout: the phase knows
            // its project, the planner does not have to repeat it on every piece.
            const phase = api.status(input.phaseId).phase;
            const pm = await ctx.bb.sdk.threads.get({ threadId: phase.pmThreadId }).catch(() => null) as { environmentId?: string } | null;
            const env = pm?.environmentId ? await ctx.bb.sdk.environments.get({ environmentId: pm.environmentId }).catch(() => null) as { path?: string } | null : null;
            const cwd = typeof env?.path === "string" && env.path ? env.path : null;
            const items = (input.items as Array<{ covers?: string[]; task: { covers?: string[]; project_cwd?: string } & Record<string, unknown> }>).map((row) => {
              const { covers: taskCovers, ...task } = row.task;
              const covers = row.covers?.length ? row.covers : Array.isArray(taskCovers) ? taskCovers : undefined;
              return { ...row, task: { ...task, project_cwd: task.project_cwd || cwd }, ...(covers ? { covers } : {}) };
            });
            return json(summary(api.plan({ phaseId: input.phaseId, items: items as never, design: input.design })));
          }
          case "plan_check": return json(summary(await api.planCheck({ phaseId: input.phaseId, decision: input.decision, by: input.by, summary: input.summary, wfRunId: input.wfRunId })));
          case "drawing": return json(summary(await api.drawing({ phaseId: input.phaseId, paths: input.paths, designer: input.designer, feasible: input.feasible, contradiction: input.contradiction, reviewer: input.reviewer, critique: input.critique as never, lesson: input.lesson })));
          case "goal_audit": return json(summary(api.goalAudit({ phaseId: input.phaseId, state: input.state, by: input.by, summary: input.summary })));
          case "lessons": return json(summary(api.lessons({ phaseId: input.phaseId, analysis: input.analysis, reviewRun: input.reviewRun, reviewerNode: input.reviewerNode })));
          case "question": return json(summary(api.question({ phaseId: input.phaseId, text: input.text, blocking: input.blocking })));
          case "answer": return json(summary(api.answer({ phaseId: input.phaseId, questionId: input.questionId, answer: input.answer, by: "pm" })));
          case "word": return json(summary(await api.word({ phaseId: input.phaseId, turn: input.turn, decision: input.decision, text: input.text, wave: input.wave, useful: input.useful, limits: input.limits, key: input.key, by: "owner via pm" })));
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
