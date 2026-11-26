import { resolveRoleModel, roleRowOf } from "@lane-pilot/models";
import { postOwnerItem } from "../../../owner-waiting";
import type { HelperRequest } from "./workflow-agent";

type Pair = { providerId: string; model: string };
type Kv = { get(key: string): Promise<unknown>; set?(key: string, value: never): Promise<unknown> };
type Switch = { from: Pair; to: Pair; at: number };

/** Where the switch of a role is kept: the hub's key-value store, so it holds for every graph and survives a reload. */
export const roleSwitchKey = (role: string): string => `role_switch.${roleRowOf(role)}`;
export const roleSwitchItemKey = (role: string): string => `role-model:${roleRowOf(role)}`;

const samePair = (a: Pair, b: Pair) => a.providerId === b.providerId && a.model === b.model;

/**
 * The provider a role has left, while the owner's pick for the role is still the pair that failed. Changing the role's row in Settings
 * ends the switch, so the owner's choice always wins over the automatic one.
 */
export async function switchedFromProvider(kv: Kv | undefined, settings: Record<string, unknown>, role: string): Promise<string | null> {
  const saved = (await kv?.get(roleSwitchKey(role)).catch(() => null)) as Switch | null | undefined;
  if (!saved?.from) return null;
  const pick = resolveRoleModel(role, settings);
  return samePair(saved.from, { providerId: pick.providerId, model: pick.model }) ? saved.from.providerId : null;
}

/**
 * A provider refused the role (auth, quota, subscription): the role moves to its next model for every graph, and the owner gets one item
 * for the role. The same move seen again changes nothing. Returns true when this call recorded a new switch.
 */
export async function noteRoleSwitch(
  input: { kv: Kv | undefined; db: Parameters<typeof postOwnerItem>[0]; log: { warn(message: string): void }; settings: Record<string, unknown>; role: string; failed: Pair; to: Pair; reason: string; projectId?: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  const { kv, role, failed, to } = input;
  if (!kv?.set || samePair(failed, to)) return false;
  // The failed pair is the owner's pick when the role's row names that provider, so that Settings can tell when the owner changed it.
  const pick = resolveRoleModel(role, input.settings);
  const from = pick.providerId === failed.providerId ? { providerId: pick.providerId, model: pick.model } : failed;
  const saved = (await kv.get(roleSwitchKey(role)).catch(() => null)) as Switch | null | undefined;
  if (saved?.from && samePair(saved.from, from) && samePair(saved.to, to)) return false;
  await kv.set(roleSwitchKey(role), { from, to, at: now } as never);
  input.log.warn(`model unavailable role=${roleRowOf(role)} from=${from.providerId}/${from.model} to=${to.providerId}/${to.model}`);
  postOwnerItem(input.db, {
    key: roleSwitchItemKey(role), source: "workflow", kind: "model_unavailable", reason: "blocked", ...(input.projectId ? { projectId: input.projectId } : {}),
    what: `Model ${from.model} is unavailable for ${roleRowOf(role)}; using ${to.model}`,
    why: `${from.providerId} refused the work (${input.reason.slice(0, 200)}). Every graph now runs this role on ${to.providerId}/${to.model}. Change the role's model in Settings → model per function to end the switch.`,
  }, now);
  return true;
}

/** The limit rerun of a step moved it off `failed`: the role follows, unless the node named its own model or ZCode was merely busy. */
export async function switchRoleOnLimit(request: HelperRequest, failed: string, fallback: HelperRequest, limit: string, settings: Record<string, unknown>): Promise<boolean> {
  if (request.nodeModel || !fallback.provider || !fallback.model) return false;
  const { rt } = request;
  return noteRoleSwitch({ kv: rt.ctx.bb.storage?.kv, db: rt.ctx.db, log: rt.ctx.bb.log, settings, role: request.role, failed: { providerId: failed, model: request.model ?? "" }, to: { providerId: fallback.provider, model: fallback.model }, reason: limit, projectId: rt.projectId });
}
