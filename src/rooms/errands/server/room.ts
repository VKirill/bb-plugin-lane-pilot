import type { Room } from "../../contracts";
import { bindTrajectoryDeltaReader, bindTrajectoryDeltaRecorder } from "../../platform/server";
import { trajectoryDeltaMigrations } from "../migrations";
import { errandsSettings } from "../settings";
import { listTrajectoryDeltasForRun, recordTrajectoryDelta } from "./repositories/trajectory-delta-repository";

export const room: Room<unknown> = {
  name: "errands",
  migrations: trajectoryDeltaMigrations,
  settings: errandsSettings,
  startup(ctx) {
    bindTrajectoryDeltaRecorder(ctx.db, recordTrajectoryDelta);
    bindTrajectoryDeltaReader(ctx.db, listTrajectoryDeltasForRun);
  },
};
