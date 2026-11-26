import type { Room } from "../../contracts";
import { nativeAgentSettings } from "../settings";

export const room: Room<unknown> = {
  name: "native-agent",
  settings: nativeAgentSettings,
};
