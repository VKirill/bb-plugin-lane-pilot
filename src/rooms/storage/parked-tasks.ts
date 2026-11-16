import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PARKED_KEY, type ParkedTask } from "../contracts";

export async function readParkedTasks(kv: BbPluginApi["storage"]["kv"]): Promise<ParkedTask[]> {
  const stored = await kv.get(PARKED_KEY);
  return Array.isArray(stored) ? stored as ParkedTask[] : [];
}
