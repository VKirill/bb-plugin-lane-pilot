import { canonicalRoleId, roleDisplayName, t, type Locale } from "@lane-pilot/i18n";
import { Button, StatusPill, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { AgentListItem } from "../../contracts/ui";

export type StaffFilter = "all" | "chartered" | "task";

export interface OverviewCharterRow {
  projectId: string;
  domain: string;
  version: number;
  approvedBy: string | null;
  updatedAt: number;
  metric: string | null;
  current: number | null;
  target: number | null;
  due: string | null;
  onTrack?: boolean | null;
  budgetUsedUsd?: number | null;
  budgetCapUsd?: number | null;
  monthlyCapUsd?: number | null;
  dailyCapUsd?: number | null;
  autonomySummary?: string | null;
  autonomy?: ReadonlyArray<{ actionClass?: string; level: string }>;
  latestThreadId?: string | null;
  threadId?: string | null;
}

export interface OverviewPayload {
  charters?: OverviewCharterRow[];
  breakers?: Array<{ domain: string; state: string }>;
  spend24hUsd?: number;
  spend30dUsd?: number;
  autonomy?: Record<string, ReadonlyArray<{ actionClass?: string; level: string }>>;
  latestThreadIdByDomain?: Record<string, string | null>;
}

export interface StaffCardItem {
  key: string;
  category: "chartered" | "task";
  roleId: string;
  roleName: string;
  projectId: string | null;
  projectName: string;
  domain: string;
  metric: string | null;
  current: number | null;
  target: number | null;
  due: string | null;
  onTrack: boolean | null;
  breakerOpen: boolean;
  budgetUsedUsd: number | null;
  budgetCapUsd: number | null;
  autonomySummary: string;
  threadId: string | null;
  summaryText: string | null;
}

export const CHARTERED_DOMAINS = new Set(["marketing", "seo", "specialist_os"]);
export const DEFAULT_DOMAIN_ROLE: Readonly<Record<string, string>> = {
  marketing: "growth-marketer",
  seo: "seo-specialist",
};
export const UNLISTED_DEVELOPER_IDS = new Set([
  "animator",
  "doc-classifier",
  "eval-auditor",
  "eval-planner",
  "framework-selector",
  "nyquist-auditor",
  "ui-researcher",
]);

export function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return t("consoleStaffLoadError");
}

function elapsedShare(due: string, startMs: number, nowMs: number): number | null {
  const dueMs = Date.parse(due);
  if (!Number.isFinite(dueMs)) return null;
  if (nowMs >= dueMs) return 1;
  if (!Number.isFinite(startMs) || startMs >= dueMs) return 0;
  if (nowMs <= startMs) return 0;
  return Math.max(0, Math.min(1, (nowMs - startMs) / (dueMs - startMs)));
}

export function computeOnTrack(charter: OverviewCharterRow, nowMs: number): boolean | null {
  if (typeof charter.onTrack === "boolean") return charter.onTrack;
  if (
    typeof charter.current === "number" &&
    Number.isFinite(charter.current) &&
    typeof charter.target === "number" &&
    Number.isFinite(charter.target) &&
    charter.target > 0 &&
    charter.due
  ) {
    const share = elapsedShare(charter.due, charter.updatedAt, nowMs);
    if (share !== null) return charter.current / charter.target >= share;
  }
  return null;
}

