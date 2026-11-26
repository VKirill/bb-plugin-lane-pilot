import { costUsd, priceFor, switchOn } from "@lane-pilot/models";
import { MONEY_CAP_UNSET_ZERO_KEY, MONEY_MONTHLY_CAP_USD_KEY } from "../settings";
/**
 * Money and spend (SMA map: Providers, models, accounts — Money and spend; Safety nets — The one price list, Spend book and budget window).
 * Subscription lanes (Claude Code, Codex, a coding plan) cost nothing per token on top of the plan; API lanes (OpenLux, an Anthropic or
 * OpenAI key) cost their price list from `@lane-pilot/models`. The money rule: routing takes subscription lanes first and a paid lane only while this month's
 * spend is under the cap (setting money.monthly_cap_usd). No cap set, a paid lane has no money and stays closed (the word `unlimited` opens it
 * with no cap; money.cap_unset_zero=off reads an unset cap as no limit). Over the cap a paid lane holds, a subscription lane goes on.
 */
export type Price = { inputPerM: number; outputPerM: number; cachedPerM: number };

/** Lanes paid by the token; every other provider is a subscription lane. */
export const PAID_PROVIDERS = new Set(["openlux", "anthropic", "openai", "api"]);
export const isPaid = (providerId: string) => PAID_PROVIDERS.has(providerId) || providerId.startsWith("api-");

function overridePriceOf(providerId: string, model: string, overrides: Record<string, Record<string, Price>>): Price | null {
  const list = overrides[providerId];
  if (!list) return null;
  const key = Object.keys(list).filter((prefix) => prefix !== "default" && model.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return list[key ?? "default"] ?? null;
}

export function paidModelPrice(providerId: string, model: string, overrides: Record<string, Record<string, Price>> = {}): Price | null {
  if (!isPaid(providerId)) return null;
  const override = overridePriceOf(providerId, model, overrides);
  if (override) return override;
  const listed = priceFor(model);
  return listed ? { inputPerM: listed.input, outputPerM: listed.output, cachedPerM: listed.cacheRead } : null;
}

export type DailyRow = { day: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number };

/** USD of one day's row: tokens times the price (subscription lanes cost 0; unpriced paid lanes are `not_measured`, never 0). */
export function paidRowUsd(row: DailyRow, overrides: Record<string, Record<string, Price>> = {}): number | "not_measured" {
  if (!isPaid(row.providerId)) return 0;
  const override = overridePriceOf(row.providerId, row.model, overrides);
  if (override) {
    return (row.inputTokens * override.inputPerM + row.outputTokens * override.outputPerM + row.cachedTokens * override.cachedPerM) / 1_000_000;
  }
  const usd = costUsd(row.model, { uncached: row.inputTokens, cacheRead: row.cachedTokens, cacheWrite: 0, output: row.outputTokens });
  return usd === null ? "not_measured" : usd;
}

/** One day of the spend series: the day total and the split by provider lane (the account the spend rows carry). */
export type SpendDay = { day: string; usd: number; byProvider: Record<string, number> };

/** Spent month to date and the spend series over the last 14 days (the spend book), from the daily token rows. */
export function spendBook(rows: readonly DailyRow[], now: number, overrides: Record<string, Record<string, Price>> = {}): { monthUsd: number; series: SpendDay[]; table: SpendDay[]; byProvider: Record<string, number>; costState: "measured" | "not_measured" } {
  const month = new Date(now).toISOString().slice(0, 7);
  const days = Array.from({ length: 14 }, (_, index) => new Date(now - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const series: SpendDay[] = days.map((day) => ({ day, usd: 0, byProvider: {} }));
  const byProvider: Record<string, number> = {};
  let monthUsd = 0;
  let unpricedCount = 0;
  for (const row of rows) {
    const usd = paidRowUsd(row, overrides);
    if (usd === "not_measured") { unpricedCount += 1; continue; }
    if (row.day.startsWith(month)) { monthUsd += usd; byProvider[row.providerId] = (byProvider[row.providerId] ?? 0) + usd; }
    const slot = series.find((entry) => entry.day === row.day);
    if (slot) {
      slot.usd += usd;
      if (usd) slot.byProvider[row.providerId] = Math.round(((slot.byProvider[row.providerId] ?? 0) + usd) * 100) / 100;
    }
  }
  const table = series.map((entry) => ({ ...entry, usd: Math.round(entry.usd * 100) / 100 }));
  return { monthUsd: Math.round(monthUsd * 100) / 100, series: table, table, byProvider, costState: unpricedCount > 0 ? "not_measured" : "measured" };
}

/**
 * Where the money cap is read: the global setting money.monthly_cap_usd; a non-number or ≤ 0 means no cap set, the
 * explicit word `unlimited` means no cap on purpose (Infinity, so a paid lane never holds on it).
 */
export function capOf(value: unknown): number | null {
  if (value === "unlimited") return Infinity;
  const cap = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * The cap the settings give a paid lane (SMA «Paid lane has no money», «The money rule»): with no monthly cap set the cap is 0
 * and a paid lane holds until the person sets one — a key added later cannot spend by itself. money.cap_unset_zero=off is the
 * opt-out: an unset cap then means no limit. Every lane of the owner's hub is a subscription, which never holds for money.
 */
export function moneyCapFrom(settings: Record<string, unknown>): number | null {
  const cap = capOf(settings[MONEY_MONTHLY_CAP_USD_KEY]);
  return cap === null && switchOn(settings, MONEY_CAP_UNSET_ZERO_KEY) ? 0 : cap;
}

/** Money spent — stop: a paid lane holds once this month's spend reached the cap, or the task's own estimate would cross it; a subscription lane never holds for money. */
export function moneyHold(providerId: string, monthUsd: number, cap: number | null, taskUsd = 0): string | null {
  if (!isPaid(providerId) || cap === null) return null;
  // A cap of 0 is only ever the unset one (capOf reads ≤ 0 as not set): nothing was spent, the channel is simply not configured.
  if (cap === 0) return `no money cap is set: ${providerId} is a paid lane and stays closed until the monthly cap is set in the Lane Pilot window (dollars, or the word unlimited) or bb lane-pilot setting money.cap_unset_zero=off; subscription lanes go on`;
  if (monthUsd >= cap) return `money cap: ${monthUsd.toFixed(2)} of ${cap.toFixed(2)} USD spent this month on paid lanes; ${providerId} waits for the next month or a higher money.monthly_cap_usd, subscription lanes go on`;
  if (taskUsd > 0 && monthUsd + taskUsd > cap) return `money cap: the task's estimate of ${taskUsd.toFixed(2)} USD would cross the ${cap.toFixed(2)} USD monthly cap (${monthUsd.toFixed(2)} spent on paid lanes); ${providerId} waits for the next month or a higher money.monthly_cap_usd`;
  return null;
}
