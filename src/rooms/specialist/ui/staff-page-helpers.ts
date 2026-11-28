import type { z } from "zod";
import type { AutonomyClass } from "@lane-pilot/contracts";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import type {
  AgentListItem,
  LoadoutRole,
  SpecialistDetailOutput,
} from "../../contracts/ui";
import type { ScheduleBoardContract } from "../../schedule";

export type StaffScheduleItem = z.infer<ScheduleBoardContract["schedule_list"]["output"]>["schedules"][number];
import {
  AUTONOMY_LEVEL_LABELS,
  computeOnTrack,
  DEFAULT_DOMAIN_ROLE,
  domainOfAgent,
} from "./staff-list-parts";

export type StaffPageTab = "charter" | "shifts" | "autonomy" | "loadout" | "costs";

export const STAFF_PAGE_TABS: readonly StaffPageTab[] = [
  "charter",
  "shifts",
  "autonomy",
  "loadout",
  "costs",
];

export const STAFF_TAB_LABELS: Readonly<Record<StaffPageTab, I18nKey>> = {
  charter: "consoleStaffTabCharter",
  shifts: "consoleStaffTabShifts",
  autonomy: "consoleStaffTabAutonomy",
  loadout: "consoleStaffTabLoadout",
  costs: "consoleStaffTabCosts",
};


export function resolveStaffTab(view?: string): StaffPageTab {
  if (view && (STAFF_PAGE_TABS as readonly string[]).includes(view)) {
    return view as StaffPageTab;
  }
  return "charter";
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatEntryValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => formatEntryValue(v)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface CharterFieldItem {
  key: string;
  label: string;
  value: string;
}

export interface ExtractedCharterSummary {
  goal: string | null;
  metric: string | null;
  formula: string | null;
  dataSource: string | null;
  current: number | null;
  target: number | null;
  due: string | null;
  onTrack: boolean | null;
  constraints: CharterFieldItem[];
  budgets: CharterFieldItem[];
  channels: string[];
  emergencyNote: string | null;
  threadId: string | null;
}

function extractEntries(record: Record<string, unknown> | null): CharterFieldItem[] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([, val]) => val !== undefined && val !== null && val !== "")
    .map(([key, val]) => ({
      key,
      label: key.replace(/_/g, " "),
      value: formatEntryValue(val),
    }));
}

function extractChannels(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (item: unknown) => {
    const text = asText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  const pushCollection = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const entry of raw) add(entry);
    } else if (asRecord(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === true) add(k);
        else if (Array.isArray(v)) pushCollection(v);
        else if (typeof v === "string" && v.trim()) add(`${k}: ${v.trim()}`);
      }
    }
  };
  pushCollection(body.channels);
  const arsenal = asRecord(body.arsenal);
  if (arsenal) {
    pushCollection(arsenal.channels ?? arsenal.allowed_channels ?? arsenal);
  }
  return out;
}

/** Normalizes the heterogeneous `charter.body` JSON and `northStar` payload into display fields for the header and Charter tab. */
export function extractCharterSummary(
  detail: SpecialistDetailOutput | undefined,
  projectId: string,
  domain: string,
  nowMs = Date.now(),
): ExtractedCharterSummary {
  const charter = detail?.charter ?? null;
  const body = charter ? charter.body : {};
  const ns = asRecord(body.north_star) ?? asRecord(body.northStar) ?? {};

  const metric =
    detail?.northStar?.metric ??
    asText(body.metric) ??
    asText(ns.metric_id) ??
    asText(ns.metricId) ??
    asText(ns.metric) ??
    null;

  const goal =
    asText(body.goal) ??
    asText(ns.goal) ??
    asText(body.title) ??
    metric;

  const formula = asText(body.formula) ?? asText(ns.formula);
  const dataSource =
    asText(body.data_source) ??
    asText(body.dataSource) ??
    asText(body.source_of_truth) ??
    asText(ns.source_of_truth) ??
    asText(ns.sourceOfTruth) ??
    asText(ns.data_source) ??
    asText(ns.dataSource);

  const series = detail?.northStar?.series ?? [];
  const latestSeries = series.length > 0 ? series[series.length - 1]!.value : null;
  const current =
    asNum(body.current) ?? asNum(ns.current) ?? asNum(ns.value) ?? latestSeries;
  const target = asNum(body.target) ?? asNum(ns.target);
  const due =
    asText(body.due) ??
    asText(body.deadline) ??
    asText(ns.due) ??
    asText(ns.deadline) ??
    asText(ns.horizon_date) ??
    asText(ns.horizonDate);

  const onTrack = charter
    ? computeOnTrack(
        {
          projectId,
          domain,
          version: charter.version,
          approvedBy: charter.approvedBy,
          updatedAt: charter.approvedAt ?? nowMs - 86_400_000,
          metric,
          current,
          target,
          due,
          onTrack: typeof body.onTrack === "boolean" ? body.onTrack : undefined,
        },
        nowMs,
      )
    : null;

  const constraintsRaw = body.constraints ?? body.guardrails;
  const constraints: CharterFieldItem[] = Array.isArray(constraintsRaw)
    ? constraintsRaw.map((entry, idx) => ({
        key: `c_${idx}`,
        label: `#${idx + 1}`,
        value: formatEntryValue(entry),
      }))
    : extractEntries(asRecord(constraintsRaw));

  const budgets = extractEntries(asRecord(body.budgets));
  const channels = extractChannels(body);
  const emergencyRaw = body.emergency_actions ?? body.emergencyActions;
  const emergencyNote =
    typeof emergencyRaw === "string"
      ? asText(emergencyRaw)
      : Array.isArray(emergencyRaw) && emergencyRaw.length > 0
        ? emergencyRaw.map((x) => formatEntryValue(x)).join(", ")
        : null;

  const threadId =
    asText(body.latestThreadId) ?? asText(body.threadId) ?? asText(body.pmThreadId);

  return {
    goal,
    metric,
    formula,
    dataSource,
    current,
    target,
    due,
    onTrack,
    constraints,
    budgets,
    channels,
    emergencyNote,
    threadId,
  };
}