function formatUsd(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatAutonomySummary(
  rows?: ReadonlyArray<{ level: string }> | null,
  rawSummary?: string | null,
): string {
  if (typeof rawSummary === "string" && rawSummary.trim()) return rawSummary.trim();
  if (!rows || rows.length === 0) return t("consoleStaffAutonomyDefault");
  let observe = 0;
  let propose = 0;
  let auto = 0;
  for (const row of rows) {
    if (row.level === "observe") observe += 1;
    else if (row.level === "bounded_auto") auto += 1;
    else propose += 1;
  }
  const parts: string[] = [];
  if (observe > 0) parts.push(`${t("consoleStaffAutonomyObserve")} ${observe}`);
  if (propose > 0) parts.push(`${t("consoleStaffAutonomyPropose")} ${propose}`);
  if (auto > 0) parts.push(`${t("consoleStaffAutonomyAuto")} ${auto}`);
  return parts.length > 0 ? parts.join(" · ") : t("consoleStaffAutonomyDefault");
}

export function domainOfAgent(agent: AgentListItem): string {
  if (agent.domain && agent.domain.trim()) return agent.domain.trim();
  if (agent.id === "growth-marketer") return "marketing";
  if (agent.id === "seo-specialist") return "seo";
  if (agent.id === "copy-lead") return "copy";
  return agent.id;
}

export function resolveRoleName(agent: AgentListItem | undefined, fallbackId: string, locale: Locale): string {
  if (agent) {
    if (!agent.custom && canonicalRoleId(agent.id)) {
      return roleDisplayName(agent.id, locale);
    }
    return agent.displayName || agent.description || agent.id;
  }
  return canonicalRoleId(fallbackId) ? roleDisplayName(fallbackId, locale) : fallbackId;
}

function formatGoalLine(card: StaffCardItem, locale: Locale): string {
  if (card.category === "task") {
    return card.summaryText ?? t("consoleStaffTaskBasedSummary");
  }
  if (!card.metric) return t("consoleStaffNoGoal");
  const progress =
    card.current !== null && card.target !== null
      ? `${card.metric}: ${card.current.toLocaleString(locale)} / ${card.target.toLocaleString(locale)}`
      : card.target !== null
        ? `${card.metric}: — / ${card.target.toLocaleString(locale)}`
        : card.metric;
  if (!card.due) return progress;
  return `${progress} · ${t("consoleOverviewGoalsDue").replace("{due}", card.due)}`;
}

/** Single employee summary card in the Staff list (P3). */
export function StaffCard({
  card,
  locale,
  onOpen,
  onOpenChat,
}: {
  card: StaffCardItem;
  locale: Locale;
  onOpen: (projectId: string, domain: string) => void;
  onOpenChat: (threadId: string, title: string) => void;
}) {
  const budgetText =
    card.budgetUsedUsd !== null && card.budgetCapUsd !== null
      ? t("consoleStaffBudgetPair")
          .replace("{used}", formatUsd(card.budgetUsedUsd, locale))
          .replace("{cap}", formatUsd(card.budgetCapUsd, locale))
      : formatUsd(card.budgetUsedUsd, locale);
  const statusTone = card.breakerOpen
    ? "bad"
    : card.category === "task"
      ? "muted"
      : card.onTrack === true
        ? "ok"
        : card.onTrack === false
          ? "warn"
          : "muted";
  const statusLabel = card.breakerOpen
    ? t("consoleStaffBreakerOpen")
    : card.category === "task"
      ? t("consoleStaffFilterTask")
      : card.onTrack === true
        ? t("consoleOverviewGoalOnTrack")
        : card.onTrack === false
          ? t("consoleOverviewGoalBehind")
          : t("consoleStaffGoalPending");
  const pct =
    card.current !== null && card.target !== null && card.target > 0
      ? Math.max(0, Math.min(100, Math.round((card.current / card.target) * 100)))
      : null;

  return (
    <Surface testId={`staff-card-${card.key}`} className="flex flex-col">
      <SurfaceHeader className="justify-between gap-2">
        <div className="min-w-0">
          <h2
            className="min-w-0 truncate text-sm font-semibold text-foreground"
            data-testid={`staff-card-role-${card.key}`}
          >
            {card.roleName}
          </h2>
          <p
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid={`staff-card-project-${card.key}`}
          >
            {card.projectName}
          </p>
        </div>
        <StatusPill tone={statusTone} className="shrink-0">
          <span data-testid={`staff-card-status-${card.key}`}>{statusLabel}</span>
        </StatusPill>
      </SurfaceHeader>

      <SurfaceBody className="flex flex-1 flex-col justify-between gap-3">
        <div className="space-y-3">
          <div className="rounded-lg bg-[var(--lp-well)]/60 p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {card.category === "chartered"
                ? t("consoleStaffGoalLabel")
                : t("consoleStaffFilterTask")}
            </div>
            <p
              className="mt-1 text-xs font-medium text-foreground"
              data-testid={`staff-card-goal-${card.key}`}
            >
              {formatGoalLine(card, locale)}
            </p>
            {pct !== null ? (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--lp-well)]">
                <div
                  className={`h-full rounded-full ${card.onTrack === false ? "bg-[var(--lp-warning)]" : "bg-[var(--lp-success)]"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">{t("consoleStaffBudgetLabel")}</dt>
              <dd
                className="mt-0.5 font-medium tabular-nums text-foreground"
                data-testid={`staff-card-budget-${card.key}`}
              >
                {budgetText}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("consoleStaffAutonomyLabel")}</dt>
              <dd
                className="mt-0.5 font-medium text-foreground"
                data-testid={`staff-card-autonomy-${card.key}`}
              >
                {card.autonomySummary}
              </dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--lp-hairline)] pt-3">
          {card.projectId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={`staff-open-${card.key}`}
              onClick={() => onOpen(card.projectId!, card.domain)}
            >
              {t("consoleStaffOpen")}
            </Button>
          ) : null}
          {card.threadId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`staff-chat-${card.key}`}
              onClick={() => onOpenChat(card.threadId!, card.roleName)}
            >
              {t("consoleStaffOpenChat")}
            </Button>
          ) : null}
        </div>
      </SurfaceBody>
    </Surface>
  );
}
