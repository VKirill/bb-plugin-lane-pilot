import type { Room } from "../../contracts";
import { relaySettings } from "../settings";

export const room: Room<unknown> = {
  name: "relay",
  settings: relaySettings,
};
