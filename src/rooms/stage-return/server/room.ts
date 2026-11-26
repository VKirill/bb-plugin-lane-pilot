import type { Room } from "../../contracts";
import { stageReturnMigrations } from "../migrations";

export const room: Room<unknown> = {
  name: "stage-return",
  migrations: stageReturnMigrations,
};
