import { z } from "zod";
import { isZcodeProvider, type ZcodeBlock } from "@lane-pilot/models";
import { spentWindows, windowAppliesTo } from "../../session-hooks";
import { DEFAULT_USAGE_SKIP_PERCENT, USAGE_SKIP_KEY } from "../settings";

export { DEFAULT_USAGE_SKIP_PERCENT, USAGE_SKIP_KEY };

/**
 * Provider usage (BB official plugin `provider-usage`, I1). Pure schemas, rules, and types for provider
 * usage windows, rate-limit event fallbacks, and ZCode holds.
 */
export const USAGE_LIST_METHOD = "provider-usage.v1.listResources";
export const USAGE_FETCH_METHOD = "provider-usage.v1.getResource";

export const DISCOVERY_TTL_MS = 5 * 60_000;
export const INVENTORY_TTL_MS = 5 * 60_000;
export const MEASUREMENT_TTL_MS = 60_000;
export const CALL_TIMEOUT_MS = 8_000;
/** The whole lookup of one decision; a slow source must not hold a writer. */
export const HOLD_TIMEOUT_MS = 12_000;

export const resourceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }).passthrough(),
    z.object({ kind: z.literal("host"), hostId: z.string() }).passthrough(),
  ]),
}).passthrough();
export const listSchema = z.object({ resources: z.array(resourceSchema) }).passthrough();
export const windowSchema = z.object({
  kind: z.string().optional(),
  label: z.string().optional(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
}).passthrough();
export const measurementSchema = z.object({
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

/** The resources that serve a provider on a machine: its own, else the shared ones. */
export function servingOf(resources: ReadonlyArray<{ resource: UsageResource; measurement: UsageMeasurement | null }>, input: { providerId: string; hostId: string }) {
  const ofProvider = resources.filter((row) => row.resource.providerId === input.providerId);
  const own = ofProvider.filter((row) => row.resource.scope.kind === "host" && row.resource.scope.hostId === input.hostId);
  return own.length ? own : ofProvider.filter((row) => row.resource.scope.kind === "shared");
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

/**
 * `zcode` answers whether the ZCode app may take work on a machine now (host, free hours, one slot: packages/models/src/zcode.ts). The
 * provider has no usage window to read, so its answer is a hold of its own, given whatever the usage threshold is (even 0, which turns the
 * windows off): a writer is not sent where it cannot work.
 */
export type ZcodeProbe = (input: { hostId: string; settings: Record<string, unknown> }) => Promise<ZcodeBlock | null>;
