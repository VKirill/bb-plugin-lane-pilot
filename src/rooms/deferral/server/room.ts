import type { Room } from "../../contracts";
import { deferralMigrations } from "../migrations";

export const room: Room<unknown> = {
  name: "deferral",
  migrations: deferralMigrations,
};
