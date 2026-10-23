import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import { TURN_REQUESTED } from "../../anamnesis";
import type { ServerCore } from "../../core/server";
import { workGraphStats, workGraphStrips, workGraphTask } from "./report";

const TURNS_LIMIT = 500;
const CALL_MS = 4_000;

/** The work graph over RPC: one task with the turns of its threads (BB counts them), the cells of many, and stages × models. */
export function workGraphRpc(ctx: Pick<ServerCore, "bb" | "db">) {
  async function turnsOf(threadIds: readonly string[]): Promise<Map<string, number>> {
    const counted = await Promise.allSettled(threadIds.map(async (threadId) => {
      const list = bb.sdk.threads.events.list({ threadId, types: [TURN_REQUESTED], order: "desc", limit: String(TURNS_LIMIT) } as never) as unknown as Promise<unknown[]>;
      const events = await Promise.race([list, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CALL_MS))]);
      return [threadId, Array.isArray(events) ? events.length : 0] as const;
    }));
    return new Map(counted.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
  }
  const { bb, db } = ctx;
  return {
    work_graph_task: async ({ runId, taskId }) => {
      const first = workGraphTask(db, { runId, taskId });
      const threads = [...new Set(first.stages.flatMap((stage) => stage.rows.flatMap((row) => (row.threadId ? [row.threadId] : []))))];
      const turns = await turnsOf(threads);
      return workGraphTask(db, { runId, taskId }, (threadId) => turns.get(threadId) ?? null);
    },
    work_graph_strips: async ({ keys }) => workGraphStrips(db, keys),
    work_graph_stats: async ({ projectId, days, excludeProjectIds }) => workGraphStats(db, { ...(projectId ? { projectId } : {}), days: days ?? 30, ...(excludeProjectIds ? { excludeProjectIds } : {}) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "work_graph_task" | "work_graph_strips" | "work_graph_stats">;
}
