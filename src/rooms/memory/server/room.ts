import type { Room } from "../../contracts";
import { memorySettings } from "../settings";

export const room: Room<unknown> = {
  name: "memory",
  settings: memorySettings,
};
