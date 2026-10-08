import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Provider usage (BB official plugin `provider-usage`, I1). The plugin's own RPC (`getUsage`) is only a display
 * aggregate that drops the model of a window and exists only while the plugin is enabled. The data comes from the
 * usage SOURCES it reads — provider-claude-code, provider-codex, provider-acp, account-pool — through their published
 * contract (`usage-source-contract.ts`): `provider-usage.v1.listResources` (cheap inventory) and
 * `provider-usage.v1.getResource` (one resource; `refresh:false` allows a cached measurement). Sources are found with
 * `bb.sdk.plugins.experimental_discoverRpc`, so Lane Pilot needs neither the display plugin nor a plugin id.
 *
 * Without any source (the plugins absent or disabled, an SDK without discovery, a call that fails) nothing is held:
 * usage only moves a writer off a provider that is nearly spent, it never blocks one.
 */
export const USAGE_LIST_METHOD = "provider-usage.v1.listResources";
export const USAGE_FETCH_METHOD = "provider-usage.v1.getResource";
export const USAGE_SKIP_KEY = "usage.skip_percent";
export const DEFAULT_USAGE_SKIP_PERCENT = 90;

const DISCOVERY_TTL_MS = 5 * 60_000;
const INVENTORY_TTL_MS = 5 * 60_000;
const MEASUREMENT_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
/** The whole lookup of one decision; a slow source must not hold a writer. */
const HOLD_TIMEOUT_MS = 12_000;

const resourceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }).passthrough(),
    z.object({ kind: z.literal("host"), hostId: z.string() }).passthrough(),
  ]),
}).passthrough();
const listSchema = z.object({ resources: z.array(resourceSchema) }).passthrough();
const windowSchema = z.object({
  label: z.string().optional(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
}).passthrough();
const measurementSchema = z.object({
  usage: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), windows: z.array(windowSchema) }).passthrough(),
    z.object({ status: z.enum(["not_installed", "unauthenticated", "expired", "error"]) }).passthrough(),
  ]),
}).passthrough();

export type UsageResource = z.infer<typeof resourceSchema>;
export type UsageMeasurement = z.infer<typeof measurementSchema>;
export type UsageHold = { percent: number; window: string; resetsAt: string | null };

/** The percentage from which a provider's window counts as spent; 0 turns the check off. */
export function usageSkipPercent(settings: Record<string, unknown>): number {
  const raw = settings[USAGE_SKIP_KEY];
  if (raw === undefined || raw === null || raw === "") return DEFAULT_USAGE_SKIP_PERCENT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_USAGE_SKIP_PERCENT;
}

/** A window of a model family (`opus`) applies to a model id that names it; a window of no model applies to all. */
function windowAppliesTo(window: { model?: string | null | undefined }, model: string): boolean {
  const family = window.model?.trim().toLowerCase();
  return !family || model.toLowerCase().includes(family);
}

/**
 * Whether a pair is held now: every resource that serves it (the writer's machine's own, else the shared ones) has a
 * window that applies to the model, is at or above the threshold and has not reset yet. One resource with room means
 * the pair can still run. `resetsAt` is when the first resource frees up (null when a source does not say).
 */
export function usageHold(
  resources: ReadonlyArray<{ resource: UsageResource; measurement: UsageMeasurement | null }>,
  input: { providerId: string; model: string; hostId: string; threshold: number; now: number },
): UsageHold | null {
  if (input.threshold <= 0) return null;
  const ofProvider = resources.filter((row) => row.resource.providerId === input.providerId);
  const own = ofProvider.filter((row) => row.resource.scope.kind === "host" && row.resource.scope.hostId === input.hostId);
  const serving = own.length ? own : ofProvider.filter((row) => row.resource.scope.kind === "shared");
  if (!serving.length) return null;
  const held: UsageHold[] = [];
  for (const { measurement } of serving) {
    if (measurement?.usage.status !== "ok") return null;
    const spent = measurement.usage.windows.filter((window) => windowAppliesTo(window, input.model) && window.usedPercent >= input.threshold
      && !(window.resetsAt && Date.parse(window.resetsAt) <= input.now));
    if (!spent.length) return null;
    const worst = spent.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    // The resource is free again once its last spent window resets; a window with no known reset keeps it unknown.
    const resets = spent.map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN));
    held.push({ percent: Math.round(worst.usedPercent), window: worst.label ?? "usage window",
      resetsAt: resets.some(Number.isNaN) ? null : new Date(Math.max(...resets)).toISOString() });
  }
  // The pair is free again once the first resource is; unknown when any of them has no known reset.
  const resets = held.map((row) => row.resetsAt);
  const worst = held.reduce((a, b) => (b.percent > a.percent ? b : a));
  return { percent: worst.percent, window: worst.window,
    resetsAt: resets.some((at) => at === null) ? null : resets.map((at) => at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0]! };
}

