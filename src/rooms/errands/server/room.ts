import type { Room } from "../../contracts";
import { trajectoryDeltaMigrations } from "../migrations";
import { errandsSettings } from "../settings";

export const room: Room<unknown> = {
  name: "errands",
  migrations: trajectoryDeltaMigrations,
  settings: errandsSettings,
};
