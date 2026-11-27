import type { LoopMode, LoopName } from "@lane-pilot/contracts";
import type { OwnerAction } from "../../owner-waiting";
import { localDayHour } from "./daily-report";

/**
 * Pure domain types, week-key math, option matching, and <=40-line Telegram formatting
 * for the M18 weekly owner review desk. Runtime-neutral: no node:, no SQLite, no BB SDK.
 */
export const DESK_SECTIONS = [
  "candidates",
  "drafts",
  "evolve",
  "employee",
  "deferred",
  "loop-health",
  "durability",
] as const;

export type DeskSection = (typeof DESK_SECTIONS)[number];

export type DeskItemAction =
  | { kind: "road"; roadId: string; roadClass: string | null; projectId: string | null; payload: Record<string, unknown> | null }
  | { kind: "draft"; draftId: string; workflowId: string; projectId: string; threadId: string | null }
  | { kind: "evolve"; hypothesisId: string; workflowId: string }
  | { kind: "autonomy"; projectId: string; domain: string; actionClass: string }
  | { kind: "shared_rule"; ruleId: string; domain: string }
  | { kind: "deferred"; ownerItemKey: string; actions: readonly OwnerAction[] }
  | { kind: "loop_health"; loop: LoopName; currentMode: LoopMode }
  | { kind: "noop" };

export type DeskItem = {
  id: string;
  section: DeskSection;
  title: string;
  default: string;
  options: string[];
  action: DeskItemAction;
};

export type DeskSectionView = {
  section: DeskSection;
  label: string;
  items: DeskItem[];
  failed: boolean;
  summaryLine?: string;
};

export type ComposeReviewDeskResult = {
  text: string;
  items: DeskItem[];
  week: string;
  failedSections: DeskSection[];
};

export const DESK_SECTION_LABELS: Record<DeskSection, string> = {
  candidates: "1. Path & branch candidates",
  drafts: "2. Drafts awaiting owner",
  evolve: "3. Evolve hypotheses",
  employee: "4. Employees, autonomy & shared rules",
  deferred: "5. Deferred decisions",
  "loop-health": "6. Loop health",
  durability: "7. Durability",
};

export const DESK_KEEP_OPTIONS: ReadonlySet<string> = new Set([
  "keep",
  "keep draft",
  "keep propose",
  "keep local",
]);

const DESK_MAX_LINES = 40;
const LINE_TITLE_MAX = 72;

/** Returns the ISO week key (`YYYY-Www`) for `now` in `timezone`. */
export function deskWeekKey(now: number, timezone: string): string {
  const { day } = localDayHour(now, timezone);
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export const reviewDeskOwnerItemKey = (week: string): string => `review-desk:${week}`;

function clipText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Normalizes user/CLI option aliases to the canonical option string for `item`, or `null` when invalid. */
export function normalizeDeskOption(item: DeskItem, rawOption: string): string | null {
  const norm = rawOption.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!norm) return null;

  for (const opt of item.options) {
    if (opt.toLowerCase().replace(/[_-]+/g, " ") === norm) return opt;
  }

  switch (item.action.kind) {
    case "road":
      if (norm === "save" || norm === "draft" || norm === "save draft") return "save as draft";
      break;
    case "draft":
      if (norm === "keep") return "keep draft";
      break;
    case "autonomy":
      if (norm === "grant" || norm === "bounded auto" || norm === "approve") return "grant bounded_auto";
      if (norm === "keep" || norm === "propose") return "keep propose";
      break;
    case "shared_rule":
      if (norm === "activate" || norm === "share" || norm === "approve") return "activate shared";
      if (norm === "keep" || norm === "local") return "keep local";
      break;
    case "loop_health":
      if (norm === "report" || norm === "report only" || norm === "switch") return "switch to report-only";
      if (norm === "off") return "turn off";
      break;
    case "deferred": {
      if (norm === "close") return "dismiss";
      const byLabel = item.action.actions.find(
        (a) => a.label.trim().toLowerCase().replace(/\s+/g, " ") === norm,
      );
      if (byLabel) return byLabel.id;
      break;
    }
    default:
      break;
  }
  return null;
}

/** Renders the compact <=40-line review desk summary for Telegram and CLI display. */
export function formatReviewDeskText(week: string, sections: readonly DeskSectionView[]): string {
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  const header = `Lane Pilot · Review Desk (${week}) · items: ${totalItems}`;
  const footer = "Answer in BB: bb lane-pilot desk show | desk answer <id> <option> | desk accept-defaults";
  const bodyBudget = DESK_MAX_LINES - 2;

  const lines: string[] = [header];
  const remainingSections = sections.length;

  for (let i = 0; i < remainingSections; i += 1) {
    if (lines.length >= DESK_MAX_LINES - 1) break;
    const sec = sections[i]!;
    const countLabel = sec.failed ? "unavailable" : String(sec.items.length);
    lines.push(`${sec.label} (${countLabel})`);
    if (lines.length >= DESK_MAX_LINES - 1) break;

    if (sec.failed) {
      lines.push("  section unavailable");
      continue;
    }
    if (sec.items.length === 0) {
      if (sec.summaryLine) lines.push(`  ${clipText(sec.summaryLine, LINE_TITLE_MAX)}`);
      continue;
    }

    const leftSections = remainingSections - i - 1;
    const minReserved = leftSections * 2;
    const availableForItems = Math.max(1, bodyBudget - (lines.length - 1) - minReserved);
    const maxShow = sec.items.length <= availableForItems
      ? sec.items.length
      : Math.max(1, availableForItems - 1);

    for (let j = 0; j < maxShow; j += 1) {
      const item = sec.items[j]!;
      lines.push(`  - [${item.id}] ${clipText(item.title, LINE_TITLE_MAX)} (default: ${item.default})`);
    }
    if (sec.items.length > maxShow && lines.length < DESK_MAX_LINES - 1) {
      lines.push(`  +${sec.items.length - maxShow} more`);
    }
  }

  lines.push(footer);
  return lines.slice(0, DESK_MAX_LINES).join("\n");
}