/** The reason an attempt carries when its writer pair is skipped; read as a limit by failure-class (uncharged, moves down the chain). */
export function usageHoldReason(providerId: string, model: string, hold: UsageHold): string {
  return `writer_provider_unavailable:usage_window:${providerId}/${model}: ${hold.window} at ${hold.percent}%${hold.resetsAt ? `, resets ${hold.resetsAt}` : ""}`;
}

type PluginsApi = {
  experimental_discoverRpc?: (query: { method: string }) => Promise<Array<{ pluginId: string }>>;
  callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;
};

export function createProviderUsage(bb: BbPluginApi, now: () => number = Date.now) {
  const plugins = (bb.sdk as { plugins?: PluginsApi }).plugins;
  let sources: { ids: string[]; at: number } | null = null;
  const inventories = new Map<string, { at: number; resources: UsageResource[] }>();
  const measurements = new Map<string, { at: number; value: UsageMeasurement | null }>();

  async function discover(): Promise<string[]> {
    if (!plugins?.experimental_discoverRpc || !plugins.callRpc) return [];
    if (sources && now() - sources.at < DISCOVERY_TTL_MS) return sources.ids;
    // A failed lookup counts as «none» for the same time: a hub without these plugins is asked once in five minutes.
    const ids = await Promise.resolve().then(() => plugins.experimental_discoverRpc!({ method: USAGE_LIST_METHOD }))
      .then((rows) => [...new Set(rows.map((row) => row.pluginId))]).catch(() => [] as string[]);
    sources = { ids, at: now() };
    return ids;
  }

  async function call<T>(pluginId: string, method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
    return await plugins!.callRpc!({ pluginId, method, input, outputSchema: schema as z.ZodType<unknown>, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }) as T;
  }

  async function inventory(pluginId: string): Promise<UsageResource[]> {
    const cached = inventories.get(pluginId);
    if (cached && now() - cached.at < INVENTORY_TTL_MS) return cached.resources;
    const resources = await call(pluginId, USAGE_LIST_METHOD, {}, listSchema).then((row) => row.resources, () => cached?.resources ?? []);
    inventories.set(pluginId, { at: now(), resources });
    return resources;
  }

  async function measurement(pluginId: string, resource: UsageResource): Promise<UsageMeasurement | null> {
    const key = JSON.stringify([pluginId, resource.id]);
    const cached = measurements.get(key);
    if (cached && now() - cached.at < MEASUREMENT_TTL_MS) return cached.value;
    const value = await call(pluginId, USAGE_FETCH_METHOD, { resourceId: resource.id, refresh: false }, measurementSchema).catch(() => null);
    measurements.set(key, { at: now(), value });
    return value;
  }

  async function lookup(input: { providerId: string; model: string; hostId: string }): Promise<Array<{ resource: UsageResource; measurement: UsageMeasurement | null }>> {
    const rows: Array<{ resource: UsageResource; measurement: UsageMeasurement | null }> = [];
    for (const pluginId of await discover()) {
      const matching = (await inventory(pluginId)).filter((resource) => resource.providerId === input.providerId
        && (resource.scope.kind === "shared" || resource.scope.hostId === input.hostId));
      rows.push(...await Promise.all(matching.map(async (resource) => ({ resource, measurement: await measurement(pluginId, resource) }))));
    }
    return rows;
  }

  /**
   * The hold on a provider/model for a writer on this machine, or null (nothing known, room left, the check is off, the
   * lookup failed or took too long). Never throws.
   */
  async function hold(input: { providerId: string; model: string; hostId: string; threshold: number }): Promise<UsageHold | null> {
    if (input.threshold <= 0 || !input.providerId || !input.model) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([
        lookup(input),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HOLD_TIMEOUT_MS); }),
      ]);
      return rows ? usageHold(rows, { ...input, now: now() }) : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { hold };
}

export type ProviderUsage = ReturnType<typeof createProviderUsage>;
