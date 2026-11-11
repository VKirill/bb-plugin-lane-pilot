import { settingOff, settingOn, switchOn } from "@lane-pilot/models";
import { loadProjectSettings } from "../storage";
import { measuredAttemptTokens, medianTokens, tokenDailyRowsSince, unmeasuredAttempts } from "../usage/server";
import type { ServerCore } from "../contracts/server";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { capOf, isPaid, moneyCapFrom, moneyHold, priceOf, spendBook, type DailyRow, type Price } from "./logic";

/** The spend book on the hub's token rows and the money cap of the paid lanes. */
export function createMoney(ctx: Pick<ServerCore, "db" | "bb">) {
  const rows = (): DailyRow[] => tokenDailyRowsSince(ctx.db, new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
  const settings = () => loadProjectSettings(ctx.db as never, GLOBAL_SETTINGS_PROJECT_ID);
  const overrides = (): Record<string, Record<string, Price>> => { try { const raw = settings()["money.prices"]; return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, Record<string, Price>> : {}; } catch { return {}; } };
  /**
   * The estimate of the attempts a paid provider never reported usage for (SMA «Estimate when the vendor is silent»):
   * each counts its task appetite in tokens, else money.silent_estimate_tokens, else the median token count of the last
   * 20 finished attempts of the same provider and model that did report usage (fewer than 5 such attempts: no estimate,
   * the spend stays unknown, never zero by silence), priced at the lane's list price, blended input/output — nobody
   * knows the real split. It counts toward the cap through monthUsd, and only while a cap is set does it hold anything.
   */
  function estimatedUsd(now: number): { usd: number; estimatedAttempts: number; silentAttempts: number } {
    const fallback = capOf(settings()["money.silent_estimate_tokens"]);
    const priceOverrides = overrides();
    const sinceMs = Date.parse(`${new Date(now).toISOString().slice(0, 7)}-01T00:00:00Z`);
    let lanes: Map<string, number[]> | null = null;
    let usd = 0, estimatedAttempts = 0, silentAttempts = 0;
    // One thread is one session however many attempts reused it: it is priced once.
    const seen = new Set<string>();
    for (const attempt of unmeasuredAttempts(ctx.db, { sinceMs })) {
      if (seen.has(attempt.threadId)) continue;
      seen.add(attempt.threadId);
      if (!attempt.providerId || !isPaid(attempt.providerId)) continue;
      const price = priceOf(attempt.providerId, attempt.model ?? "", priceOverrides);
      if (!price) continue;
      silentAttempts += 1;
      let tokens = attempt.appetiteTokens ?? fallback;
      if (!tokens || !Number.isFinite(tokens)) {
        lanes ??= measuredAttemptTokens(ctx.db, { sinceMs: now - 90 * 86_400_000, limit: 20 }); // a bounded read: the last 20 of a lane are not older than a quarter
        tokens = medianTokens(lanes.get(`${attempt.providerId}${attempt.model ?? ""}`) ?? []) ?? null;
      }
      if (!tokens) continue;
      estimatedAttempts += 1;
      usd += tokens * (price.inputPerM + price.outputPerM) / 2 / 1_000_000;
    }
    return { usd: Math.round(usd * 100) / 100, estimatedAttempts, silentAttempts };
  }
  function status(now = Date.now()) {
    const book = spendBook(rows(), now, overrides());
    const estimate = estimatedUsd(now);
    const estimated = estimate.usd;
    // The window shows the cap the person set: an unset one reads «not set» here, though it closes a paid lane (moneyCapFrom).
    const cap = capOf(settings()["money.monthly_cap_usd"]);
    const monthUsd = Math.round((book.monthUsd + estimated) * 100) / 100;
    // `unlimited` is no cap on purpose: it reads as «no cap» to the window (Infinity does not survive JSON), and is named apart.
    const limit = cap !== null && Number.isFinite(cap) ? cap : null;
    return { ...book, monthUsd, estimated, estimatedUsd: estimated, estimatedAttempts: estimate.estimatedAttempts,
      // A silent attempt with too little lane history is `unknown`: it is not summed and not zero.
      silentAttempts: estimate.silentAttempts, silentUnknown: estimate.silentAttempts - estimate.estimatedAttempts,
      cap: limit, capSet: limit !== null, unlimited: cap === Infinity, left: limit === null ? null : Math.max(0, Math.round((limit - monthUsd) * 100) / 100) };
  }
  /**
   * Per-task ceiling (SMA m_mo_task_ceiling), only where money.task_ceiling is on: the task is priced at its appetite in output
   * tokens (the cautious side of the split) before it starts. Off or unset, a set cap holds as on main: only once it is spent.
   */
  function taskEstimateUsd(providerId: string, model: string, appetiteTokens?: number): number {
    if (!appetiteTokens || !(settingOn(settings()["money.task_ceiling"]) || (!settingOff(settings()["money.task_ceiling"]) && switchOn(settings(), "money.task_ceiling")))) return 0;
    const price = priceOf(providerId, model, overrides());
    return price ? appetiteTokens * price.outputPerM / 1_000_000 : 0;
  }
  /**
   * The money cap alone, for a chain member the writer walk asks about: a paid lane over the cap, or whose task estimate would cross it.
   * No cap set (or the word unlimited) holds nothing and reads no window; a subscription lane never holds for money.
   */
  async function capHolds(providerId: string, model: string, _hostId: string, input?: { appetiteTokens?: number }): Promise<string | null> {
    const cap = moneyCapFrom(settings());
    if (!isPaid(providerId) || cap === null || cap === Infinity) return null;
    const taskUsd = taskEstimateUsd(providerId, model, input?.appetiteTokens);
    return moneyHold(providerId, status().monthUsd, cap, taskUsd);
  }
  /**
   * Why a writer of this provider and model must wait now: the money cap of a paid lane. A spent subscription window is not asked here:
   * the chain walk holds each member on BB's live figure (src/rooms/usage, `usage.skip_percent`) with the window's own reset time. This
   * used to read the statusline's `last_usage.json` as well, a file nothing has written since the terminal status line was removed (2026-10-30).
   */
  async function holds(providerId: string, model: string, _hostId: string, input?: { appetiteTokens?: number }): Promise<string | null> {
    const taskUsd = taskEstimateUsd(providerId, model, input?.appetiteTokens);
    return moneyHold(providerId, status().monthUsd, moneyCapFrom(settings()), taskUsd);
  }
  /** A paid judge call (Jev) is not a lane: it holds on a cap the person set and spent, never on an unset one — every judgment of the pilot is such a call. */
  const judgeHolds = async (): Promise<string | null> => moneyHold("api", status().monthUsd, capOf(settings()["money.monthly_cap_usd"]));
  return { money: { status, holds, capHolds, judgeHolds } };
}
export type MoneyApi = ReturnType<typeof createMoney>["money"];
