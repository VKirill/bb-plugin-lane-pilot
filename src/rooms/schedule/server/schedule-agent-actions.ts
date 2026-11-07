import type { NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { loadPushConfig, postOwnerItem } from "../../owner-waiting";
import { agentOutcomeOf, agentOwnerLine, alreadyHandedOver, handOverTrailer, renderAgentOutcome, type HandOver } from "../outcome";
import { createScheduleStore } from "../store";
import type { ScheduleTask } from "../model";
import { agentBrief } from "./schedule-agent-brief";
import { parseMoment, wallClock } from "../time";
import type { ChainRuntime } from "../../workflow/server";
import type { ServerCore } from "../../contracts/server";

import type { PhaseIntake } from "../../phase/server/intake";
import type { ScheduleService } from "./schedule-service";
import type { WorkflowTriggersApi } from "../../workflow/server/workflow-triggers-live";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  phaseIntake: PhaseIntake;
  schedules: ScheduleService;
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}


/**
 * The two code steps of the graph `workflows/agent-routine.json`, the body of a schedule of kind agent. `lp.agent_brief` writes the agent's first
 * message from the run's inputs (the standing task, the earlier runs, the project's notes: schedule-agent-brief.ts). `lp.agent_outcome` is what used
 * to happen when the agent's thread ended: the outcome becomes the run's report (the next run reads it back), a code change goes to Lane Pilot's
 * intake when the project has Lane Pilot, one line goes to the owner's list. The agent's own step, the limits, the journal and the checks are the engine's.
 * `schedule.create` is the board's door for graphs: a step put off becomes one scheduled run of the graph (telegram-send's `send_at`).
 */
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const AGENT_TASK_FIELDS = (c: StepContext<ChainRuntime>): Extract<ScheduleTask, { kind: "agent" }> => ({
  kind: "agent", agentId: text(c.resolve("$inputs.agentId")), task: text(c.resolve("$inputs.task")),
  authorized: c.resolve("$inputs.authorized") === true,
  accounts: Array.isArray(c.resolve("$inputs.accounts")) ? (c.resolve("$inputs.accounts") as unknown[]).map(String) : [],
  historyRuns: Number(c.resolve("$inputs.historyRuns") ?? 0) || 0,
} as Extract<ScheduleTask, { kind: "agent" }>);

