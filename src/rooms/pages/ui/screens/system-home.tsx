import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type I18nKey } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { Icon, PageHeader, type BuiltinIconName } from "@lane-pilot/ui-kit";
import type { AgentLoadoutOutput, BrakeState, rpcContract } from "../../../contracts";
import type { ManualModeOutput } from "../../../contracts/ui";
import { SYSTEM_PAGES, type ConsoleRoute, type SystemPage } from "../../models/nav-model";

export interface SystemHomeProps {
  route: ConsoleRoute;
  go: (next: ConsoleRoute) => void;
  projectId: string | null;
  sectionId: string | null;
  explicitKeysCount?: number | null;
}

const TILE_TITLES: Record<SystemPage, I18nKey> = {
  automation: "consoleSysAutomation",
  graphs: "consoleSysGraphs",
  agents: "consoleSysAgents",
  schedules: "consoleSysSchedules",
  costs: "consoleSysCosts",
  health: "consoleSysHealth",
  settings: "consoleSysSettings",
};

const TILE_DESCS: Record<SystemPage, I18nKey> = {
  automation: "consoleSystemTileDesc_automation",
  graphs: "consoleSystemTileDesc_graphs",
  agents: "consoleSystemTileDesc_agents",
  schedules: "consoleSystemTileDesc_schedules",
  costs: "consoleSystemTileDesc_costs",
  health: "consoleSystemTileDesc_health",
  settings: "consoleSystemTileDesc_settings",
};

const TILE_ICONS: Record<SystemPage, BuiltinIconName> = {
  automation: "Workflow",
  graphs: "GitBranch",
  agents: "UserRoundPlus",
  schedules: "Clock",
  costs: "Zap",
  health: "CircleCheck",
  settings: "Code",
};

type SummaryState = Record<SystemPage, { text: string; warn?: boolean } | null>;

const EMPTY_SUMMARY: SummaryState = {
  automation: null,
  graphs: null,
  agents: null,
  schedules: null,
  costs: null,
  health: null,
  settings: null,
};

