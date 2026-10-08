import { observeStageChild } from "@lane-pilot/thread-observe";
import { loadProjectSettings, recordSecretIssuance } from "../database";
import { redactKnown } from "../redact";
import type { Executor, ExecutorInput, PollResult } from "../schedule/scheduler";
import type { ScheduleKind, ScheduleTask } from "../schedule/model";
import type { ServerCore } from "./core";
import { allowedSecretNames, secretFixLines, secretProblem } from "./secrets";
import type { Services } from "./services";

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
        case "succeeded": return { state: "done", status: "succeeded", output: summary.output ? clip(JSON.stringify(summary.output, null, 2), 16_000) : "" };
        case "failed": case "blocked": case "canceled":
          return { state: "done", status: "failed", error: summary.error ?? summary.reason ?? summary.status, reason: summary.failedNode ? `failed at ${summary.failedNode}` : summary.status };
        case "waiting": return { state: "waiting", note: summary.waiting[0]?.nodeId ?? "waiting" };
        default: return { state: "running" };
      }
    },
    async cancel({ run }: ExecutorInput) { if (run.ref_id) services.workflowEngine.cancel(run.ref_id, "the scheduled run was stopped"); },
  };

  const errand: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "errand") return wrongKind(task, "errand");
      const pm = services.workflowTriggers.pmOf(schedule.project_id);
      if (!pm) throw new Error("no_pm_chat: the project has no open Lane Pilot PM chat to hold the errand's thread; enable Lane Pilot in a chat of the project");
      const resolved = await services.errands.resolveAccounts({ projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, names: task.accounts });
      if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
      const brief = [
        `This is a scheduled run of «${schedule.name}» (${new Date(run.scheduled_at).toISOString()}). Nobody is watching it live: do not wait for an answer.`,
        "If the task needs a decision, an approval or access you do not have, finish with `ERRAND: blocked: <what is needed>` instead of guessing.",
        "", task.task,
      ].join("\n");
      const started = await services.errands.startErrand({
        projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, task: brief, title: task.title ?? schedule.name, authorized: task.authorized,
        accounts: resolved.accounts, model: task.model, reasoning: task.reasoning, spawnId: `schedule:${run.run_key}`,
        // A thread that carries this origin cannot create or change schedules (schedule-tools.ts).
        metadata: { origin: "schedule", scheduleId: schedule.id, scheduleRunKey: run.run_key },
      });
      return { refKind: "thread", refId: started.threadId, ...(started.browserMachine ? { hostId: started.browserMachine } : {}) };
    },
    async poll({ schedule, run }: ExecutorInput): Promise<PollResult> {
      const observed = await observeStageChild(bb, run.ref_id!, 1);
      if (observed.kind === "product_failure") return { state: "done", status: "failed", error: redactKnown(`${observed.via}: ${observed.detail}`) };
      if (observed.kind !== "completed") return { state: "running" };
      const report = await services.errands.completedReport(run.ref_id!, schedule.project_id ?? "-");
      return report.state === "done"
        ? { state: "done", status: "succeeded", output: report.output }
        : { state: "done", status: "failed", output: report.output, error: report.reason ?? "blocked", reason: "blocked" };
    },
    async cancel({ run }: ExecutorInput) { if (run.ref_id) await bb.sdk.threads.stop({ threadId: run.ref_id }).catch(() => undefined); },
  };

  const script: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "script") return wrongKind(task, "script");
      let env: Record<string, string> = {};
      if (task.env.length) {
        const resolved = await ctx.secrets.resolve({ declared: task.env, allowed: allowedSecretNames(loadProjectSettings(db, schedule.project_id)) });
        const problem = secretProblem(resolved);
        if (resolved.denied.length) await ctx.secretApproval.request({ projectId: schedule.project_id, pmThreadId: services.workflowTriggers.pmOf(schedule.project_id)?.pmThreadId, entries: resolved.denied, use: `the scheduled script «${schedule.name}»` });
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

  return { workflow, errand, script };
}
