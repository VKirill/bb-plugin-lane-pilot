import type { Room } from "../../contracts";
import { qaSettings } from "../settings";

export const room: Room<unknown> = {
  name: "qa",
  settings: qaSettings,
};
