import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import { TURN_REQUESTED } from "../../anamnesis";
import type { ServerCore } from "../../contracts/server";
import { workGraphStats, workGraphStrips, workGraphTask, type TokenCursorReader } from "./report";
import { listAttemptHistory } from "../../storage";
import { tailWords } from "../log-tail";

/** BB pages thread events at 100 at most; a thread with more requested turns shows 100. */
export const TURNS_LIMIT = 100;
const CALL_MS = 4_000;

/** The work graph over RPC: one task with the turns of its threads (BB counts them), the cells of many, and stages × models. */
export function workGraphRpc(ctx: Pick<ServerCore, "bb" | "db">, services: { tokenCursorRow: TokenCursorReader }) {
  async function turnsOf(threadIds: readonly string[]): Promise<Map<string, number>> {
    const counted = await Promise.allSettled(threadIds.map(async (threadId) => {
      const list = bb.sdk.threads.events.list({ threadId, types: [TURN_REQUESTED], order: "desc", limit: String(TURNS_LIMIT) } as never) as unknown as Promise<unknown[]>;
      const events = await Promise.race([list, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CALL_MS))]);
      return [threadId, Array.isArray(events) ? events.length : 0] as const;
    }));
    const failed = counted.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) bb.log.info(`Lane Pilot work graph: could not count the turns of a thread: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`);
    return new Map(counted.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
  }
  const { bb, db } = ctx;
  return {
    work_graph_task: async ({ runId, taskId }) => {
      const first = workGraphTask(db, { runId, taskId }, services.tokenCursorRow);
      const threads = [...new Set(first.stages.flatMap((stage) => stage.rows.flatMap((row) => (row.threadId ? [row.threadId] : []))))];
      const turns = await turnsOf(threads);
      return workGraphTask(db, { runId, taskId }, services.tokenCursorRow, (threadId) => turns.get(threadId) ?? null);
    },
    /** The attempt's last lines in words (SMA m_ws_attempt_log): the latest attempt's thread tail as short Russian lines. */
    attempt_log_tail: async ({ runId, taskId }) => {
      const threadId = listAttemptHistory(db, runId, taskId).at(-1)?.thread_id ?? null;
      if (!threadId) return { threadId: null, lines: [] as string[] };
      const listed = await (bb.sdk.threads.events.list({ threadId, order: "desc", limit: "40" } as never) as Promise<unknown>).catch(() => null);
      const events = Array.isArray(listed) ? listed : (listed && typeof listed === "object" && Array.isArray((listed as { events?: unknown[] }).events) ? (listed as { events: unknown[] }).events : []);
      return { threadId, lines: tailWords([...events].reverse()) };
    },
    work_graph_strips: async ({ keys }) => workGraphStrips(db, keys, services.tokenCursorRow),
    work_graph_stats: async ({ projectId, days, excludeProjectIds }) => workGraphStats(db, { ...(projectId ? { projectId } : {}), days: days ?? 30, ...(excludeProjectIds ? { excludeProjectIds } : {}) }, services.tokenCursorRow),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "work_graph_task" | "attempt_log_tail" | "work_graph_strips" | "work_graph_stats">;
}
