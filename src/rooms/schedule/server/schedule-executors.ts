import { observeStageChild } from "@lane-pilot/thread-observe";
import { loadProjectSettings, recordSecretIssuance } from "../../storage";
import { redactKnown } from "@lane-pilot/kit";
import { agentHistoryBlock, agentOwnerLine, alreadyHandedOver, finalRuleOf, handOverTrailer, parseAgentOutcome, workflowFinish, type HandOver } from "../outcome";
import { createScheduleStore } from "../store";
import { agentBrief } from "./schedule-agent-brief";
import { taskMemoryContext } from "../../memory/server";
import { postOwnerItem } from "../../owner-waiting";
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
      const pm = await services.workflowTriggers.pmOf(schedule.project_id);
      if (!pm) throw new Error("no_pm_chat: the project has no open Lane Pilot PM chat to hold the errand's thread; enable Lane Pilot in a chat of the project");
      const resolved = await services.errands.resolveAccounts({ projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, names: task.accounts });
      if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
      const brief = [
        `This is a scheduled run of «${schedule.name}» (${new Date(run.scheduled_at).toISOString()}). Nobody is watching it live: do not wait for an answer.`,
        "If the task needs a decision, an approval or access you do not have, finish with `ERRAND: blocked: <what is needed>` instead of guessing.",
        "", task.task,
      ].join("\n");
      // The same resolution the board shows on the card (src/schedule/errand-model.ts): the task, its preset, the Automation default, the errand role.
      const model = await errandModelForRun(ctx, schedule.project_id, pm.pmThreadId, task);
      const started = await services.errands.startErrand({
        projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, task: brief, title: task.title ?? schedule.name, authorized: task.authorized,
        accounts: resolved.accounts, providerId: model.providerId, model: model.model, reasoning: model.reasoningEffort, serviceTier: model.serviceTier ?? undefined, spawnId: `schedule:${run.run_key}`,
        // Nobody is watching: the thread has no parent chat, so its end wakes no one; the board keeps the report.
        detached: true,
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
   * A named agent run as itself (src/rooms/critique/server/scheduled-agent.ts). Its first message carries the standing task, the last runs'
   * outcomes of this schedule and the project's notes; it must end with an OUTCOME block, which is read back for the next run and for the
   * owner's morning list. The agent edits no code: a change it finds necessary is named in its outcome and in the list.
   */
  const agent: Executor = {
    async start({ schedule, task, run }: ExecutorInput) {
      if (task.kind !== "agent") return wrongKind(task, "agent");
      const pm = await services.workflowTriggers.pmOf(schedule.project_id);
      if (!pm) throw new Error("no_pm_chat: the project has no open Lane Pilot PM chat to hold the agent's thread; enable Lane Pilot in a chat of the project");
      if (task.accounts.length) {
        const resolved = await services.errands.resolveAccounts({ projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, names: task.accounts });
        if (!resolved.ok) throw new Error(`${resolved.blocked.reason}: ${resolved.blocked.fix.join(" ")}`);
      }
      const history = task.historyRuns > 0 ? agentHistoryBlock(createScheduleStore(db).finishedRuns(schedule.id, run.id, task.historyRuns)) : "";
      const brief = agentBrief({ scheduleName: schedule.name, scheduledAt: run.scheduled_at, task, history, memory: taskMemoryContext(db, schedule.project_id, pm.runId, task.task) });
      const started = await services.agentRuns.start({
        projectId: schedule.project_id, runId: pm.runId, pmThreadId: pm.pmThreadId, agentId: task.agentId, brief, title: task.title ?? schedule.name, spawnId: `schedule:${run.run_key}`,
        model: task.model, reasoning: task.reasoning, serviceTier: task.serviceTier,
        // A thread that carries this origin cannot create or change schedules (schedule-tools.ts).
        metadata: { origin: "schedule", scheduleId: schedule.id, scheduleRunKey: run.run_key },
      });
      return { refKind: "thread", refId: started.threadId };
    },
    async poll({ schedule, task, run }: ExecutorInput): Promise<PollResult> {
      if (task.kind !== "agent") return wrongKind(task, "agent");
      const observed = await observeStageChild(bb, run.ref_id!, 1);
      if (observed.kind === "product_failure") return { state: "done", status: "failed", error: redactKnown(`${observed.via}: ${observed.detail}`) };
      if (observed.kind !== "completed") return { state: "running" };
      const report = await services.agentRuns.completedReport(run.ref_id!, schedule.project_id ?? "-");
      if (report.state === "blocked") return { state: "done", status: "failed", output: report.output, error: report.files?.length ? `the agent changed repository files: ${report.files.join(", ")}` : report.reason ?? "blocked", reason: report.reason ?? "blocked" };
      const outcome = parseAgentOutcome(report.output);
      if (!outcome) return { state: "done", status: "failed", output: report.output, reason: "no_outcome", error: "the agent ended without an OUTCOME block (summary, decision, follow-ups, code-change, urgent, status), so the next run would not know what this one did" };
      // A code change the agent named is not left as a sentence: it goes down the road an owner's request in the PM chat takes (phase, issue-quick,
      // issue-batch), at most one hand-over per run, and not again when the run before handed over the same text. No PM chat: the morning line only.
      let handOver: HandOver = { state: "none", reason: "" };
      let output = report.output;
      if (outcome.codeChange) {
        try {
          if (alreadyHandedOver(createScheduleStore(db).finishedRuns(schedule.id, run.id, 1)[0], outcome.codeChange)) handOver = { state: "repeat" };
          else {
            const pm = await services.workflowTriggers.pmOf(schedule.project_id);
            if (!pm) handOver = { state: "none", reason: "в проекте нет Lane Pilot (нет открытого PM-чата)" };
            else {
              const started = await services.phaseIntake.handOver({
                projectId: schedule.project_id, pmThreadId: pm.pmThreadId, runId: pm.runId, text: outcome.codeChange, key: `schedule:${run.run_key}`,
                origin: `Work found by the scheduled agent ${task.agentId} («${schedule.name}», schedule ${schedule.id}, run ${new Date(run.scheduled_at).toISOString()}); source: schedule. What it found: ${outcome.summary}`,
              });
              if (started.started) { handOver = { state: "started", via: started.via, id: started.id }; output = `${report.output.trimEnd()}\n\n${handOverTrailer(started.via, started.id)}`; }
              else handOver = { state: "none", reason: started.reason };
            }
          }
        } catch (cause) {
          handOver = { state: "none", reason: `передача не удалась: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200) };
          bb.log.warn(`Lane Pilot schedule «${schedule.name}»: hand-over failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      // One line on the owner's morning list; the key is the run's, so a poll repeated after a crash posts nothing twice. It informs; nothing waits for the owner.
      try {
        const line = agentOwnerLine(schedule, task.agentId, outcome, handOver);
        postOwnerItem(db, { key: `schedule-agent:${run.run_key}`, source: "schedule", kind: outcome.status === "blocked" ? "agent_blocked" : "agent_outcome", projectId: schedule.project_id, wake: outcome.urgent, ...line });
      } catch (cause) { bb.log.warn(`Lane Pilot schedule «${schedule.name}»: owner line not posted: ${cause instanceof Error ? cause.message : String(cause)}`); }
      return outcome.status === "blocked"
        ? { state: "done", status: "failed", output, error: outcome.blockedReason, reason: "blocked" }
        : { state: "done", status: "succeeded", output };
    },
    async cancel({ run }: ExecutorInput) { if (run.ref_id) await bb.sdk.threads.stop({ threadId: run.ref_id }).catch(() => undefined); },
  };

  return { workflow, errand, script, agent };
}
