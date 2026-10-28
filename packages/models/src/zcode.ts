import { findProvider, type ModelCatalog } from "./model-catalog";

/**
 * ZCode (the owner's ZCode desktop app on the Mac mini, BB provider `zcode`, plugin bb-plugin-zcode) as a model Lane Pilot may use.
 * It works only under conditions the other providers do not have, so ONE function answers «can it take work now?» for every caller (the
 * writer pick, the writer chain, the helpers' resolver):
 *  - host: only on a machine whose provider list has `zcode` (the Mac mini); an unknown catalog counts as «no», it is not a guess;
 *  - window: GLM-5.3-Flash through ZCode is free from 15:00 to 01:00 UTC (the promo; 712k input tokens did not move the plan quota) and bills
 *    the owner's Z.ai plan outside it, so by default (`zcode.window` = `promo`) it is offered in that window only; `always` lifts the limit;
 *  - busy: all of ZCode's parallel slots (3) are taken by Lane Pilot tasks, so another is not sent until one ends.
 */
export const ZCODE_PROVIDER_ID = "zcode";
export const ZCODE_WINDOW_KEY = "zcode.window";
export const ZCODE_WINDOWS = ["promo", "always"] as const;
export type ZcodeWindow = (typeof ZCODE_WINDOWS)[number];
/** The free hours, UTC: from 15:00 to 01:00 of the next day. */
export const ZCODE_PROMO_FROM_HOUR = 15;
export const ZCODE_PROMO_TO_HOUR = 1;

export const isZcodeProvider = (providerId: string | null | undefined): boolean => providerId === ZCODE_PROVIDER_ID;

/** The window mode of the settings; anything but `always` is the default, `promo`. */
export const zcodeWindowMode = (settings: Record<string, unknown>): ZcodeWindow => (settings[ZCODE_WINDOW_KEY] === "always" ? "always" : "promo");

/** Why a stored `zcode.window` is not valid, or null (empty is valid: the default). */
export function zcodeWindowProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && (ZCODE_WINDOWS as readonly string[]).includes(value) ? null : `one of ${ZCODE_WINDOWS.join(", ")}`;
}

export function inZcodePromo(at: number): boolean {
  const hour = new Date(at).getUTCHours();
  return hour >= ZCODE_PROMO_FROM_HOUR || hour < ZCODE_PROMO_TO_HOUR;
}

/** The next moment the promo window opens (ISO), after `at`. */
export function nextZcodePromoStart(at: number): string {
  const date = new Date(at);
  date.setUTCHours(ZCODE_PROMO_FROM_HOUR, 0, 0, 0);
  if (date.getTime() <= at) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export type ZcodeBlock = { code: "host" | "window" | "busy"; detail: string; resetsAt: string | null };

/** Why ZCode is not offered at this hour (outside its free hours with the default window), or null. */
export function zcodeWindowBlock(settings: Record<string, unknown>, now: number): ZcodeBlock | null {
  if (zcodeWindowMode(settings) === "promo" && !inZcodePromo(now)) {
    return { code: "window", detail: `ZCode is free only 15:00-01:00 UTC (set ${ZCODE_WINDOW_KEY}=always to use it at other hours)`, resetsAt: nextZcodePromoStart(now) };
  }
  return null;
}

/** Why ZCode cannot take work on this machine now, or null when it can. */
export function zcodeBlock(input: { settings: Record<string, unknown>; catalog: ModelCatalog | null | undefined; hostId: string | null | undefined; now: number; busy: boolean }): ZcodeBlock | null {
  const onHost = Boolean(input.catalog && input.hostId && findProvider(input.catalog, ZCODE_PROVIDER_ID)?.hostIds.includes(input.hostId));
  if (!onHost) return { code: "host", detail: "ZCode is not on this machine (only the Mac mini has it)", resetsAt: null };
  const closed = zcodeWindowBlock(input.settings, input.now);
  if (closed) return closed;
  if (input.busy) return { code: "busy", detail: "ZCode's parallel slots are all taken", resetsAt: null };
  return null;
}

/**
 * The bridge's own words for «the ZCode app cannot take this now»: another task holds it, its text is not visible, it needs the foreground, its
 * sign-in expired. They are the machine's state, not the model's work: the task runs again at once on another model, uncharged. Null otherwise.
 * Only the bridge's own forms count (`ZCode (code): …`, `ZCode is busy …`, the sign-in hint), so a word in a check's output never matches.
 */
const ZCODE_ENVIRONMENT = /ZCode is busy|ZCode \((?:text-not-visible|foreground_required|session_expired|promo_unavailable)\)|sign in inside the ZCode app/i;

/** The model of ZCode Lane Pilot runs: GLM-5.3-Flash on the Start Plan's free tokens (bb-plugin-zcode refuses it with `promo_unavailable` rather than bill the plan). */
export const ZCODE_FREE_MODEL = "glm-5.3-flash-free";
/**
 * Background rows that try ZCode first in its free hours (the owner's ask of 2026-10-28: spend the free tokens on background work), unless the
 * owner picked a model for the row: cheap text jobs with a checker or a reader behind them. Outside the hours, off the Mac mini, with every
 * slot taken or the free tokens gone, the row's own model runs. `zcode.background` = false turns it off.
 */
export const ZCODE_FREE_ROWS: readonly string[] = ["docs-maintainer", "rules-analyzer", "memory", "project-life"];
export const ZCODE_BACKGROUND_KEY = "zcode.background";
export const zcodeBackgroundOn = (settings: Record<string, unknown>): boolean => settings[ZCODE_BACKGROUND_KEY] !== false && settings[ZCODE_BACKGROUND_KEY] !== "off";
export function zcodeEnvironmentError(text: string | null | undefined): string | null {
  const match = ZCODE_ENVIRONMENT.exec(text ?? "");
  return match ? (text ?? "").slice(match.index).replace(/\s+/g, " ").trim().slice(0, 200) : null;
}
