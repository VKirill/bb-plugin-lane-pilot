import type { Room } from "../../contracts";
import { scheduleMigrations } from "../migrations";
import { scheduleSettings } from "../settings";

export const room: Room<unknown> = {
  name: "schedule",
  migrations: scheduleMigrations,
  settings: scheduleSettings,
};
