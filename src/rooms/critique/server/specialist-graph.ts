import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runOnHost } from "@lane-pilot/host-calls";
import { builtinWorkflow } from "../../workflow";
import { fenceOutside, spawnTextId } from "../../core/server";
import type { ServerCore, Services } from "../../core/server";

/**
 * A specialist's work is a run of the built-in graph `specialist` (workflows/specialist.json): the PM's `lane_pilot_specialist` starts it and
 * `lane_pilot_wait_specialist` reads it. The agent step is the engine's, so the thread, its usage, its limits and the repo-edit check
 * are the same as for every other graph step. Two KV keys connect the PM's `threadId` to the run, because the engine journals a step's thread
 * only when the step ends.
 */
export const SPECIALIST_GRAPH = "specialist";
const runOfThread = (threadId: string) => `specialist-run:${threadId}`;
const threadOfRun = (runId: string) => `specialist-thread:${runId}`;
/** The run after which the step cannot go on; a PM that asks again about the same task starts a new one. */
const ENDED_BADLY = ["failed", "blocked", "interrupted", "canceled"];
/** How long `start` waits for the helper thread to exist before it answers. */
const THREAD_WAIT_MS = 30_000;
const POLL_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Called when the agent step of a `specialist` run spawns its thread. */
export async function rememberSpecialistThread(bb: BbPluginApi, runId: string, threadId: string): Promise<void> {
  await Promise.all([bb.storage.kv.set(threadOfRun(runId), threadId as never), bb.storage.kv.set(runOfThread(threadId), runId as never)]).catch(() => undefined);
}

/** The `specialist` run a thread belongs to, or null for a thread that no run started (one that was running when this version came in). */
export async function specialistRunOfThread(bb: BbPluginApi, threadId: string): Promise<string | null> {
  const runId = await bb.storage.kv.get<string>(runOfThread(threadId)).catch(() => null);
  return typeof runId === "string" && runId ? runId : null;
}

export async function startSpecialistRun(ctx: ServerCore, services: Services, input: { projectId: string; pmThreadId: string; runId: string; role: string; task: string; title: string }): Promise<{ workflowRunId: string; threadId: string }> {
  const workflow = builtinWorkflow(SPECIALIST_GRAPH);
  if (!workflow) throw new Error(`built-in workflow ${SPECIALIST_GRAPH} is not loaded`);
  const engine = services.workflowEngine;
  const key = `specialist:${input.runId}:${input.role}:${spawnTextId(input.task)}`;
  const begin = (idem: string) => engine.start({
    workflow, inputs: { role: input.role, task: input.task, title: input.title }, key: idem,
    runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId },
    link: { projectId: input.projectId, runId: input.runId },
  });
  let started = begin(key);
  // The same task for the same specialist is the same run (a retry after a lost answer starts nothing twice); one that ended badly is asked for again.
  if (!started.created && ENDED_BADLY.includes(engine.get(started.runId)?.status ?? "")) started = begin(`${key}:${Date.now()}`);
  started.done.catch((cause: unknown) => ctx.log(`Lane Pilot specialist run ${started.runId} stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
  const deadline = Date.now() + THREAD_WAIT_MS;
  for (;;) {
    const threadId = await ctx.bb.storage.kv.get<string>(threadOfRun(started.runId)).catch(() => null);
    if (typeof threadId === "string" && threadId) return { workflowRunId: started.runId, threadId };
    const summary = engine.get(started.runId);
    if (summary && ENDED_BADLY.includes(summary.status)) throw new Error(summary.error ?? summary.reason ?? `the specialist run ${summary.status}`);
    if (Date.now() >= deadline || ctx.isDisposed()) throw new Error(`specialist_thread_missing: run ${started.runId} has not started its thread yet; read it with lane_pilot_workflow_status`);
    await sleep(250);
  }
}

/** The answer of `lane_pilot_wait_specialist` for a run: done with the report, failed, blocked on a repo edit, or still running. */
export async function waitSpecialistRun(ctx: ServerCore, services: Services, input: { projectId: string; runId: string; timeoutSec: number }): Promise<Record<string, unknown>> {
  const owner = ctx.db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=? AND workflow_id=?").get(input.runId, SPECIALIST_GRAPH) as { project_id: string | null } | undefined;
  if (!owner || owner.project_id !== input.projectId) throw new Error(`not_found: no specialist run "${input.runId}" in this project`);
  const deadline = Date.now() + input.timeoutSec * 1000;
  for (;;) {
    const summary = services.workflowEngine.get(input.runId);
    const threadId = await ctx.bb.storage.kv.get<string>(threadOfRun(input.runId)).catch(() => null) ?? "";
    const base = { threadId, workflowRunId: input.runId };
    if (summary?.status === "succeeded") {
      // Artifact guard (agents-design 3.5): a deliverable that fails its validator goes back to the same thread
      // as a revision remark instead of being accepted. The validator/deliverable fields arrive with the employee
      // manifest (grok/employees); a run that names none is accepted as before.
      let inputs: Record<string, unknown> = {};
      try { inputs = JSON.parse((ctx.db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE id=?").get(input.runId) as { inputs_json?: string } | undefined)?.inputs_json ?? "{}") as Record<string, unknown>; } catch { inputs = {}; }
      const validator = typeof inputs.validator === "string" ? inputs.validator : null;
      const deliverable = typeof inputs.deliverable === "string" ? inputs.deliverable : null;
      if (validator && deliverable && threadId) {
        try {
          const { validateDeliverable } = await import("../../validators");
          const hostId = typeof inputs.hostId === "string" ? inputs.hostId : "";
          const verdict = await validateDeliverable(validator, deliverable, { host: { run: (id, cwd, command, timeoutSec) => runOnHost(ctx.host, { hostId: id, cwd, command, timeoutSec }) as never }, hostId, brief: inputs.brief as Record<string, unknown> | undefined });
          if (!verdict.ok) {
            const remark = `Revision needed: ${validator} validator rejected ${deliverable} — ${verdict.reason}`;
            await ctx.bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: remark, mentions: [] }] } as never).catch(() => undefined);
            return { ...base, state: "revision", reason: verdict.reason, output: fenceOutside("specialist", remark) };
          }
        } catch (cause) {
          ctx.log(`Lane Pilot deliverable validation failed for ${input.runId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      return { ...base, state: "done", output: fenceOutside("specialist", String(summary.output?.report ?? "")) };
    }
    if (summary && ENDED_BADLY.includes(summary.status)) {
      const error = summary.error ?? summary.reason ?? summary.status;
      const edited = /^repo_edited: .*may not touch: (.+)$/.exec(error);
      if (edited) return { ...base, state: "blocked", reason: "repo_edited", files: edited[1]!.split(/,\s*/), output: fenceOutside("specialist", `Helper edited repository files: ${edited[1]}`) };
      return { ...base, state: "failed", output: fenceOutside("specialist", error) };
    }
    if (!summary || Date.now() >= deadline || ctx.isDisposed()) return { ...base, state: "running", output: fenceOutside("specialist", summary ? `the run is ${summary.status}` : "the run is not known to the engine") };
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}
