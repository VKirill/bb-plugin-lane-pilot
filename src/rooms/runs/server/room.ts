import type { Room } from "../../contracts";
import { runsSettings } from "../settings";

export const room: Room<unknown> = {
  name: "runs",
  settings: runsSettings,
};
