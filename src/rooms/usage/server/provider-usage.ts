import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isZcodeProvider, type ZcodeBlock } from "@lane-pilot/models";
import { spentWindows, windowAppliesTo } from "../../session-hooks";

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
  kind: z.string().optional(),
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
  const serving = servingOf(resources, input);
  if (!serving.length) return null;
  const held: UsageHold[] = [];
  for (const { measurement } of serving) {
    if (measurement?.usage.status !== "ok") return null;
    const spent = spentWindows(measurement.usage.windows, input);
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

/** The resources that serve a provider on a machine: its own, else the shared ones. */
function servingOf(resources: ReadonlyArray<{ resource: UsageResource; measurement: UsageMeasurement | null }>, input: { providerId: string; hostId: string }) {
  const ofProvider = resources.filter((row) => row.resource.providerId === input.providerId);
  const own = ofProvider.filter((row) => row.resource.scope.kind === "host" && row.resource.scope.hostId === input.hostId);
  return own.length ? own : ofProvider.filter((row) => row.resource.scope.kind === "shared");
}

/** A rate-limit event the stability room stored (`provider/rateLimits/updated`): the fallback when the live reading has no answer. */
export type LimitEvent = { at: number; windows: Array<{ label: string | null; providerKey?: string | null; status: string; resetsAtMs: number | null }> };
export type LimitEventReader = (providerId: string) => Promise<LimitEvent | null>;
export const LIMIT_EVENT_MAX_AGE_MS = 6 * 3_600_000;

/**
 * The hold a stored limit event gives a provider whose live reading has no answer: a blocked window whose reset is still ahead, on an
 * event under six hours old, and only where `usage.skip_percent` is stored and above 0. A window that names a model family
 * (`opus`) counts only for that model. Reset = when the last blocked window frees (as usageHold).
 */
export function limitEventHold(event: LimitEvent | null, input: { model: string; threshold: number; now: number; settings?: Record<string, unknown> }): UsageHold | null {
  const stored = input.settings?.[USAGE_SKIP_KEY];
  if (input.threshold <= 0 || stored === undefined || stored === null || stored === "" || !(Number(stored) > 0)) return null;
  if (!event || !(event.at > 0) || input.now - event.at > LIMIT_EVENT_MAX_AGE_MS) return null;
  const blocked = event.windows.filter((w) => w.status === "blocked" && typeof w.resetsAtMs === "number" && w.resetsAtMs > input.now
    && windowAppliesTo({ model: /opus|sonnet|haiku/.exec(`${w.label ?? ""} ${w.providerKey ?? ""}`.toLowerCase())?.[0] ?? null }, input.model));
  if (!blocked.length) return null;
  return { percent: 100, window: blocked[0]!.label ?? "usage window", resetsAt: new Date(Math.max(...blocked.map((w) => w.resetsAtMs!))).toISOString() };
}

export type BoardWindows = { at: string | null; windows: Record<string, { utilization: number; resetsAt: string | null }> };

/**
 * A provider's subscription windows on a machine under the board's names (`five_hour`, `seven_day`, `seven_day_<family>`), from the
 * same resources a hold reads: the machine's own, else the shared ones. Several resources: the fullest figure of each window. `at` is
 * null while no resource has a readable measurement, so a board shows «nothing known», never an old figure.
 */
export function boardWindows(
  resources: ReadonlyArray<{ resource: UsageResource; measurement: UsageMeasurement | null }>,
  input: { providerId: string; hostId: string; now: number },
): BoardWindows {
  const serving = servingOf(resources, input);
  const windows: BoardWindows["windows"] = {};
  let read = false;
  for (const { measurement } of serving) {
    if (measurement?.usage.status !== "ok") continue;
    read = true;
    for (const window of measurement.usage.windows) {
      const family = window.model?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") || "";
      const span = window.kind === "five-hour" ? "five_hour" : window.kind === "weekly" ? "seven_day" : window.kind === "daily" ? "one_day" : window.label ?? "window";
      const name = family ? `${span}_${family}` : span;
      if (!windows[name] || window.usedPercent > windows[name]!.utilization) windows[name] = { utilization: window.usedPercent, resetsAt: window.resetsAt ?? null };
    }
  }
  return { at: read ? new Date(input.now).toISOString() : null, windows };
}

/** The reason an attempt carries when its writer pair is skipped; read as a limit by failure-class (uncharged, moves down the chain). */
export function usageHoldReason(providerId: string, model: string, hold: UsageHold): string {
  // ZCode is held by its machine's state (host, free hours, one task at a time), not by a window that fills up: no percentage.
  const level = isZcodeProvider(providerId) ? "" : ` at ${hold.percent}%`;
  return `writer_provider_unavailable:usage_window:${providerId}/${model}: ${hold.window}${level}${hold.resetsAt ? `, resets ${hold.resetsAt}` : ""}`;
}

type PluginsApi = {
  experimental_discoverRpc?: (query: { method: string }) => Promise<Array<{ pluginId: string }>>;
  callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;
};

/**
 * `zcode` answers whether the ZCode app may take work on a machine now (host, free hours, one slot: packages/models/src/zcode.ts). The
 * provider has no usage window to read, so its answer is a hold of its own, given whatever the usage threshold is (even 0, which turns the
 * windows off): a writer is not sent where it cannot work.
 */
export type ZcodeProbe = (input: { hostId: string; settings: Record<string, unknown> }) => Promise<ZcodeBlock | null>;

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