export function registerAgentRoutineActions(engine: WorkflowEngine, ctx: ServerCore, services: Services): void {
  const { db, bb } = ctx;

  /**
   * `schedule.create`: a graph puts a step off by scheduling one run of a graph at a moment. The moment is the run's own input named by `field`
   * (default `send_at`): a delay («+2h», «30m») or a wall-clock time in the owner's zone («2026-11-03T07:00»). The run's inputs minus that field
   * become the scheduled run's inputs, so the scheduled run does the step instead of putting it off again (and a run a schedule started cannot
   * chain one-offs: the moment never comes from a constant). `workflow` names the graph (default: this one), `name` the schedule. The scheduled run
   * may be the graph's first live run: the owner's request behind this run covers it. A moment that is not one, or already past, ends the step
   * `cannot_delay` with the reason, and nothing is scheduled.
   */
  engine.register<ChainRuntime>("schedule.create", {
    reentrant: true,
    run: async (c) => {
      const params = c.template((c.node as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
      const field = text(params.field) || "send_at";
      const at = text(c.inputs[field]).trim();
      const workflowId = text(params.workflow) || c.workflow.id;
      const zone = loadPushConfig(db).timezone;
      const refuse = (reason: string) => ({ output: { status: "cannot_delay", schedule_id: "", run_at: "", reason: reason.slice(0, 400) } });
      if (!at) return refuse(`the input ${field} is empty: nothing says when`);
      const runAt = parseMoment(at, Date.now(), zone);
      if (runAt === null) return refuse(`«${at}» is not a time: a delay (+2h, 30m) or a local time (2026-11-03T07:00)`);
      const projectId = c.runtime?.projectId ?? "";
      if (!projectId) return refuse("the run belongs to no project, so there is no schedule board to write to");
      const inputs = Object.fromEntries(Object.entries(c.inputs).filter(([key]) => key !== field));
      const name = (text(params.name) || `${workflowId} · ${wallClock(runAt, zone)}`).slice(0, 120);
      const saved = await c.effect("schedule.create", "schedule", () => services.schedules.save(
        { projectId, name, task: { kind: "workflow", workflowId, inputs, liveTrial: true }, when: { type: "once", runAt } }, `workflow:${c.runId}`));
      if (!saved.ok) return refuse(saved.problems.join("; "));
      return { output: { status: "scheduled", schedule_id: saved.schedule.id, run_at: wallClock(runAt, zone), reason: "" } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.agent_brief", {
    reentrant: true,
    run: async (c) => ({
      output: {
        text: agentBrief({
          scheduleName: text(c.resolve("$inputs.scheduleName")) || "agent routine", scheduledAt: Number(c.resolve("$inputs.scheduledAt")) || Date.now(), task: AGENT_TASK_FIELDS(c),
          history: text(c.resolve("$inputs.history")), memory: text(c.resolve("$inputs.memory")), lanePilot: Boolean(c.runtime?.pmThreadId), structured: true,
        }),
      },
    }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.agent_outcome", {
    reentrant: true,
    run: async (c) => {
      const projectId = c.runtime?.projectId ?? "";
      const agentId = text(c.resolve("$inputs.agentId")), scheduleId = text(c.resolve("$inputs.scheduleId")), scheduleName = text(c.resolve("$inputs.scheduleName")) || "agent routine";
      const scheduleRunId = text(c.resolve("$inputs.scheduleRunId")), runKey = text(c.resolve("$inputs.runKey")) || c.runId;
      const scheduledAt = Number(c.resolve("$inputs.scheduledAt")) || Date.now();
      const field = (name: string) => c.resolve(`work.${name}`);
      const outcome = agentOutcomeOf({ summary: field("summary"), decision: field("decision"), follow_ups: field("follow_ups"), code_change: field("code_change"), urgent: field("urgent"), status: field("status"), blocked_reason: field("blocked_reason") });

      // A code change the agent named is not left as a sentence: it goes down the road an owner's request in the PM chat takes, at most one hand-over
      // per run, and not again when the run before handed over the same text. A project without Lane Pilot: the owner's line carries the change.
      let handOver: HandOver = { state: "none", reason: "" };
      let trailer = "";
      if (outcome.codeChange) {
        try {
          const previous = scheduleId ? createScheduleStore(db).finishedRuns(scheduleId, scheduleRunId, 1)[0] : undefined;
          if (alreadyHandedOver(previous, outcome.codeChange)) handOver = { state: "repeat" };
          else {
            const pm = await services.workflowTriggers.pmOf(projectId);
            if (!pm) handOver = { state: "none", reason: "в проекте нет Lane Pilot (нет открытого PM-чата)" };
            else {
              const started = await services.phaseIntake.handOver({
                projectId, pmThreadId: pm.pmThreadId, runId: pm.runId, text: outcome.codeChange, key: `schedule:${runKey}`,
                origin: `Work found by the scheduled agent ${agentId} («${scheduleName}», schedule ${scheduleId}, run ${new Date(scheduledAt).toISOString()}); source: schedule. What it found: ${outcome.summary}`,
              });
              if (started.started) { handOver = { state: "started", via: started.via, id: started.id }; trailer = `\n\n${handOverTrailer(started.via, started.id)}`; }
              else handOver = { state: "none", reason: started.reason };
            }
          }
        } catch (cause) {
          handOver = { state: "none", reason: `передача не удалась: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200) };
          bb.log.warn(`Lane Pilot schedule «${scheduleName}»: hand-over failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      // One line on the owner's morning list; the key is the run's, so a repeated step posts nothing twice. It informs; nothing waits for the owner.
      try {
        const line = agentOwnerLine({ id: scheduleId, name: scheduleName }, agentId, outcome, handOver);
        postOwnerItem(db, { key: `schedule-agent:${runKey}`, source: "schedule", kind: outcome.status === "blocked" ? "agent_blocked" : "agent_outcome", projectId: projectId || null, wake: outcome.urgent, ...line });
      } catch (cause) { bb.log.warn(`Lane Pilot schedule «${scheduleName}»: owner line not posted: ${cause instanceof Error ? cause.message : String(cause)}`); }

      const findings = text(field("report")).trim();
      return { output: { report: `${findings ? `${findings}\n\n` : ""}${renderAgentOutcome(outcome)}${trailer}`, status: outcome.status, blocked_reason: outcome.blockedReason, urgent: outcome.urgent } };
    },
  } as NodeExecutor<ChainRuntime>);
}
