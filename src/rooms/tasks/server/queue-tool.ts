import { z } from "zod";
import { ToolError, registerObservedTool, type ServerCore } from "../../core/server";
import { deadLetters, HOLD_FOREVER } from "../rails";
import { hostContract } from "../../contracts";
import { getRun, getRunWriterHost } from "../../storage";

/**
 * The PM's queue controls (SMA map: Durable queue row): hold a task out of the queue until a date or until released (Held until year 2999),
 * release it, and list the dead letters — tasks that ended blocked or rejected and nobody sent again within a day (Dead-letter queue).
 */
export function registerQueueTool(ctx: ServerCore): void {
  const { db, bb } = ctx;
  const runOf = async (threadId: string) => {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }) as Record<string, unknown> | null;
    const runId = typeof metadata?.lanePilotRunId === "string" ? metadata.lanePilotRunId : null;
    if (metadata?.role !== "pm" || !runId) throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
    return runId;
  };
  registerObservedTool(bb.agents, {
    name: "lane_pilot_queue",
    description: "The run's queue: hold tasks out of it until a date or until released, release them, list the dead letters (tasks that ended blocked and were not sent again).",
    instructions: "`hold` (taskIds, until? ISO date; without it the task waits until `release`): a queued task takes no writer while held. `release` (taskIds). `close_backlog` (id): the backlog item the accepted work came from gets status done in its meta.yaml — exactly that item. `dead_letters`: the tasks of this project whose latest attempt ended blocked or rejected more than a day ago and that nobody sent again — fix and send each again, or cancel it with the words why.",
    parameters: z.discriminatedUnion("action", [
      z.object({ action: z.literal("hold"), taskIds: z.array(z.string().min(1)).min(1).max(50), until: z.string().datetime().optional() }).strict(),
      z.object({ action: z.literal("release"), taskIds: z.array(z.string().min(1)).min(1).max(50) }).strict(),
      z.object({ action: z.literal("dead_letters") }).strict(),
      z.object({ action: z.literal("close_backlog"), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), note: z.string().max(300).optional() }).strict(),
    ]),
    execute: async (input, context) => {
      if (input.action === "dead_letters") {
        const rows = db.prepare(`SELECT a.task_id AS taskId, a.state, a.reason, a.updated_at AS updatedAt FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
          WHERE r.project_id=? AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id) ORDER BY a.updated_at DESC LIMIT 500`).all(context.projectId) as Array<{ taskId: string; state: string; reason: string | null; updatedAt: number }>;
        return JSON.stringify({ deadLetters: deadLetters(rows, Date.now()).slice(0, 50) });
      }
      const runId = await runOf(context.threadId);
      if (input.action === "close_backlog") {
        // Close exactly that line: the backlog item the accepted work came from is marked done in its own meta.yaml, nothing else.
        const run = getRun(db, runId);
        const hostId = getRunWriterHost(db, runId);
        if (!run?.writer_workspace_path || !hostId) throw new ToolError("this run has no checkout to close the backlog item in", { code: "no_checkout", retryable: false, sideEffects: "none" });
        const host = bb.hosts.experimental_client({ contract: hostContract });
        return JSON.stringify(await host.call("closeBacklogItem", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, id: input.id, ...(input.note ? { note: input.note } : {}) }, { hostId, timeoutMs: 15_000 }));
      }
      const until = input.action === "release" ? null : input.until ? Date.parse(input.until) : HOLD_FOREVER;
      const changed: string[] = [];
      for (const taskId of input.taskIds) {
        const result = db.prepare("UPDATE lane_pilot_task SET held_until=? WHERE id=? AND run_id=?").run(until, taskId, runId);
        if (result.changes) changed.push(taskId);
      }
      return JSON.stringify({ runId, action: input.action, tasks: changed, until: until === null ? null : until >= HOLD_FOREVER ? "released by hand" : new Date(until).toISOString() });
    },
  });
}
