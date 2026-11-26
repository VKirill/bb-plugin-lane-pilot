import type { Room } from "../../contracts";
import { verificationSettings } from "../settings";

export const room: Room<unknown> = {
  name: "verification",
  settings: verificationSettings,
};
