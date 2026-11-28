import { AUTONOMY_CLASSES, type AutonomyClass } from "@lane-pilot/contracts";
import { canonicalRoleId, roleDisplayName, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Button, ProgressBar, Segments, StatusPill, Surface } from "@lane-pilot/ui-kit";
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
  autonomyRows: ReadonlyArray<{ actionClass: string; level: string }>;
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

export const AUTONOMY_LEVEL_LABELS: Readonly<Record<AutonomyClass, I18nKey>> = {
  observe: "consoleStaffAutonomyObserve",
  propose: "consoleStaffAutonomyPropose",
  bounded_auto: "consoleStaffAutonomyAuto",
};

/** Options of the «Наблюдает / Предлагает / Сам» control, in the autonomy ladder order. */
export function autonomyLevelItems(): Array<{ id: AutonomyClass; label: string }> {
  return AUTONOMY_CLASSES.map((level) => ({ id: level, label: t(AUTONOMY_LEVEL_LABELS[level]) }));
}

function formatGoalText(card: StaffCardItem): string {
  if (!card.metric) return t("consoleStaffNoGoal");
  return card.due ? `${card.metric} · ${t("consoleOverviewGoalsDue").replace("{due}", card.due)}` : card.metric;
}

/** Single employee summary card in the Staff list (P3): head, goal or scheduled assignment, budget figure, autonomy ladder. */
export function StaffCard({
  card,
  locale,
  onOpen,
  onOpenChat,
}: {
  card: StaffCardItem;
  locale: Locale;
  onOpen: (projectId: string, domain: string, view?: string) => void;
  onOpenChat: (threadId: string, title: string) => void;
}) {
  const budgetText =
    card.budgetUsedUsd !== null && card.budgetCapUsd !== null
      ? t("consoleStaffBudgetPair")
          .replace("{used}", formatUsd(card.budgetUsedUsd, locale))
          .replace("{cap}", formatUsd(card.budgetCapUsd, locale))
      : formatUsd(card.budgetUsedUsd, locale);
  const goalTone = card.onTrack === true ? "ok" : card.onTrack === false ? "warn" : "muted";
  const goalLabel =
    card.onTrack === true
      ? t("consoleOverviewGoalOnTrack")
      : card.onTrack === false
        ? t("consoleOverviewGoalBehind")
        : t("consoleStaffGoalPending");
  const pct =
    card.current !== null && card.target !== null && card.target > 0
      ? Math.max(0, Math.min(100, Math.round((card.current / card.target) * 100)))
      : null;
  const isGoalCard = card.category === "chartered";

  return (
    <Surface testId={`staff-card-${card.key}`} className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <span className="lp-avatar" aria-hidden>
          {card.roleName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[15.5px] font-semibold text-[var(--lp-ink)]"
            data-testid={`staff-card-role-${card.key}`}
          >
            {card.roleName}
          </h2>
          <p
            className="truncate text-xs text-[var(--lp-muted)]"
            data-testid={`staff-card-project-${card.key}`}
          >
            {card.projectName}
          </p>
        </div>
        {card.breakerOpen ? (
          <StatusPill tone="bad" dot className="shrink-0">
            <span data-testid={`staff-card-status-${card.key}`}>{t("consoleStaffBreakerOpen")}</span>
          </StatusPill>
        ) : !isGoalCard ? (
          <StatusPill tone="muted" dot className="shrink-0">
            <span data-testid={`staff-card-status-${card.key}`}>{t("consoleStaffFilterTask")}</span>
          </StatusPill>
        ) : null}
      </div>

      {isGoalCard ? (
        <div className="lp-inset space-y-2" data-testid={`staff-card-goal-${card.key}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="lp-caption">{t("consoleStaffGoalLabel")}</span>
            <StatusPill tone={goalTone}>
              {card.breakerOpen ? goalLabel : <span data-testid={`staff-card-status-${card.key}`}>{goalLabel}</span>}
            </StatusPill>
          </div>
          <p className="text-sm font-semibold leading-[1.4] text-[var(--lp-ink)]">{formatGoalText(card)}</p>
          {card.current !== null ? (
            <div className="flex items-end justify-between gap-2">
              <span className="text-[22px] font-semibold leading-none tabular-nums text-[var(--lp-ink)]">
                {card.current.toLocaleString(locale)}
              </span>
              {card.target !== null ? (
                <span className="text-xs font-medium text-[var(--lp-muted)]">
                  {t("consoleStaffGoalOf").replace("{target}", card.target.toLocaleString(locale))}
                </span>
              ) : null}
            </div>
          ) : null}
          {pct !== null ? <ProgressBar value={pct} tone={goalTone} label={goalLabel} /> : null}
        </div>
      ) : (
        <div className="lp-inset space-y-1.5" data-testid={`staff-card-goal-${card.key}`}>
          <span className="lp-caption">{t("consoleStaffRoutineCaption")}</span>
          <p className="text-sm font-semibold leading-[1.4] text-[var(--lp-ink)]">
            {card.summaryText ?? t("consoleStaffTaskBasedSummary")}
          </p>
        </div>
      )}

      {card.budgetUsedUsd !== null ? (
        <div className="space-y-0.5">
          <div className="text-[15px] font-semibold tabular-nums text-[var(--lp-ink)]" data-testid={`staff-card-budget-${card.key}`}>
            {budgetText}
          </div>
          <div className="text-[11.5px] text-[var(--lp-muted)]">{t("consoleStaffBudgetLabel")}</div>
        </div>
      ) : null}

      {card.autonomyRows.length > 0 && card.projectId ? (
        <div
          className="space-y-2 border-t border-[var(--lp-line)] pt-3"
          data-testid={`staff-card-autonomy-${card.key}`}
        >
          <span className="lp-caption">{t("consoleStaffAutonomyLabel")}</span>
          {card.autonomyRows.map((row) => (
            <div key={row.actionClass} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-[12.5px] text-[var(--lp-body)]">{row.actionClass}</span>
              <Segments
                testId={`card-${card.key}-${row.actionClass}`}
                label={row.actionClass}
                compact={false}
                size="sm"
                value={row.level}
                items={autonomyLevelItems()}
                onChange={() => onOpen(card.projectId!, card.domain, "autonomy")}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2">
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
    </Surface>
  );
}
