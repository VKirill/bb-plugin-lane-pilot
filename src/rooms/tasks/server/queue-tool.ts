import { z } from "zod";
import { callerPluginMetadata, registerObservedTool } from "../../platform/server";
import { ToolError, type ServerCore } from "../../contracts/server";
import { deadLetters, HOLD_FOREVER } from "../rails";
import { recordTaskWord, waitingAttemptId } from "../words";
import type { TaskWordPort } from "../../contracts";
import { wayOut } from "../../contracts"
import { taskFamily } from "@lane-pilot/contracts";
import { hostContract, resolvePlanningHome } from "../../contracts";
import { failedTasksAllProjects, getRun, getRunWriterHost, latestAttemptsForProject, latestTaskAttemptState, planningHomeInputs, setTaskHeldUntil } from "../../storage";

/**
 * The PM's queue controls (SMA map: Durable queue row): hold a task out of the queue until a date or until released (Held until year 2999),
 * release it, and list the dead letters — tasks that ended blocked or rejected and nobody sent again within a day (Dead-letter queue).
 */
/**
 * Which PM thread a backlog item was handed to. The backlog room owns that table and imports tasks, never the other
 * way, so it hands its reader in here when it starts; before that no item counts as issued.
 */
export type BacklogIssuedRead = (projectId: string, todoId: string) => string | undefined;
const backlogIssued = new WeakMap<object, BacklogIssuedRead>();
export function bindBacklogIssued(db: object, read: BacklogIssuedRead): void { backlogIssued.set(db, read); }

