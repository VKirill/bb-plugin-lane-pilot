import { settingOn } from "@lane-pilot/models";
/**
 * Money and spend (SMA map: Providers, models, accounts — Money and spend; Safety nets — The one price list, Spend book and budget window).
 * Subscription lanes (Claude Code, Codex, a coding plan) cost nothing per token on top of the plan; API lanes (OpenLux, an Anthropic or
 * OpenAI key) cost their price list. The money rule: routing takes subscription lanes first and a paid lane only while this month's
 * spend is under the cap (setting money.monthly_cap_usd; no cap set, no limit). Over the cap a paid lane holds, a subscription lane goes on.
 */
export type Price = { inputPerM: number; outputPerM: number; cachedPerM: number };

/** The one price list: USD per million tokens of the API lanes, by provider and model prefix; a model not listed takes its provider's default. */
export const PRICE_LIST: Readonly<Record<string, Readonly<Record<string, Price>>>> = {
  openlux: { default: { inputPerM: 0.5, outputPerM: 1.5, cachedPerM: 0.05 } },
  anthropic: { "claude-opus": { inputPerM: 15, outputPerM: 75, cachedPerM: 1.5 }, "claude-sonnet": { inputPerM: 3, outputPerM: 15, cachedPerM: 0.3 }, "claude-haiku": { inputPerM: 0.8, outputPerM: 4, cachedPerM: 0.08 }, default: { inputPerM: 3, outputPerM: 15, cachedPerM: 0.3 } },
  openai: { default: { inputPerM: 2.5, outputPerM: 10, cachedPerM: 0.25 } },
};

/** Lanes paid by the token; every other provider is a subscription lane. */
export const PAID_PROVIDERS = new Set(["openlux", "anthropic", "openai", "api"]);
export const isPaid = (providerId: string) => PAID_PROVIDERS.has(providerId) || providerId.startsWith("api-");

export function priceOf(providerId: string, model: string, overrides: Record<string, Record<string, Price>> = {}): Price | null {
  if (!isPaid(providerId)) return null;
  const list = { ...(PRICE_LIST[providerId] ?? {}), ...(overrides[providerId] ?? {}) };
  const key = Object.keys(list).filter((prefix) => prefix !== "default" && model.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return list[key ?? "default"] ?? PRICE_LIST.anthropic!.default!;
}

export type DailyRow = { day: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number };

/** USD of one day's row: tokens times the price (subscription lanes cost 0). */
export function rowUsd(row: DailyRow, overrides: Record<string, Record<string, Price>> = {}): number {
  const price = priceOf(row.providerId, row.model, overrides);
  if (!price) return 0;
  return (row.inputTokens * price.inputPerM + row.outputTokens * price.outputPerM + row.cachedTokens * price.cachedPerM) / 1_000_000;
}

/** One day of the spend series: the day total and the split by provider lane (the account the spend rows carry). */
export type SpendDay = { day: string; usd: number; byProvider: Record<string, number> };

/** Spent month to date and the spend series over the last 14 days (the spend book), from the daily token rows. */
export function spendBook(rows: readonly DailyRow[], now: number, overrides: Record<string, Record<string, Price>> = {}): { monthUsd: number; series: SpendDay[]; table: SpendDay[]; byProvider: Record<string, number> } {
  const month = new Date(now).toISOString().slice(0, 7);
  const days = Array.from({ length: 14 }, (_, index) => new Date(now - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const series: SpendDay[] = days.map((day) => ({ day, usd: 0, byProvider: {} }));
  const byProvider: Record<string, number> = {};
  let monthUsd = 0;
  for (const row of rows) {
    const usd = rowUsd(row, overrides);
    if (row.day.startsWith(month)) { monthUsd += usd; byProvider[row.providerId] = (byProvider[row.providerId] ?? 0) + usd; }
    const slot = series.find((entry) => entry.day === row.day);
    if (slot) {
      slot.usd += usd;
      if (usd) slot.byProvider[row.providerId] = Math.round(((slot.byProvider[row.providerId] ?? 0) + usd) * 100) / 100;
    }
  }
  const table = series.map((entry) => ({ ...entry, usd: Math.round(entry.usd * 100) / 100 }));
  return { monthUsd: Math.round(monthUsd * 100) / 100, series: table, table, byProvider };
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
 * The cap the settings give a paid lane. money.cap_unset_zero (off by default) switches the SMA «Paid lane has no money»
 * behaviour on: with no monthly cap set the cap is 0 and a paid lane holds until the person sets one.
 */
export function moneyCapFrom(settings: Record<string, unknown>): number | null {
  const cap = capOf(settings["money.monthly_cap_usd"]);
  return cap === null && settingOn(settings["money.cap_unset_zero"]) ? 0 : cap;
}

/** Money spent — stop: a paid lane holds once this month's spend reached the cap, or the task's own estimate would cross it; a subscription lane never holds for money. */
export function moneyHold(providerId: string, monthUsd: number, cap: number | null, taskUsd = 0): string | null {
  if (!isPaid(providerId) || cap === null) return null;
  if (monthUsd >= cap) return `money cap: ${monthUsd.toFixed(2)} of ${cap.toFixed(2)} USD spent this month on paid lanes; ${providerId} waits for the next month or a higher money.monthly_cap_usd, subscription lanes go on`;
  if (taskUsd > 0 && monthUsd + taskUsd > cap) return `money cap: the task's estimate of ${taskUsd.toFixed(2)} USD would cross the ${cap.toFixed(2)} USD monthly cap (${monthUsd.toFixed(2)} spent on paid lanes); ${providerId} waits for the next month or a higher money.monthly_cap_usd`;
  return null;
}

/** Subscription window open right now (SMA: Five hours and seven days, Open right now): closed at 98% until it resets. */
export type UsageWindow = { utilization: number; resetsAt: string | null };
export function windowHold(windows: Partial<Record<"five_hour" | "seven_day" | "seven_day_opus", UsageWindow>>, model: string, now: number, threshold = 98): string | null {
  const relevant: Array<["five_hour" | "seven_day" | "seven_day_opus", string]> = [["five_hour", "the five-hour window"], ["seven_day", "the seven-day window"]];
  if (/opus/i.test(model)) relevant.push(["seven_day_opus", "the seven-day Opus window"]);
  for (const [key, label] of relevant) {
    const window = windows[key];
    if (window && window.utilization >= threshold && (!window.resetsAt || Date.parse(window.resetsAt) > now)) {
      return `subscription: ${label} is at ${Math.round(window.utilization)}%${window.resetsAt ? `, reset ${window.resetsAt}` : ""}; the writer waits for it`;
    }
  }
  return null;
}
