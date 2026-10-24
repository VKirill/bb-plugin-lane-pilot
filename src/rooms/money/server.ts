import { hostContract } from "../contracts";
import { loadProjectSettings } from "../storage";
import type { ServerCore } from "../core/server";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { capOf, moneyHold, spendBook, windowHold, type DailyRow, type Price, type UsageWindow } from "./logic";

/** The spend book on the hub's token rows, the money cap, and the subscription windows the writer's machine last saw (its statusline cache). */
export function createMoney(ctx: Pick<ServerCore, "db" | "bb">) {
  const rows = (): DailyRow[] => (ctx.db.prepare("SELECT day, provider_id AS providerId, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens FROM lane_pilot_token_daily WHERE day >= ?")
    .all(new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)) as DailyRow[]);
  const settings = () => loadProjectSettings(ctx.db as never, GLOBAL_SETTINGS_PROJECT_ID);
  const overrides = (): Record<string, Record<string, Price>> => { try { const raw = settings()["money.prices"]; return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, Record<string, Price>> : {}; } catch { return {}; } };
  function status(now = Date.now()) {
    const book = spendBook(rows(), now, overrides());
    const cap = capOf(settings()["money.monthly_cap_usd"]);
    return { ...book, cap, capSet: cap !== null, left: cap === null ? null : Math.max(0, Math.round((cap - book.monthUsd) * 100) / 100) };
  }
  /** Why a writer of this provider and model must wait now: the money cap of a paid lane, or a closed subscription window on its machine. */
  async function holds(providerId: string, model: string, hostId: string): Promise<string | null> {
    const money = moneyHold(providerId, status().monthUsd, capOf(settings()["money.monthly_cap_usd"]));
    if (money) return money;
    if (providerId !== "claude-code") return null;
    try {
      const host = ctx.bb.hosts.experimental_client({ contract: hostContract });
      const answer = await host.call("readUsageWindows", { requestedHostId: hostId }, { hostId, timeoutMs: 5_000 });
      return windowHold(answer.windows as Partial<Record<"five_hour" | "seven_day" | "seven_day_opus", UsageWindow>>, model, Date.now());
    } catch {
      return null;
    }
  }
  return { money: { status, holds } };
}
export type MoneyApi = ReturnType<typeof createMoney>["money"];