export function registerQueueTool(ctx: ServerCore, taskWords: TaskWordPort): void {
  const { db, bb } = ctx;
  const runOf = async (context: { threadId: string | null; experimental_vkPluginMetadata?: unknown }) => {
    const metadata = await callerPluginMetadata(bb, context);
    const runId = typeof metadata?.lanePilotRunId === "string" ? metadata.lanePilotRunId : null;
    if (metadata?.role !== "pm" || !runId) throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
    return runId;
  };
  registerObservedTool(bb.agents, {
    name: "lane_pilot_queue",
    description: "The run's queue: hold tasks out of it until a date or until released, release them, list the dead letters (tasks that ended blocked and were not sent again). Replanning queued tasks = hold them, not cancel and resend.",
    instructions: "`hold` (taskIds, until? ISO date; without it the task waits until `release`): a queued task takes no writer while held and keeps its task and attempt, so a replan holds the wave, fixes the contracts (lane_pilot_update_task) and releases it; cancel and resend redoes pm-read and plan critique. `release` (taskIds). `close_backlog` (id, taskId): mark that backlog item done; taskId must be an accepted task issued to this thread. `word` (taskId, decision yes|no, text): the owner's word on a task, written only after he answered (lane_pilot_ask_owner) — a verified task lands on main only after his yes when owner.words asks for it (default: money, database migration, production deploy). `dead_letters`: the tasks of this project whose latest attempt ended blocked or rejected more than a day ago and that nobody sent again — fix and send each again, or cancel it with the words why.",
    parameters: z.discriminatedUnion("action", [
      z.object({ action: z.literal("hold"), taskIds: z.array(z.string().min(1)).min(1).max(50), until: z.string().datetime().optional() }).strict(),
      z.object({ action: z.literal("release"), taskIds: z.array(z.string().min(1)).min(1).max(50) }).strict(),
      z.object({ action: z.literal("dead_letters") }).strict(),
      z.object({ action: z.literal("failures"), sinceDays: z.number().min(0).max(3650).optional() }).strict(),
      z.object({ action: z.literal("word"), taskId: z.string().min(1), decision: z.enum(["yes", "no"]), text: z.string().trim().min(1).max(600) }).strict(),
      z.object({ action: z.literal("close_backlog"), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), taskId: z.string().min(1), note: z.string().max(300).optional() }).strict(),
    ]),
    execute: async (input, context) => {
      if (input.action === "failures") {
        // The single failure journal (SMA dt_bugs): one line per failed task of every project, with its triage origin.
        const since = input.sinceDays !== undefined ? Date.now() - input.sinceDays * 86_400_000 : 0;
        return JSON.stringify({ failures: failedTasksAllProjects(db, since) });
      }
      if (input.action === "dead_letters") {
        const rows = latestAttemptsForProject(db, context.projectId);
        return JSON.stringify({ deadLetters: deadLetters(rows, Date.now()).slice(0, 50).map((row) => ({ ...row, next: wayOut(row.state, row.reason, row.failureCode) ?? undefined })) });
      }
      const runId = await runOf(context);
      if (input.action === "word") {
        const family = taskFamily(input.taskId);
        // The first press claims the decision (SMA tr_approving); a second presser is refused.
        const wordFor = waitingAttemptId(db, runId, family) ?? null;
        const claim = taskWords.decide(db, runId, family, input.decision, "pm", Date.now(), wordFor);
        if (!claim.ok) return JSON.stringify({ runId, taskId: input.taskId, ok: false, reason: claim.reason });
        await recordTaskWord(bb.storage.kv as never, runId, family, input.decision, input.text, Date.now(), wordFor);
        taskWords.answer(db, runId, family, input.decision, input.text, "pm");
        // The attempt that waits for the word (finish.ts, up to six hours) picks it up within a minute: telling the PM to resend it made two
        // attempts of one task (Gemini F-008.3).
        const waiting = latestTaskAttemptState(db, context.projectId, input.taskId) === "running";
        return JSON.stringify({ runId, taskId: input.taskId, word: input.decision, next: input.decision === "yes" ? (waiting ? "nothing: the waiting attempt lands by itself within a minute, do not resend the task" : "send the task again: it lands without a new writer pass") : "cancel the task with the owner's words, or change it and send again" });
      }
      if (input.action === "close_backlog") {
        // Close exactly that line: only an accepted piece of this run closes the backlog line it was issued for (SMA m_in_close_line).
        if (latestTaskAttemptState(db, context.projectId, input.taskId) !== "accepted") {
          throw new ToolError(`task ${input.taskId} is not accepted in this run: only an accepted piece of work closes its backlog line`, { code: "not_accepted", retryable: false, sideEffects: "none" });
        }
        const issuedTo = backlogIssued.get(db)?.(context.projectId, input.id);
        if (issuedTo && issuedTo !== context.threadId) {
          throw new ToolError(`backlog item ${input.id} was issued to another PM thread (${issuedTo}); only the thread it went to closes it`, { code: "not_issued", retryable: false, sideEffects: "none" });
        }
        const run = getRun(db, runId);
        const hostId = getRunWriterHost(db, runId);
        if (!run?.writer_workspace_path || !hostId) throw new ToolError("this run has no checkout to close the backlog item in", { code: "no_checkout", retryable: false, sideEffects: "none" });
        const host = bb.hosts.experimental_client({ contract: hostContract });
        // The todo items live in the planning home when the project set one (SMA d_project_planning), else in the checkout.
        const root = await resolvePlanningHome({ host, hostId, cwd: run.writer_workspace_path, inputs: planningHomeInputs(db, context.projectId), log: bb.log }) ?? run.writer_workspace_path;
        return JSON.stringify(await host.call("closeBacklogItem", { requestedHostId: hostId, projectCwd: root, id: input.id, ...(input.note ? { note: input.note } : {}) }, { hostId, timeoutMs: 15_000 }));
      }
      const until = input.action === "release" ? null : input.until ? Date.parse(input.until) : HOLD_FOREVER;
      const changed: string[] = [];
      // A task of another run is named as refused, never reported as held (SMA bi_pause).
      const refused: Array<{ taskId: string; why: string }> = [];
      for (const taskId of input.taskIds) {
        if (setTaskHeldUntil(db, taskId, runId, until)) changed.push(taskId); else refused.push({ taskId, why: `not a task of run ${runId}` });
      }
      // A hold stops a queued task only: one whose writer already works goes on, and the PM must stop it (cancel) if it is not wanted.
      const working = input.action === "hold" ? changed.filter((taskId) => ["spawn_requested", "running"].includes(latestTaskAttemptState(db, context.projectId, taskId) ?? "")) : [];
      return JSON.stringify({ runId, action: input.action, tasks: changed, refused, until: until === null ? null : until >= HOLD_FOREVER ? "released by hand" : new Date(until).toISOString(),
        ...(working.length ? { notHeld: working, note: `${working.join(", ")}: the writer already works, a hold does not stop it` } : {}) });
    },
  });
}
