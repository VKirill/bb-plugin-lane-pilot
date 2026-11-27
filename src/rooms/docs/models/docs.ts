import { DOCS_ENABLED_KEY } from "../settings";
import { DOCS_DEFAULT_SELECTION } from "./docs-defaults";

export const DOCS_SINCE_CHOICES = ["yesterday", "24 hours ago", "7 days ago"] as const;
export type DocsSince = (typeof DOCS_SINCE_CHOICES)[number];

export { DOCS_DEFAULT_SELECTION };

export type DocsMaintenanceSettings = {
  /** Off by default; on when the owner picked "true" or "auto" (in "auto" the folder's worthiness verdict decides per place). */
  enabled: boolean;
  /** "off" (the default), "on" always, or "auto" where a folder is worth it. */
  mode: "auto" | "on" | "off";
  maintain: boolean;
  since: DocsSince;
  pageCap: number;
  hour: number;
};

export function parseDocsSettings(raw: Record<string, unknown>): DocsMaintenanceSettings {
  const rawEnabled = raw[DOCS_ENABLED_KEY];
  const mode = rawEnabled == null || rawEnabled === "" ? "off" : rawEnabled === "auto" ? "auto" : parseBoolean(rawEnabled, false, DOCS_ENABLED_KEY) ? "on" : "off";
  const enabled = mode !== "off";
  const maintain = parseBoolean(raw["docs.maintain"], true, "docs.maintain");
  const sinceValue = raw["docs.since"] ?? "yesterday";
  if (!(DOCS_SINCE_CHOICES as readonly unknown[]).includes(sinceValue)) throw new Error("docs.since must be yesterday, 24 hours ago, or 7 days ago");
  const pageCap = parseInteger(raw["docs.page_cap"], 0, 0, Number.MAX_SAFE_INTEGER, "docs.page_cap");
  const hour = parseInteger(raw["docs.hour"], 5, 0, 23, "docs.hour");
  return { enabled, mode, maintain, since: sinceValue as DocsSince, pageCap, hour };
}

function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === 0 || value === "0" || value === "false" || value === "off" || value === "no") return false;
  throw new Error(`${name} must be boolean`);
}

function parseInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
