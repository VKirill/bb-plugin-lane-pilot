import { clip } from "@lane-pilot/contracts";
import type { ErrandsApi } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { taskMemoryContext } from "../../../memory/server";
import type { WorkflowEngineApi, WorkflowTriggersApi } from "../../../platform/server";
import { allowedSecretNames, secretFixLines, secretProblem } from "../../../secrets/server";
import { loadProjectSettings } from "../../../storage";
import { wfRunDefinitionJson } from "@lane-pilot/workflow-engine";
import { agentHistoryBlock, finalRuleOf, workflowFinish } from "../../models/outcome";
import { SCHEDULE_SCRIPT_WORKFLOW, type ScheduleKind, type ScheduleTask } from "../../models/schedule";
import { createScheduleStore } from "../repositories/schedule-repository";
import { errandModelForRun } from "./schedule-default";
import type { Executor, ExecutorInput, PollResult } from "./scheduler";
import { isSystemScheduleCreator, systemStarterOf } from "./system-schedules";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  errands: ErrandsApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

export { SCHEDULE_SCRIPT_WORKFLOW };

const textVal = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The four kinds of scheduled work, each behind the scheduler's `start / poll / cancel`. `start` is idempotent on the run key, so
 * a start repeated after a crash finds the work it began: a workflow run is keyed by it, the errand's thread by its spawn id, the
 * script's host job by the job key (src/jobs.ts).
 */
const wrongKind = (task: ScheduleTask, kind: ScheduleKind): never => { throw new Error(`a ${task.kind} task reached the ${kind} executor`); };

