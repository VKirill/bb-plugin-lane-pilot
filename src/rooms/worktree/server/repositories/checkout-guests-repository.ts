import { resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { activeRunForWorkspacePath, checkoutRunProject, getActivation, projectIdForCheckoutPath, type LanePilotDatabase } from "../../../storage";
import { GUEST_TTL_MS, trimGuests, type Guest } from "../../models/checkout-guests";

type Kv = BbPluginApi["storage"]["kv"];

const GUESTS = (path: string) => `checkout-guests:${resolve(path)}`;

/** The open Lane Pilot run that merges into this folder, if any. */
export function activeRunFor(db: LanePilotDatabase, path: string): { id: string; pmThreadId: string | null } | null {
  const row = activeRunForWorkspacePath(db, resolve(path), Date.now() - 24 * 3600_000);
  return row ?? null;
}

/** The project this folder is a checkout of: a run that wrote there, else the configured checkout of an activated project. */
export function checkoutProject(db: LanePilotDatabase, path: string): { projectId: string; pmThreadId: string | null } | null {
  const run = checkoutRunProject(db, path);
  if (run) return run;
  const projectId = projectIdForCheckoutPath(db, path);
  return projectId ? { projectId, pmThreadId: getActivation(db, projectId)?.pm_thread_id ?? null } : null;
}

/** The live guests of a folder (entries written by an older build — threadId and at only — still load). */
export async function listGuests(kv: Kv, path: string, now = Date.now()): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path));
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string" && now - row.at < GUEST_TTL_MS);
}

/** Every stored guest of a folder, live or expired (claim release and force-clear see them all). */
export async function allGuests(kv: Kv, path: string): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path));
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string");
}

/** Write the folder's guest list back; callers run it inside withGuestsLock so the read-modify-write stays one turn. */
export async function saveGuests(kv: Kv, path: string, guests: Guest[]): Promise<void> {
  await kv.set(GUESTS(path), trimGuests(guests) as never);
}
