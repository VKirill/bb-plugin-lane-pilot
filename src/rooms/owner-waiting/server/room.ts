import type { Room } from "../../contracts";
import { ownerWaitingMigrations } from "../migrations";
import { ownerWaitingSettings } from "../settings";

export const room: Room<unknown> = {
  name: "owner-waiting",
  migrations: ownerWaitingMigrations,
  settings: ownerWaitingSettings,
};
