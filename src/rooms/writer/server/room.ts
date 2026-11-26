import type { Room } from "../../contracts";
import { writerSettings } from "../settings";

export const room: Room<unknown> = {
  name: "writer",
  settings: writerSettings,
};
