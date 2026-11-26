import type { Room } from "../../contracts";
import { rollbackMigrations } from "../migrations";

export const room: Room<unknown> = {
  name: "rollback",
  migrations: rollbackMigrations,
};
