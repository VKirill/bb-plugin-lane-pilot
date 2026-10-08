import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../../contracts";
import { runView } from "../../board";
import type { ServerCore } from "../../../../server/core";
import type { Services } from "../../../../server/services";

/** The board's reads and writes over the schedule service (src/schedule/contract.ts says what each does). */
export function schedulesRpc(_ctx: ServerCore, services: Services) {
  const board = () => services.schedules;
  return {
    schedule_list: async ({ projectId, next }) => ({
      schedules: await board().listDetailed({ ...(projectId ? { projectId } : {}), ...(next !== undefined ? { next } : {}) }), hosts: await board().hostOptions(), now: Date.now(),
      errandDefault: board().errandDefault(projectId ?? null),
    }),
    schedule_get: async ({ id, runs, next }) => {
      const row = board().store.get(id);
      return { schedule: (await board().view(id, next ?? 5)) ?? null, runs: row ? await board().runsDetailed(id, runs ?? 20) : [], runTotal: row ? board().runCount(id) : 0 };
    },
    schedule_runs: async ({ id, limit, offset }) => ({ runs: await board().runsDetailed(id, limit ?? 50, offset ?? 0), total: board().runCount(id) }),
    schedule_preview: async ({ definition, next }) => {
      const result = await board().preview(definition, next);
      return { ok: result.ok, problems: result.problems, warnings: result.warnings, conflicts: result.conflicts, nextFires: result.nextFires, timeoutSec: result.timeoutSec };
    },
    schedule_upsert: async ({ definition }) => {
      const result = await board().save(definition, "owner");
      return result.ok
        ? { ok: true, schedule: result.schedule, problems: [], warnings: result.warnings, conflicts: result.conflicts }
        : { ok: false, schedule: null, problems: result.problems, warnings: [], conflicts: [] };
    },
    schedule_delete: ({ id }) => ({ ok: board().remove(id) }),
    schedule_pause: async ({ id, reason }) => { board().setPaused(id, true, reason); return { schedule: (await board().view(id, 5)) ?? null }; },
    schedule_resume: async ({ id }) => { board().setPaused(id, false); return { schedule: (await board().view(id, 5)) ?? null }; },
    schedule_run_now: ({ id, key }) => {
      const added = board().runNow(id, key);
      if (!added) return { ok: false, run: null, created: false, reason: "no such schedule" };
      return { ok: true, run: runView(board().store.getRun(added.run.id) ?? added.run), created: added.created };
    },
    schedule_cancel_run: async ({ runId }) => ({ ok: await board().cancelRun(runId) }),
    schedule_calendar: (input) => board().calendar(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "schedule_list" | "schedule_get" | "schedule_runs" | "schedule_preview" | "schedule_upsert" | "schedule_delete" | "schedule_pause" | "schedule_resume" | "schedule_run_now" | "schedule_cancel_run" | "schedule_calendar">;
}
