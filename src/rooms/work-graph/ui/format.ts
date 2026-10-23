import { t, type I18nKey } from "@lane-pilot/i18n";

/** Numbers the way the owner reads them: «587,5 тыс», «2,5 млн», «9 ч 38 м», «$0.015». */
const ru = (locale: string) => locale.startsWith("ru");

export function tokens(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return "—";
  const one = (n: number) => n.toLocaleString(ru(locale) ? "ru-RU" : "en-US", { maximumFractionDigits: 1 });
  if (value < 1000) return String(value);
  if (value < 1_000_000) return ru(locale) ? `${one(value / 1000)} тыс` : `${one(value / 1000)}k`;
  return ru(locale) ? `${one(value / 1_000_000)} млн` : `${one(value / 1_000_000)}M`;
}

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return usd > 0 ? `$${usd.toPrecision(2)}` : "$0";
}

export function duration(seconds: number | null | undefined, locale: string): string {
  if (seconds === null || seconds === undefined) return "—";
  const r = ru(locale);
  if (seconds < 60) return r ? `${Math.round(seconds)} с` : `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return r ? `${minutes} м` : `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return r ? `${hours} ч ${rest} м` : `${hours}h ${rest}m`;
}

export const percent = (share: number | null | undefined) => (share === null || share === undefined ? "—" : `${Math.round(share * 1000) / 10}%`);
export const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
export const stageName = (id: string) => { const key = `stage_${id.replace(/-/g, "_")}` as I18nKey; const text = t(key); return text === key ? id : text; };
export const stageState = (state: string) => { const key = `stage_state_${state}` as I18nKey; const text = t(key); return text === key ? state : text; };
export const roleName = (role: string) => { const key = `graphRole_${role}` as I18nKey; const text = t(key); return text === key ? role : text; };
/** `router9/ag/gemini-3.8-flash-high` reads as `gemini-3.8-flash-high`; `claude-opus-5-5` as `opus-5-5`. */
export const shortModel = (model: string | null) => (model ? model.split("/").at(-1)!.replace(/^claude-/, "").replace(/\[.*\]$/, "") : "—");