/** Matches schedules belonging to `(projectId, domain)` using the same heuristic as `sp-detail-shifts.ts`. */
export function scheduleMatchesDomain(schedule: StaffScheduleItem, domain: string): boolean {
  const dom = domain.trim().toLowerCase();
  if (!dom) return false;
  const { task } = schedule;
  if (task.kind === "workflow") {
    const inputsDomain = asText(task.inputs?.domain)?.toLowerCase();
    if (inputsDomain) return inputsDomain === dom;
    const wfId = task.workflowId.toLowerCase();
    if (schedule.name.toLowerCase().startsWith(`sp:${dom}:`)) return true;
    if (dom === "seo" && (wfId.startsWith("seo-") || wfId.startsWith("seo."))) return true;
    if (dom === "marketing" && (wfId.startsWith("mkt-") || wfId.startsWith("mkt."))) return true;
    if (wfId.startsWith(`${dom}-`) || wfId.startsWith(`${dom}.`)) return true;
    return schedule.description.toLowerCase().includes(`(${dom})`);
  }
  if (task.kind === "agent") {
    const agentId = task.agentId.toLowerCase();
    if (dom === "seo") return agentId === "seo-specialist";
    if (dom === "marketing") return agentId === "growth-marketer";
    return agentId === dom || agentId === `${dom}-specialist`;
  }
  return (
    schedule.name.toLowerCase().startsWith(`sp:${dom}:`) ||
    schedule.description.toLowerCase().includes(`(${dom})`)
  );
}

/** Selects the primary domain tick schedule for «Run shift now». */
export function pickTickSchedule(
  schedules: ReadonlyArray<StaffScheduleItem>,
  domain: string,
): StaffScheduleItem | null {
  if (schedules.length === 0) return null;
  const dom = domain.trim().toLowerCase();
  return (
    schedules.find(
      (s) =>
        s.name.toLowerCase().startsWith(`sp:${dom}:`) ||
        (s.task.kind === "workflow" && s.task.workflowId === "sp-specialist-tick"),
    ) ??
    schedules.find((s) => s.state === "active") ??
    schedules[0] ??
    null
  );
}

export function resolveStaffThreadId(
  charterThreadId: string | null,
  matchingSchedules: ReadonlyArray<StaffScheduleItem>,
): string | null {
  if (charterThreadId) return charterThreadId;
  for (const sched of matchingSchedules) {
    if (sched.lastRun?.threadId) return sched.lastRun.threadId;
  }
  return null;
}

export function resolveStaffRoleId(
  agents: ReadonlyArray<AgentListItem>,
  domain: string,
): string {
  const match = agents.find((agent) => domainOfAgent(agent) === domain);
  if (match) return match.id;
  return DEFAULT_DOMAIN_ROLE[domain] ?? domain;
}

export function pickLoadoutRole(
  roles: ReadonlyArray<LoadoutRole>,
  roleId: string,
  domain: string,
): LoadoutRole | null {
  return (
    roles.find((r) => r.role === roleId) ??
    roles.find((r) => r.role === domain) ??
    roles[0] ??
    null
  );
}

export function formatUsdAmount(value: number | null, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatShiftTime(ms: number | null | undefined, locale: Locale): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function shiftOutcomeTone(outcome: string): "ok" | "bad" | "accent" | "muted" {
  if (outcome === "succeeded" || outcome === "accepted") return "ok";
  if (outcome === "failed" || outcome === "timed_out") return "bad";
  if (outcome === "running" || outcome === "queued") return "accent";
  return "muted";
}

export function formatAutonomyLabel(level: AutonomyClass): string {
  return t(AUTONOMY_LEVEL_LABELS[level]);
}
