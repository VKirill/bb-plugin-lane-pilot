import type { LoopHealthEntry } from "@lane-pilot/contracts";
import type { AutonomousAction, Room } from "../../contracts";
import type { ScheduleService } from "../../schedule/server";
import type { LanePilotDatabase } from "../../storage";
import { specialistSettings } from "../settings";
import { runSpecialistCli, SPECIALIST_USAGE } from "./handlers/sp-cli";
import { actionsLog, type ActionsLogInput } from "./services/actions-log";
import { setSpecialistAutonomy, type SetAutonomyInput } from "./services/sp-autonomy-service";
import {
  approveCharter,
  proposeCharter,
  type ApproveCharterInput,
  type ProposeCharterInput,
} from "./services/sp-charter-service";
import { specialistDetail, type SpecialistDetailInput } from "./services/sp-detail";
import type { WfRunMetaReader } from "./services/sp-detail-shifts";
import { specialistOverview } from "./services/sp-overview";

export type SpecialistRoomServices = {
  autonomousEffects?: (db: LanePilotDatabase, since?: number, limit?: number, projectId?: string) => AutonomousAction[];
  leadDecisions?: (db: LanePilotDatabase, since?: number, limit?: number, projectId?: string) => AutonomousAction[];
  schedules?: Pick<ScheduleService, "list" | "runs">;
  wfRunMeta?: WfRunMetaReader;
  loopHealth?: (
    db: LanePilotDatabase,
    options?: { now?: number; projectId?: string | null; domain?: string },
  ) => LoopHealthEntry[];
};

export const room: Room<SpecialistRoomServices> = {
  name: "specialist",
  settings: specialistSettings,
  cli: [
    {
      name: "specialist",
      summary: "Specialist OS autonomy table, grants, and revocations",
      usage: SPECIALIST_USAGE,
      fullHelp: true,
      run: ({ ctx, args, invocation }) => runSpecialistCli(ctx, args, invocation),
    },
  ],
  rpc: (ctx, services) => ({
    specialist_overview: async ({ projectId }: { projectId?: string }) => specialistOverview(ctx.db, projectId),
    specialist_detail: async (input: SpecialistDetailInput) =>
      specialistDetail(
        {
          db: ctx.db,
          kv: ctx.bb.storage.kv,
          schedules: services?.schedules,
          wfRunMeta: services?.wfRunMeta,
          loopHealth: services?.loopHealth,
          log: {
            warn: (message) => ctx.log(message),
            debug: (message) => ctx.bb.log.debug(message),
          },
        },
        input,
      ),
    actions_log: async (input: ActionsLogInput) =>
      actionsLog(ctx.db, input, {
        autonomousEffects: services?.autonomousEffects,
        leadDecisions: services?.leadDecisions,
        log: {
          warn: (message) => ctx.log(message),
          debug: (message) => ctx.bb.log.debug(message),
        },
      }),
    specialist_autonomy_set: async (input: SetAutonomyInput) =>
      setSpecialistAutonomy(
        {
          db: ctx.db,
          log: {
            info: (message) => ctx.bb.log.info(message),
            warn: (message) => ctx.log(message),
          },
        },
        input,
      ),
    charter_propose: async (input: ProposeCharterInput) => proposeCharter(ctx, input),
    charter_approve: async (input: ApproveCharterInput) => approveCharter(ctx, input),
  }),
};
