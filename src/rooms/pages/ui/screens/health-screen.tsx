import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  PageHeader,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../../contracts";
import type {
  DrillSummaryRow,
  DrillsListOutput,
  OutageRow,
  OutagesListOutput,
} from "../../../contracts/ui";
import { ServiceSegment } from "../service-segment";
import type { LpPage } from "../use-lp-page";

type CanaryStatusPayload = {
  version?: string;
  window?: { attempts?: number; maxAttempts?: number };
  faults?: number;
  rate?: number;
  tripped?: boolean;
  rollback?: string | null;
  green?: boolean;
  pool?: {
    works?: boolean;
    held?: string[];
    enabled?: number;
    blocked?: Array<{ key: string; projectIds: string[]; reason: string }>;
  };
};

function formatDateTime(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** P15 Health screen: read-only canary, outages, and recent drills above `ServiceSegment`. */
export function HealthScreen({ page, locale: localeProp }: { page: LpPage; locale?: Locale }) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const [canary, setCanary] = useState<CanaryStatusPayload | null>(null);
  const [canaryState, setCanaryState] = useState<"loading" | "ready" | "error">("loading");
  const [outages, setOutages] = useState<OutageRow[] | null>(null);
  const [outagesState, setOutagesState] = useState<"loading" | "ready" | "error">("loading");
  const [drills, setDrills] = useState<DrillSummaryRow[] | null>(null);
  const [drillsState, setDrillsState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    void rpc
      .call("canary_status", {})
      .then((res) => {
        if (!alive) return;
        setCanary((res ?? null) as CanaryStatusPayload | null);
        setCanaryState("ready");
      })
      .catch(() => {
        if (alive) setCanaryState("error");
      });

    void rpc
      .call("outages_list", { days: 7 })
      .then((res) => {
        if (!alive) return;
        setOutages((res as OutagesListOutput).outages ?? []);
        setOutagesState("ready");
      })
      .catch(() => {
        if (alive) setOutagesState("error");
      });

    void rpc
      .call("drills_list", { limit: 10 })
      .then((res) => {
        if (!alive) return;
        setDrills((res as DrillsListOutput).drills ?? []);
        setDrillsState("ready");
      })
      .catch(() => {
        if (alive) setDrillsState("error");
      });

    return () => {
      alive = false;
    };
  }, [rpc]);

  const canaryTone =
    canary?.tripped
      ? "bad"
      : canary?.green === false
        ? "warn"
        : "ok";
  const canaryLabel =
    canary?.tripped
      ? t("consoleHealthCanaryTripped")
      : canary?.green === false
        ? t("consoleHealthCanaryDegraded")
        : t("consoleHealthCanaryGreen");

  const blockedCount = canary?.pool?.blocked?.length ?? 0;
  const heldLanes = canary?.pool?.held ?? [];

  return (
    <div className="space-y-5" data-testid="service-panel">
      <PageHeader title={t("consoleSysHealth")} subtitle={t("consoleHealthSubtitle")} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="lp-sys-card" data-testid="health-canary">
          <div className="lp-sys-card-head">
            <h2>{t("consoleHealthCanaryTitle")}</h2>
            {canaryState === "ready" && canary ? (
              <StatusPill tone={canaryTone}>{canaryLabel}</StatusPill>
            ) : null}
          </div>
          <div className="space-y-1.5 text-xs">
            {canaryState === "loading" ? (
              <p className="text-muted-foreground">{t("consoleHealthLoading")}</p>
            ) : canaryState === "error" || !canary ? (
              <p className="text-muted-foreground">{t("consoleHealthUnavailable")}</p>
            ) : (
              <>
                {canary.version ? (
                  <p className="font-mono text-foreground">{`v${canary.version}`}</p>
                ) : null}
                {canary.window ? (
                  <p className="text-muted-foreground">
                    {t("consoleHealthCanaryWindow")
                      .replace("{attempts}", String(canary.window.attempts ?? 0))
                      .replace("{max}", String(canary.window.maxAttempts ?? 0))
                      .replace("{faults}", String(canary.faults ?? 0))
                      .replace("{rate}", String(Math.round((canary.rate ?? 0) * 100)))}
                  </p>
                ) : null}
                {canary.pool ? (
                  <p className="text-muted-foreground">
                    {t("consoleHealthCanaryPool")
                      .replace(
                        "{status}",
                        blockedCount > 0 || canary.pool.works === false
                          ? t("consoleHealthCanaryPoolBlocked").replace("{n}", String(blockedCount))
                          : t("consoleHealthCanaryPoolOk"),
                      )
                      .replace("{enabled}", String(canary.pool.enabled ?? 0))}
                  </p>
                ) : null}
                {heldLanes.length > 0 ? (
                  <p className="text-muted-foreground">
                    {t("consoleHealthCanaryHeld").replace("{list}", heldLanes.join(", "))}
                  </p>
                ) : null}
                {canary.tripped && canary.rollback ? (
                  <p className="font-mono text-destructive">
                    {t("consoleHealthCanaryRollback").replace("{cmd}", canary.rollback)}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </section>

        <section className="lp-sys-card" data-testid="health-outages">
          <div className="lp-sys-card-head">
            <h2>{t("consoleHealthOutagesTitle")}</h2>
          </div>
          <div>
            {outagesState === "loading" ? (
              <p className="text-xs text-muted-foreground">{t("consoleHealthLoading")}</p>
            ) : outagesState === "error" || !outages ? (
              <p className="text-xs text-muted-foreground">{t("consoleHealthUnavailable")}</p>
            ) : outages.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="health-outages-empty">
                {t("consoleHealthOutagesNone")}
              </p>
            ) : (
              <Table className="lp-sys-table" data-testid="health-outages-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("consoleHealthOutageWhen")}</TableHead>
                    <TableHead>{t("consoleHealthOutageDuration")}</TableHead>
                    <TableHead>{t("consoleHealthOutageCause")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outages.map((row) => (
                    <TableRow key={row.id} data-testid={`health-outage-${row.id}`}>
                      <TableCell className="tabular-nums">
                        {formatDateTime(row.fromAt, locale)}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {t("consoleHealthOutageMinutes").replace("{n}", String(row.minutes))}
                      </TableCell>
                      <TableCell className="whitespace-normal break-words">{row.cause ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </section>
      </div>

      <section className="lp-sys-card" data-testid="health-drills">
        <div className="lp-sys-card-head">
          <h2>{t("consoleHealthDrillsTitle")}</h2>
        </div>
        <div>
          {drillsState === "loading" ? (
            <p className="text-xs text-muted-foreground">{t("consoleHealthLoading")}</p>
          ) : drillsState === "error" || !drills ? (
            <p className="text-xs text-muted-foreground">{t("consoleHealthUnavailable")}</p>
          ) : drills.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="health-drills-empty">
              {t("consoleHealthDrillsEmpty")}
            </p>
          ) : (
            <Table className="lp-sys-table" data-testid="health-drills-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("consoleHealthDrillWhen")}</TableHead>
                  <TableHead>{t("consoleHealthDrillMode")}</TableHead>
                  <TableHead>{t("consoleHealthDrillResult")}</TableHead>
                  <TableHead>{t("consoleHealthDrillScenarios")}</TableHead>
                  <TableHead className="text-right">{t("consoleHealthDrillDuration")}</TableHead>
                  <TableHead>{t("consoleHealthDrillDetails")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drills.map((drill) => {
                  const passed = drill.result === "pass";
                  return (
                    <TableRow key={drill.file} data-testid={`health-drill-${drill.file}`}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {drill.stamp ?? drill.date ?? drill.file}
                      </TableCell>
                      <TableCell>{drill.mode ?? "—"}</TableCell>
                      <TableCell>
                        <StatusPill tone={passed ? "ok" : "bad"}>
                          {passed ? t("consoleHealthDrillPass") : t("consoleHealthDrillFail")}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {`${drill.passedCount}/${drill.totalCount}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {drill.durationSec !== null ? `${drill.durationSec}s` : "—"}
                      </TableCell>
                      <TableCell className="max-w-[18rem] truncate">
                        {drill.problems[0] ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <ServiceSegment page={page} />
    </div>
  );
}
