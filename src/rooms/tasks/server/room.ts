import type { Room } from "../../contracts";
import { tasksSettings } from "../settings";

export const room: Room<unknown> = {
  name: "tasks",
  settings: tasksSettings,
};
