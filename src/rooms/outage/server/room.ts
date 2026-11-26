import type { Room } from "../../contracts";
import { outageMigrations } from "../migrations";

export const room: Room<unknown> = {
  name: "outage",
  migrations: outageMigrations,
};
