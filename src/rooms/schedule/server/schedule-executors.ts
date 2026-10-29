import { loadProjectSettings, recordSecretIssuance } from "../../storage";
import { redactKnown } from "@lane-pilot/kit";
import { agentHistoryBlock, finalRuleOf, workflowFinish } from "../outcome";
import { createScheduleStore } from "../store";
import { taskMemoryContext } from "../../memory/server";
import type { Executor, ExecutorInput, PollResult } from "../scheduler";
import type { ScheduleKind, ScheduleTask } from "../model";
import type { ServerCore } from "../../core/server";
import { errandModelForRun } from "./schedule-default";
import { allowedSecretNames, secretFixLines, secretProblem } from "../../secrets/server";
import type { Services } from "../../core/server";

/**
 * The three kinds of scheduled work, each behind the scheduler's `start / poll / cancel`. `start` is idempotent on the run key, so
 * a start repeated after a crash finds the work it began: a workflow run is keyed by it, the errand's thread by its spawn id, the
 * script's host job by the job key (src/jobs.ts).
 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const wrongKind = (task: ScheduleTask, kind: ScheduleKind): never => { throw new Error(`a ${task.kind} task reached the ${kind} executor`); };

export function createScheduleExecutors(ctx: ServerCore, services: Services): Record<ScheduleKind, Executor> {
  const { bb, db } = ctx;

  const workflow: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "workflow") return wrongKind(task, "workflow");
      // Source «manual»: the checks of a start by hand (published, inputs whole, requirements, a PM chat), without asking for a schedule trigger in the workflow's file.
      const result = await services.workflowTriggers.start({ projectId: schedule.project_id, workflowId: task.workflowId, inputs: task.inputs, source: "manual", key: run.run_key, origin: "schedule" });
      if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
      return { refKind: "workflow_run", refId: result.runId };
    },
    async poll({ run }: ExecutorInput): Promise<PollResult> {
      const summary = services.workflowEngine.get(run.ref_id!);
      if (!summary) return { state: "done", status: "failed", error: `workflow run ${run.ref_id} is gone` };
      switch (summary.status) {
        case "succeeded": {
          // The run succeeded, but its last node may be «aborted» or «send_failed»: that is a failed scheduled run (audit r4 item 16).
          const rule = (() => { try { return finalRuleOf((db.prepare("SELECT definition_json FROM lane_pilot_wf_run WHERE id=?").get(run.ref_id!) as { definition_json?: string } | undefined)?.definition_json); } catch { return null; } })();
          const finish = workflowFinish(summary.output, rule);
          const output = summary.output ? clip(JSON.stringify(summary.output, null, 2), 16_000) : "";
          return finish.ok ? { state: "done", status: "succeeded", output } : { state: "done", status: "failed", output, error: finish.detail, reason: `ended_${finish.status}` };
        }
        case "failed": case "blocked": case "canceled": case "interrupted":
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
      // The same resolution the board shows on the card (src/schedule/errand-model.ts): the task, its preset, the Automation default, the errand role.
      const model = await errandModelForRun(ctx, schedule.project_id, pm?.pmThreadId ?? null, task);
      const started = services.errands.startRun({
        projectId: schedule.project_id, pmThreadId: pm?.pmThreadId ?? null, runId: pm?.runId ?? null, key: run.run_key,
        task: brief, title: task.title ?? schedule.name, authorized: task.authorized, accounts: task.accounts,
        providerId: model.providerId, model: model.model, reasoning: model.reasoningEffort, serviceTier: model.serviceTier ?? undefined,
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
      let env: Record<string, string> = {};
      if (task.env.length) {
        const resolved = await ctx.secrets.resolve({ declared: task.env, allowed: allowedSecretNames(loadProjectSettings(db, schedule.project_id)) });
        const problem = secretProblem(resolved);
        if (problem.length || resolved.unavailable) throw new Error(`secrets_not_ready: ${secretFixLines(resolved).join(" ")}`);
        env = Object.assign({}, ...task.env.map((name) => resolved.byName[name] ?? {})) as Record<string, string>;
        for (const name of task.env) {
          try { recordSecretIssuance(db, { projectId: schedule.project_id, consumer: "schedule", secretName: name, hostId: task.hostId, checkCommand: `schedule ${schedule.id}` }); } catch (cause) { bb.log.warn(`secret issuance journal: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      }
      const reply = await ctx.host.call("jobStart", {
        requestedHostId: task.hostId, kind: "runScript",
        input: { requestedHostId: task.hostId, command: task.command, cwd: task.cwd, timeoutSec: schedule.timeout_sec, ...(Object.keys(env).length ? { env } : {}), ...(task.maxOutputBytes ? { maxOutputBytes: task.maxOutputBytes } : {}) },
        timeoutSec: Math.min(10_800, schedule.timeout_sec + 30), key: run.run_key,
      }, { hostId: task.hostId, timeoutMs: 30_000 });
      return { refKind: "host_job", refId: reply.jobId, hostId: task.hostId };
    },
    async poll({ task, run }: ExecutorInput): Promise<PollResult> {
      if (task.kind !== "script") return wrongKind(task, "script");
      const status = await ctx.host.call("jobStatus", { requestedHostId: task.hostId, jobId: run.ref_id! }, { hostId: task.hostId, timeoutMs: 20_000 });
      if (status.state === "running") return { state: "running" };
      if (status.state !== "succeeded") return { state: "done", status: "failed", error: redactKnown(status.error ?? `the host job is ${status.state}`), reason: `job_${status.state}` };
      const result = status.result as { exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };
      const output = redactKnown([result.stdout, result.stderr ? `--- stderr ---\n${result.stderr}` : ""].filter(Boolean).join("\n"));
      return result.exitCode === 0
        ? { state: "done", status: "succeeded", exitCode: 0, output, truncated: result.truncated }
        : { state: "done", status: "failed", exitCode: result.exitCode, output, truncated: result.truncated, error: result.timedOut ? "the script's own time limit" : `exit code ${result.exitCode}`, reason: result.timedOut ? "timeout" : "exit_code" };
    },
    async cancel({ task, run }: ExecutorInput) {
      if (task.kind === "script" && run.ref_id) await ctx.host.call("jobCancel", { requestedHostId: task.hostId, jobId: run.ref_id }, { hostId: task.hostId, timeoutMs: 20_000 }).catch(() => undefined);
    },
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
