import type { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isZcodeProvider } from "@lane-pilot/models";
import {
  CALL_TIMEOUT_MS,
  DISCOVERY_TTL_MS,
  HOLD_TIMEOUT_MS,
  INVENTORY_TTL_MS,
  MEASUREMENT_TTL_MS,
  USAGE_FETCH_METHOD,
  USAGE_LIST_METHOD,
  boardWindows,
  limitEventHold,
  listSchema,
  measurementSchema,
  servingOf,
  usageHold,
  type BoardWindows,
  type LimitEventReader,
  type UsageHold,
  type UsageMeasurement,
  type UsageResource,
  type ZcodeProbe,
} from "../../models/provider-usage";

type PluginsApi = {
  experimental_discoverRpc?: (query: { method: string }) => Promise<Array<{ pluginId: string }>>;
  callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;
};

/**
 * Provider usage (BB official plugin `provider-usage`, I1). Without any source (the plugins absent or disabled, an SDK without discovery,
 * a call that fails) nothing is held: usage only moves a writer off a provider that is nearly spent, it never blocks one.
 */
export function createProviderUsage(bb: BbPluginApi, now: () => number = Date.now, zcode?: ZcodeProbe, limitEvent?: LimitEventReader) {
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

  const listFailed = new Set<string>();
  async function inventory(pluginId: string): Promise<UsageResource[]> {
    const cached = inventories.get(pluginId);
    if (cached && now() - cached.at < INVENTORY_TTL_MS) return cached.resources;
    // A failed list keeps the last known resources for a hold; the machines list must still know the source did not answer.
    const resources = await call(pluginId, USAGE_LIST_METHOD, {}, listSchema).then((row) => { listFailed.delete(pluginId); return row.resources; }, () => { listFailed.add(pluginId); return cached?.resources ?? []; });
    inventories.set(pluginId, { at: now(), resources });
    return resources;
  }

  async function measurement(pluginId: string, resource: UsageResource, fresh = false): Promise<UsageMeasurement | null> {
    const key = JSON.stringify([pluginId, resource.id]);
    const cached = measurements.get(key);
    if (!fresh && cached && now() - cached.at < MEASUREMENT_TTL_MS) return cached.value;
    // an unreadable measurement caches as null for the TTL; `fresh` asks the source to measure again
    const value = await call(pluginId, USAGE_FETCH_METHOD, { resourceId: resource.id, refresh: fresh }, measurementSchema).catch(() => null);
    measurements.set(key, { at: now(), value });
    return value;
  }

  async function lookup(input: { providerId: string; model: string; hostId: string; fresh?: boolean }): Promise<Array<{ resource: UsageResource; measurement: UsageMeasurement | null }>> {
    const rows: Array<{ resource: UsageResource; measurement: UsageMeasurement | null }> = [];
    for (const pluginId of await discover()) {
      const matching = (await inventory(pluginId)).filter((resource) => resource.providerId === input.providerId
        && (resource.scope.kind === "shared" || resource.scope.hostId === input.hostId));
      rows.push(...await Promise.all(matching.map(async (resource) => ({ resource, measurement: await measurement(pluginId, resource, input.fresh) }))));
    }
    return rows;
  }

  /** The lookup of one decision, held at most HOLD_TIMEOUT_MS: null when it is slow or fails. */
  async function bounded(input: { providerId: string; model: string; hostId: string; fresh?: boolean }): Promise<Array<{ resource: UsageResource; measurement: UsageMeasurement | null }> | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup(input),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HOLD_TIMEOUT_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The hold on a provider/model for a writer on this machine, or null (nothing known, room left, the check is off, the
   * lookup failed or took too long). Never throws.
   */
  async function hold(input: { providerId: string; model: string; hostId: string; threshold: number; settings?: Record<string, unknown> }): Promise<UsageHold | null> {
    if (isZcodeProvider(input.providerId)) {
      // Without an answer ZCode is not sent work: its machine is the one place it works, and a refusal costs a task.
      const block = zcode ? await zcode({ hostId: input.hostId, settings: input.settings ?? {} }).catch(() => ({ detail: "ZCode state could not be read", resetsAt: null })) : null;
      return block ? { percent: 100, window: block.detail, resetsAt: block.resetsAt } : null;
    }
    if (input.threshold <= 0 || !input.providerId || !input.model) return null;
    const rows = await bounded(input);
    const live = rows ? usageHold(rows, { ...input, now: now() }) : null;
    // The stored rate-limit event answers only where the live reading has none for this provider: no readable window at all.
    if (live || !limitEvent || rows?.some((row) => row.measurement?.usage.status === "ok")) return live;
    return limitEventHold(await limitEvent(input.providerId).catch(() => null), { ...input, now: now() });
  }

  const refreshing = new Map<string, Promise<unknown>>();
  /** Fills the caches for a provider on a machine in the background, one lookup at a time per pair. */
  function refresh(input: { providerId: string; hostId: string }): void {
    const key = JSON.stringify([input.providerId, input.hostId]);
    if (refreshing.has(key)) return;
    refreshing.set(key, bounded({ ...input, model: "" }).finally(() => refreshing.delete(key)));
  }

  /**
   * The same answer as `hold` from what is cached, without waiting (the spawn resolvers are synchronous, as the Models view is): a
   * cache that is missing or older than its time to live is refreshed in the background, so the next decision sees it. Without a usage
   * source, nothing cached or a stale window that has since reset: null. Never throws, never calls a source itself.
   */
  function peek(input: { providerId: string; model: string; hostId: string; threshold: number }): UsageHold | null {
    if (input.threshold <= 0 || !input.providerId || !plugins?.experimental_discoverRpc || !plugins.callRpc) return null;
    try {
      const at = now();
      let stale = !sources || at - sources.at >= DISCOVERY_TTL_MS;
      const rows: Array<{ resource: UsageResource; measurement: UsageMeasurement | null }> = [];
      for (const pluginId of sources?.ids ?? []) {
        const listed = inventories.get(pluginId);
        if (!listed || at - listed.at >= INVENTORY_TTL_MS) stale = true;
        for (const resource of listed?.resources ?? []) {
          if (resource.providerId !== input.providerId || !(resource.scope.kind === "shared" || resource.scope.hostId === input.hostId)) continue;
          const seen = measurements.get(JSON.stringify([pluginId, resource.id]));
          if (!seen || at - seen.at >= MEASUREMENT_TTL_MS) stale = true;
          rows.push({ resource, measurement: seen?.value ?? null });
        }
      }
      if (stale) refresh(input);
      return usageHold(rows, { ...input, now: at });
    } catch {
      return null;
    }
  }

  /** Reads the usage of these providers on a machine into the caches before a decision, held at most HOLD_TIMEOUT_MS in all; never throws. */
  async function warm(input: { providerIds: readonly string[]; hostId: string }): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // One after the other: the second provider reads the inventory the first one cached instead of asking the source again.
        (async () => { for (const providerId of input.providerIds) await lookup({ providerId, model: "", hostId: input.hostId }); })(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, HOLD_TIMEOUT_MS); }),
      ]);
    } catch { /* unknown usage moves nothing */ } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The live windows of a provider on a machine for a board (the Money screen, the accounts, the money hold); empty when nothing answers. Never throws. */
  async function windows(input: { providerId: string; hostId: string }): Promise<BoardWindows> {
    const rows = await bounded({ ...input, model: "" });
    return boardWindows(rows ?? [], { ...input, now: now() });
  }

  /**
   * The raw windows (with their model and reset) of a provider on a machine, measured again now: what the session guard's usage snapshot
   * carries. `measuredAt` is the moment of that fresh reading; null when nothing readable came back, so no snapshot is written for it.
   */
  async function readings(input: { providerId: string; hostId: string }): Promise<{ measuredAt: string | null; windows: Array<{ label: string; usedPercent: number; resetsAt: string | null; model: string | null }> }> {
    const rows = await bounded({ ...input, model: "", fresh: true });
    const windows: Array<{ label: string; usedPercent: number; resetsAt: string | null; model: string | null }> = [];
    let read = false;
    for (const { measurement } of servingOf(rows ?? [], input)) {
      if (measurement?.usage.status !== "ok") continue;
      read = true;
      for (const w of measurement.usage.windows) windows.push({ label: w.label ?? w.kind ?? "window", usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, model: w.model?.trim() || null });
    }
    return { measuredAt: read ? new Date(now()).toISOString() : null, windows };
  }

  /**
   * A machine's board for the machines list (SMA m_mc_poll), where silence and «no windows» must read differently: null when the
   * lookup failed or ran out of time, when the hub has no usage source to ask, or when a subscription listed for the machine gave
   * no readable measurement; else its windows, none when the machine has no subscription of this provider. Never throws.
   */
  async function peerBoard(input: { providerId: string; hostId: string }): Promise<BoardWindows | null> {
    const rows = await bounded({ ...input, model: "" });
    if (rows === null) return null;
    const serving = servingOf(rows, input);
    if (serving.some(({ measurement }) => measurement?.usage.status === "ok")) return boardWindows(rows, { ...input, now: now() });
    const sources = await discover();
    // Nothing readable: silence when a subscription is listed, when there is no source to ask, or when a source's list failed.
    return serving.length || !sources.length || sources.some((id) => listFailed.has(id)) ? null : boardWindows(rows, { ...input, now: now() });
  }

  return { hold, peek, warm, windows, readings, peerBoard };
}

export type ProviderUsage = ReturnType<typeof createProviderUsage>;