function formatUsd(value: number, locale: string): string {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** P9 System hub: six tiles linking to P10-P16, each with a single live status line. */
export function SystemHome({ route, go, projectId, sectionId, explicitKeysCount }: SystemHomeProps) {
  const rpc = useRpc<typeof rpcContract>() as unknown as {
    call: (method: string, input: unknown) => Promise<unknown>;
  };
  const locale = detectLocale();
  const [summary, setSummary] = useState<SummaryState>(EMPTY_SUMMARY);

  useEffect(() => {
    let alive = true;
    const scopedProject = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
    const scopeInput = scopedProject
      ? { projectId: scopedProject, ...(sectionId ? { sectionId } : {}) }
      : {};
    const screenTarget = {
      projectId: scopedProject ?? GLOBAL_SETTINGS_PROJECT_ID,
      ...(sectionId ? { sectionId } : {}),
    };

    const loadAll = async () => {
      const [manualMode, wfList, wfEvo, loadout, schedules, money, brakes, canary, waiting, screen] = await Promise.all([
        rpc.call("manual_mode_get", {}).catch(() => null) as Promise<ManualModeOutput | null>,
        rpc.call("workflow_list", scopedProject ? { projectId: scopedProject } : {}).catch(() => null) as Promise<{ workflows?: unknown[] } | null>,
        rpc.call("workflow_evolution_list", scopedProject ? { projectId: scopedProject } : {}).catch(() => null) as Promise<{ pendingApprovalCount?: number } | null>,
        rpc.call("agent_loadout", scopeInput).catch(() => null) as Promise<AgentLoadoutOutput | null>,
        rpc.call("schedule_list", scopedProject ? { projectId: scopedProject } : {}).catch(() => null) as Promise<{ schedules?: Array<{ state?: string }> } | null>,
        rpc.call("money_status", {}).catch(() => null) as Promise<{ monthUsd?: number; cap?: number | null } | null>,
        rpc.call("brakes_get", {}).catch(() => null) as Promise<{ brakes?: BrakeState[] } | null>,
        rpc.call("canary_status", {}).catch(() => null) as Promise<{ tripped?: boolean; green?: boolean } | null>,
        rpc.call("owner_waiting", {}).catch(() => null) as Promise<{ items?: Array<{ source?: string }>; counts?: Record<string, number> } | null>,
        explicitKeysCount === undefined || explicitKeysCount === null
          ? (rpc.call("get_screen", screenTarget).catch(() => null) as Promise<{ explicitKeys?: string[] } | null>)
          : Promise.resolve({ explicitKeys: Array.from({ length: explicitKeysCount }, (_, i) => String(i)) }),
      ]);
      if (!alive) return;

      const automationLine = manualMode
        ? (() => {
            const pausedCount = manualMode.brakes.filter((brake) => brake.paused).length;
            return {
              text: manualMode.on
                ? t("consoleSystemStatusAutomationManual")
                : t("consoleSystemStatusAutomationAuto").replace("{paused}", String(pausedCount)),
              warn: manualMode.on || pausedCount > 0,
            };
          })()
        : null;

      const graphsLine = wfList
        ? {
            text: t("consoleSystemStatusGraphs")
              .replace("{count}", String(wfList.workflows?.length ?? 0))
              .replace("{drafts}", String(wfEvo?.pendingApprovalCount ?? 0)),
            warn: (wfEvo?.pendingApprovalCount ?? 0) > 0,
          }
        : null;

      const agentsLine = loadout
        ? (() => {
            const total = loadout.roles.length;
            const missing = loadout.roles.filter((role) => role.items.some((item) => item.missing)).length;
            return {
              text: (missing > 0 ? t("consoleSystemStatusAgents") : t("consoleSystemStatusAgentsOk"))
                .replace("{total}", String(total))
                .replace("{missing}", String(missing)),
              warn: missing > 0,
            };
          })()
        : null;

      const schedulesLine = schedules
        ? (() => {
            const rows = schedules.schedules ?? [];
            const active = rows.filter((row) => row.state === "active").length;
            const paused = rows.filter((row) => row.state === "paused").length;
            return {
              text: t("consoleSystemStatusSchedules")
                .replace("{active}", String(active))
                .replace("{paused}", String(paused)),
              warn: paused > 0,
            };
          })()
        : null;

      const costsLine = money && typeof money.monthUsd === "number"
        ? {
            text:
              money.cap !== null && money.cap !== undefined
                ? t("consoleSystemStatusCostsCap")
                    .replace("{spend}", formatUsd(money.monthUsd, locale))
                    .replace("{cap}", formatUsd(money.cap, locale))
                : t("consoleSystemStatusCostsNoCap").replace("{spend}", formatUsd(money.monthUsd, locale)),
          }
        : null;

      const healthLine = (() => {
        if (!canary && !waiting && !brakes) return null;
        const gateIssues = (waiting?.items ?? []).filter((item) => item.source === "integration-gate").length;
        const outages =
          waiting?.items?.filter((item) => item.source === "outage").length ??
          waiting?.counts?.outage ??
          0;
        const pausedCount = (brakes?.brakes ?? []).filter((brake) => brake.paused).length;
        const gateAlert = Boolean(canary?.tripped) || canary?.green === false || gateIssues > 0;
        const gateLabel = t(gateAlert ? "consoleSystemGateAlert" : "consoleSystemGateOk");
        const template = pausedCount > 0 ? t("consoleSystemStatusHealthPaused") : t("consoleSystemStatusHealth");
        return {
          text: template
            .replace("{gate}", gateLabel)
            .replace("{outages}", String(outages))
            .replace("{paused}", String(pausedCount)),
          warn: gateAlert || outages > 0 || pausedCount > 0,
        };
      })();

      const settingsCount =
        explicitKeysCount !== undefined && explicitKeysCount !== null
          ? explicitKeysCount
          : screen?.explicitKeys?.length ?? null;
      const settingsLine =
        settingsCount !== null
          ? { text: t("consoleSystemStatusSettings").replace("{count}", String(settingsCount)) }
          : null;

      setSummary({
        automation: automationLine,
        graphs: graphsLine,
        agents: agentsLine,
        schedules: schedulesLine,
        costs: costsLine,
        health: healthLine,
        settings: settingsLine,
      });
    };

    void loadAll();
    return () => {
      alive = false;
    };
  }, [rpc, projectId, sectionId, explicitKeysCount, locale]);

  return (
    <div className="space-y-4" data-testid="console-system-hub">
      <PageHeader title={t("consoleNavSystem")} subtitle={t("consoleSystemLead")} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SYSTEM_PAGES.map((sysPage) => {
          const status = summary[sysPage];
          return (
            <button
              key={sysPage}
              type="button"
              data-testid={`system-tile-${sysPage}`}
              className="lp-card flex min-w-0 flex-col items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => go({ ...route, section: "system", page: sysPage })}
            >
              <div className="flex w-full min-w-0 items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--lp-well)] text-foreground">
                  <Icon name={TILE_ICONS[sysPage]} className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-sm font-medium text-foreground">{t(TILE_TITLES[sysPage])}</div>
                  <div
                    className={`truncate text-xs ${status?.warn ? "lp-text-warning" : "text-muted-foreground"}`}
                    data-testid={`system-tile-status-${sysPage}`}
                  >
                    {status ? status.text : t("consoleSystemStatusLoading")}
                  </div>
                </div>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{t(TILE_DESCS[sysPage])}</p>
              <span className="text-xs font-medium text-primary">{t("consoleSystemTileOpen")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
