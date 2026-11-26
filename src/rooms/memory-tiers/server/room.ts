import type { Room } from "../../contracts";
import { memoryTierMigrations } from "../migrations";

export const room: Room<unknown> = {
  name: "memory-tiers",
  migrations: memoryTierMigrations,
};