export function createScheduleExecutors(ctx: ServerCore, services: Services): Record<ScheduleKind, Executor> {
  const { db } = ctx;

  const workflow: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "workflow") return wrongKind(task, "workflow");
      // Source «manual»: the checks of a start by hand (published, inputs whole, requirements, a PM chat), without asking for a schedule trigger in the workflow's file.
      // A Lane Pilot system schedule (system-schedules.ts) starts its own starter graph, detached: no PM chat, no run link, no chat told.
      const starter = systemStarterOf(schedule.created_by);
      const detached = isSystemScheduleCreator(schedule.created_by);
      const result = await services.workflowTriggers.start({ projectId: schedule.project_id, workflowId: task.workflowId, inputs: task.inputs, source: "manual", key: run.run_key, liveTrial: task.liveTrial, origin: "schedule",
        ...(starter ? { starter } : {}),
        ...(detached ? { detached: true } : {}) });
      if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
      return { refKind: "workflow_run", refId: result.runId };
    },
    async poll({ run }: ExecutorInput): Promise<PollResult> {
      const summary = services.workflowEngine.get(run.ref_id!);
      if (!summary) return { state: "done", status: "failed", error: `workflow run ${run.ref_id} is gone` };
      switch (summary.status) {
        case "succeeded": {
          // The run succeeded, but its last node may be «aborted» or «send_failed»: that is a failed scheduled run (audit r4 item 16).
          const rule = (() => { try { return finalRuleOf(wfRunDefinitionJson(db, run.ref_id!)); } catch { return null; } })();
          const finish = workflowFinish(summary.output, rule);
          const output = summary.output ? clip(JSON.stringify(summary.output, null, 2), 16_000) : "";
          // A correct escalation or unfinished work is not a schedule failure (that would pause the schedule) and not completed work.
          if (finish.kind === "escalated" || finish.kind === "incomplete") return { state: "done", status: "succeeded", output, reason: `ended_${finish.kind}` };
          return finish.ok ? { state: "done", status: "succeeded", output } : { state: "done", status: "failed", output, error: finish.detail, reason: `ended_${finish.status}` };
        }
        case "failed": case "blocked": case "canceled": case "interrupted": case "not_verified":
          return { state: "done", status: "failed", error: summary.error ?? summary.reason ?? summary.status, reason: summary.failedNode ? `failed at ${summary.failedNode}` : summary.status };
        case "waiting": return { state: "waiting", note: summary.waiting[0]?.nodeId ?? "waiting" };
        default: return { state: "running" };
      }
    },
    async cancel({ run }: ExecutorInput) { if (run.ref_id) services.workflowEngine.cancel(run.ref_id, "the scheduled run was stopped"); },
  };

  /**
   * A scheduled errand is a run of the graph `errand` (workflows/errand.json), keyed by the schedule's run key: a start repeated after a crash finds the
   * run it began. The account check comes before the run, so a missing account fails the schedule's run and starts nothing. With a PM chat the helper
   * works in its checkout, without one in the project's own folder; either way its thread is hidden and has no parent chat, so its end wakes no one.
   */
  const errand: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "errand") return wrongKind(task, "errand");
      const pm = await services.workflowTriggers.pmOf(schedule.project_id);
      const resolved = await services.errands.resolveAccounts({ projectId: schedule.project_id, runId: pm?.runId ?? null, pmThreadId: pm?.pmThreadId ?? null, names: task.accounts, record: false });
      if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
      const brief = [
        `This is a scheduled run of «${schedule.name}» (${new Date(run.scheduled_at).toISOString()}). Nobody is watching it live: do not wait for an answer.`,
        "If the task needs a decision, an approval or access you do not have, finish with `ERRAND: blocked: <what is needed>` instead of guessing.",
        "", task.task,
      ].join("\n");
      // The same resolution the board shows on the card (models/errand-model.ts): the task, its preset, the Automation default, the errand role.
      const model = await errandModelForRun(ctx, schedule.project_id, pm?.pmThreadId ?? null, { ...task, kind: task.errandKind });
      const started = services.errands.startRun({
        projectId: schedule.project_id, pmThreadId: pm?.pmThreadId ?? null, runId: pm?.runId ?? null, key: run.run_key,
        task: brief, title: task.title ?? schedule.name, authorized: task.authorized, accounts: task.accounts,
        providerId: model.providerId, model: model.model, reasoning: model.reasoningEffort, serviceTier: model.serviceTier ?? undefined,
        ...(task.errandKind ? { kind: task.errandKind, kindBy: "schedule" } : {}),
        // Nobody is watching: no parent chat. A thread that carries the schedule origin cannot create or change schedules (schedule-tools.ts).
        detached: true, schedule: { id: schedule.id, runKey: run.run_key },
      });
      return { refKind: "workflow_run", refId: started.runId };
    },
    // The run's result is the errand's: a helper that ended `blocked` (or edited the repository) is a failed scheduled run with its reason.
    async poll(input: ExecutorInput): Promise<PollResult> {
      const summary = services.workflowEngine.get(input.run.ref_id!);
      if (summary?.status !== "succeeded") return workflow.poll(input);
      const out = (summary.output ?? {}) as { state?: unknown; reason?: unknown; output?: unknown };
      const output = typeof out.output === "string" ? out.output : "";
      return out.state === "done"
        ? { state: "done", status: "succeeded", output }
        : { state: "done", status: "failed", output, error: typeof out.reason === "string" && out.reason ? out.reason : "blocked", reason: "blocked" };
    },
    cancel: (input: ExecutorInput) => workflow.cancel(input),
  };

  const script: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "script") return wrongKind(task, "script");
      if (task.env.length) {
        const gate = await ctx.secrets.check({ declared: task.env, allowed: allowedSecretNames(loadProjectSettings(db, schedule.project_id)), kinds: ["secret", "login"] }, { fresh: true });
        const problem = secretProblem(gate);
        if (problem.length || gate.unavailable) throw new Error(`secrets_not_ready: ${secretFixLines(gate).join(" ")}`);
      }
      const result = await services.workflowTriggers.start({
        projectId: schedule.project_id, workflowId: SCHEDULE_SCRIPT_WORKFLOW, source: "manual", key: run.run_key, origin: "schedule",
        starter: "schedule-script", detached: true,
        inputs: {
          scheduleId: schedule.id, hostId: task.hostId, command: task.command, cwd: task.cwd, env: [...task.env],
          timeoutSec: schedule.timeout_sec, maxOutputBytes: task.maxOutputBytes ?? 0, runKey: run.run_key,
        },
      });
      if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
      return { refKind: "workflow_run", refId: result.runId, hostId: task.hostId };
    },
    async poll(input: ExecutorInput): Promise<PollResult> {
      if (input.task.kind !== "script") return wrongKind(input.task, "script");
      const summary = services.workflowEngine.get(input.run.ref_id!);
      if (summary?.status !== "succeeded") return workflow.poll(input);
      const out = (summary.output ?? {}) as { status?: unknown; exitCode?: unknown; output?: unknown; error?: unknown; reason?: unknown; truncated?: unknown };
      const output = textVal(out.output);
      const truncated = out.truncated === true;
      const exitCode = typeof out.exitCode === "number" ? out.exitCode : null;
      return out.status === "succeeded"
        ? { state: "done", status: "succeeded", exitCode: exitCode ?? 0, output, truncated }
        : { state: "done", status: "failed", exitCode, output, truncated, error: textVal(out.error) || "script failed", reason: textVal(out.reason) || "exit_code" };
    },
    cancel: (input: ExecutorInput) => workflow.cancel(input),
  };

  /**
   * A named agent run as itself: an alias of the workflow kind. The executor builds what only the schedule knows (the last runs' outcomes, the
   * project's notes) and starts the built-in graph `agent-routine` as an ordinary workflow run, so the journal, the limits, the schema check on the
   * agent's answer and the repairs apply to it as to any chain (workflows/agent-routine.json; its code steps are schedule-agent-actions.ts). The agent
   * edits no code: a change it finds necessary is named in its outcome, handed to Lane Pilot when the project has it, and told to the owner.
   * Works in a project that has no PM chat.
   */
  const agent: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "agent") return wrongKind(task, "agent");
      const pm = await services.workflowTriggers.pmOf(schedule.project_id);
      if (task.accounts.length) {
        const resolved = await services.errands.resolveAccounts({ projectId: schedule.project_id, runId: pm?.runId ?? null, pmThreadId: pm?.pmThreadId ?? null, names: task.accounts });
        if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
      }
      const history = task.historyRuns > 0 ? agentHistoryBlock(createScheduleStore(db).finishedRuns(schedule.id, run.id, task.historyRuns)) : "";
      const result = await services.workflowTriggers.start({
        projectId: schedule.project_id, workflowId: "agent-routine", source: "manual", key: run.run_key, origin: "schedule",
        inputs: {
          agentId: task.agentId, task: task.task, history, memory: taskMemoryContext(db, schedule.project_id, pm?.runId ?? null, task.task), authorized: task.authorized,
          accounts: task.accounts, historyRuns: task.historyRuns, scheduleName: schedule.name, scheduleId: schedule.id, scheduleRunId: run.id, runKey: run.run_key, scheduledAt: run.scheduled_at,
          model: task.model ?? "", reasoning: task.reasoning ?? "", serviceTier: task.serviceTier ?? "default",
        },
      });
      if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
      return { refKind: "workflow_run", refId: result.runId };
    },
    async poll(input: ExecutorInput): Promise<PollResult> {
      // The routine's last step stores the outcome as text (the next run reads it back); an agent that ended `blocked` is a failed run with its reason.
      const summary = services.workflowEngine.get(input.run.ref_id!);
      if (summary?.status !== "succeeded") return workflow.poll(input);
      const out = (summary.output ?? {}) as { report?: unknown; status?: unknown; blocked_reason?: unknown };
      const output = typeof out.report === "string" ? out.report : "";
      return out.status === "blocked"
        ? { state: "done", status: "failed", output, error: typeof out.blocked_reason === "string" && out.blocked_reason ? out.blocked_reason : "blocked", reason: "blocked" }
        : { state: "done", status: "succeeded", output };
    },
    cancel: (input: ExecutorInput) => workflow.cancel(input),
  };

  return { workflow, errand, script, agent };
}
