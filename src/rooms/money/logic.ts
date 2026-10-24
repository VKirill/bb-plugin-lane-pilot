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

/** Spent month to date and the spend series over the last 14 days (the spend book), from the daily token rows. */
export function spendBook(rows: readonly DailyRow[], now: number, overrides: Record<string, Record<string, Price>> = {}): { monthUsd: number; series: Array<{ day: string; usd: number }>; byProvider: Record<string, number> } {
  const month = new Date(now).toISOString().slice(0, 7);
  const days = Array.from({ length: 14 }, (_, index) => new Date(now - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const series = days.map((day) => ({ day, usd: 0 }));
  const byProvider: Record<string, number> = {};
  let monthUsd = 0;
  for (const row of rows) {
    const usd = rowUsd(row, overrides);
    if (row.day.startsWith(month)) { monthUsd += usd; byProvider[row.providerId] = (byProvider[row.providerId] ?? 0) + usd; }
    const slot = series.find((entry) => entry.day === row.day);
    if (slot) slot.usd += usd;
  }
  return { monthUsd: Math.round(monthUsd * 100) / 100, series: series.map((entry) => ({ ...entry, usd: Math.round(entry.usd * 100) / 100 })), byProvider };
}

/** Where the money cap is read: the global setting money.monthly_cap_usd; a non-number or ≤ 0 means no cap set. */
export function capOf(value: unknown): number | null {
  const cap = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** Money spent — stop: a paid lane holds once this month's spend reached the cap; a subscription lane never holds for money. */
export function moneyHold(providerId: string, monthUsd: number, cap: number | null): string | null {
  if (!isPaid(providerId) || cap === null) return null;
  return monthUsd >= cap ? `money cap: ${monthUsd.toFixed(2)} of ${cap.toFixed(2)} USD spent this month on paid lanes; ${providerId} waits for the next month or a higher money.monthly_cap_usd, subscription lanes go on` : null;
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
