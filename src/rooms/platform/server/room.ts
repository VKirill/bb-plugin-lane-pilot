import type { Room } from "../../contracts";
import { platformSettings } from "../settings";

export const room: Room<unknown> = {
  name: "platform",
  settings: platformSettings,
};
