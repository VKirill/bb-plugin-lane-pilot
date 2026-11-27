import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import { loadPushConfig } from "../../../owner-waiting";
import {
  consoleOverview,
  type MoneyStatusLike,
  type OwnerWaitingLike,
  type SpecialistOverviewLike,
} from "../services/console-overview";
import { taskHistory } from "../services/task-history";
import {
  threadScope,
  type ThreadPlaceLike,
  type ThreadScopeRepo,
} from "../services/thread-scope";
import type { runsRpc } from "./runs-rpc";

type ServerCore = Parameters<typeof runsRpc>[0];

export interface ConsoleRpcServices {
  money: { status(): MoneyStatusLike };
  specialistOverview: (db: ServerCore["db"], projectId?: string, nowMs?: number) => SpecialistOverviewLike;
  collectOwnerWaiting?: (db: ServerCore["db"], now: number) => OwnerWaitingLike;
  lessonForTask?: (db: ServerCore["db"], taskId: string) => string | null;
  projectPlace?: (projectId: string) => Promise<ThreadPlaceLike | null>;
  memoryProject?: (hostId: string, path: string) => Promise<{ projectId: string; sectionId?: string } | null>;
  probeRepo?: (hostId: string, path: string) => Promise<ThreadScopeRepo | null>;
}

/** Console read-model RPC handlers backed by the runs room (`console_overview`, `task_history`, `thread_scope`). */
export function runsConsoleRpc(ctx: ServerCore, services: ConsoleRpcServices) {
  const log = {
    warn: (message: string) => ctx.log(message),
    debug: (message: string) => ctx.bb.log.debug(message),
  };
  return {
    console_overview: async ({ projectId, sectionId, days }) => {
      const tz = loadPushConfig(ctx.db).timezone ?? "UTC";
      return consoleOverview(
        {
          db: ctx.db,
          money: services.money,
          specialistOverview: services.specialistOverview,
          collectOwnerWaiting: services.collectOwnerWaiting,
          tz,
          log,
        },
        { projectId, sectionId, days },
      );
    },
    task_history: async (input) =>
      taskHistory(ctx.db, input, Date.now(), {
        lessonForTask: services.lessonForTask,
        log,
      }),
    thread_scope: ({ threadId }) =>
      threadScope(
        {
          bb: ctx.bb,
          projectPlace: services.projectPlace,
          memoryProject: services.memoryProject ?? (async () => null),
          probeRepo: services.probeRepo ?? (async () => null),
          log,
        },
        threadId,
      ),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "console_overview" | "task_history" | "thread_scope">;
}
