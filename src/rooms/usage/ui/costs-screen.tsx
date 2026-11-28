import { useMemo, type ComponentType } from "react";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import { KpiTile, PageHeader, Segments, Surface, SurfaceBody } from "@lane-pilot/ui-kit";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { TokenUsage } from "./token-usage";

const BAR_AREA_PX = 150;

type MoneyDay = { day: string; usd: number };
type MoneyPayload = {
  monthUsd: number;
  estimatedUsd?: number;
  cap: number | null;
  unlimited?: boolean;
  left: number | null;
  table?: MoneyDay[];
  series?: MoneyDay[];
};

export interface CostsScreenProps {
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  view?: string;
  compact?: boolean;
  locale?: Locale;
  onViewChange?: (next: "spend" | "quality") => void;
  WriterReuse: ComponentType<{ projectId: string }>;
  CriticValue: ComponentType<{ projectId: string }>;
  AcceptanceStats: ComponentType<{ projectId: string }>;
}

function formatUsd(value: number, locale: Locale): string {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** P14 Costs screen: monthly spend & cap (`money_status`), `TokenUsage`, and project-scoped Quality tab. */
export function CostsScreen({
  projectId,
  projects,
  view,
  compact = false,
  locale: localeProp,
  onViewChange,
  WriterReuse,
  CriticValue,
  AcceptanceStats,
}: CostsScreenProps) {
  const locale = localeProp ?? detectLocale();
  const activeView = view === "quality" ? "quality" : "spend";

  const moneyQuery = useLpRpcQuery<MoneyPayload>("money_status", {}, {
    pollMs: 30_000,
    enabled: activeView === "spend",
  });
  const money = moneyQuery.data ?? null;

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const scopeLabel = projectId ? (projectNames.get(projectId) ?? projectId) : t("consoleAllProjects");

  const dailyRows = money?.table ?? money?.series ?? [];
  const dailyMax = Math.max(0.01, ...dailyRows.map((row) => row.usd));
  const hasDailySpend = dailyRows.some((row) => row.usd > 0);
  const dailyCapThreshold =
    money && money.cap !== null && money.cap > 0 ? money.cap / 14 : null;

  const capLabel = !money
    ? "—"
    : money.cap !== null
      ? formatUsd(money.cap, locale)
      : money.unlimited
        ? t("consoleCostsUnlimited")
        : t("consoleCostsNoCap");

  const spendNote =
    [
      money?.cap !== null && money?.cap !== undefined ? t("consoleCostsOfCapNote").replace("{cap}", formatUsd(money.cap, locale)) : null,
      money?.estimatedUsd && money.estimatedUsd > 0
        ? t("consoleCostsEstimatedNote").replace("{amount}", formatUsd(money.estimatedUsd, locale))
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  const leftTone =
    money && money.left !== null
      ? money.left <= 0
        ? "bad"
        : "ok"
      : "muted";

  const spendTone =
    money && money.cap !== null && money.monthUsd >= money.cap
      ? "warn"
      : "accent";

  return (
    <div className="space-y-5" data-testid="costs-screen">
      <PageHeader
        title={t("consoleSysCosts")}
        subtitle={`${scopeLabel} · ${t("consoleCostsSubtitle")}`}
        actions={
          <Segments
            testId="costs-view"
            label={t("consoleSysCosts")}
            compact={compact}
            value={activeView}
            onChange={(next) => onViewChange?.(next === "quality" ? "quality" : "spend")}
            items={[
              { id: "spend", label: t("consoleCostsTabSpend") },
              { id: "quality", label: t("consoleCostsTabQuality") },
            ]}
          />
        }
      />

      {activeView === "quality" ? (
        !projectId ? (
          <Surface testId="costs-quality-select-project">
            <SurfaceBody>
              <p className="text-sm text-muted-foreground">{t("consoleCostsQualitySelectProject")}</p>
            </SurfaceBody>
          </Surface>
        ) : (
          <div className="space-y-6" data-testid="costs-quality">
            <WriterReuse projectId={projectId} />
            <CriticValue projectId={projectId} />
            <AcceptanceStats projectId={projectId} />
          </div>
        )
      ) : (
        <div className="space-y-5" data-testid="costs-spend">
          <section className="space-y-4" data-testid="costs-money-status">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiTile
                testId="costs-kpi-month-spend"
                label={t("consoleCostsMonthSpend")}
                value={money ? formatUsd(money.monthUsd, locale) : "—"}
                note={spendNote}
                tone={spendTone}
              />
              <KpiTile
                testId="costs-kpi-cap"
                label={t("consoleCostsCap")}
                value={capLabel}
                tone="muted"
              />
              <KpiTile
                testId="costs-kpi-left"
                label={t("consoleCostsLeft")}
                value={money && money.left !== null ? formatUsd(money.left, locale) : "—"}
                tone={leftTone}
              />
            </div>

            {dailyRows.length > 0 ? (
              <section className="lp-sys-chart" data-testid="costs-money-chart">
                <div className="lp-sys-chart-head">
                  <h2>{t("consoleCostsDailyChart")}</h2>
                  {!hasDailySpend ? (
                    <span className="text-xs text-muted-foreground">{t("consoleCostsDailyEmpty")}</span>
                  ) : null}
                </div>
                <div className="lp-sys-bars">
                  {dailyRows.map((day) => {
                    const heightPx = day.usd > 0
                      ? Math.max(6, Math.round((day.usd / dailyMax) * BAR_AREA_PX))
                      : 2;
                    const overPace = dailyCapThreshold !== null && day.usd > dailyCapThreshold;
                    return (
                      <div
                        key={day.day}
                        className="lp-sys-bar-slot"
                        title={`${day.day}: ${formatUsd(day.usd, locale)}`}
                        data-testid={`costs-money-bar-${day.day}`}
                      >
                        <div
                          className="lp-sys-bar"
                          data-tone={day.usd <= 0 ? "none" : overPace ? "warn" : "accent"}
                          style={{ height: `${heightPx}px` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>{dailyRows[0]?.day}</span>
                  <span>{dailyRows[dailyRows.length - 1]?.day}</span>
                </div>
              </section>
            ) : null}
          </section>

          <TokenUsage projects={projects} />
        </div>
      )}
    </div>
  );
}
