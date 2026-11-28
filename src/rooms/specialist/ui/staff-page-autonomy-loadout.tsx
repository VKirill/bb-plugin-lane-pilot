import { useState } from "react";
import type { AutonomyClass } from "@lane-pilot/contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  ConfirmDialog,
  Segments,
  Skeleton,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  usePanelLayout,
} from "@lane-pilot/ui-kit";
import type {
  AgentLoadoutOutput,
  LoadoutRole,
  RepoTrustOutput,
  SpecialistAutonomyRow,
} from "../../contracts/ui";
import { autonomyLevelItems, errorText } from "./staff-list-parts";
import {
  formatAutonomyLabel,
  pickLoadoutRole,
} from "./staff-page-helpers";

const TRUST_LEVEL_KEYS: Readonly<Record<RepoTrustOutput["level"], I18nKey>> = {
  high: "consoleStaffTrustLevel_high",
  medium: "consoleStaffTrustLevel_medium",
  low: "consoleStaffTrustLevel_low",
  unknown: "consoleStaffTrustLevel_unknown",
};

const TRUST_LEVEL_TONE: Readonly<Record<RepoTrustOutput["level"], "ok" | "warn" | "bad" | "muted">> = {
  high: "ok",
  medium: "warn",
  low: "bad",
  unknown: "muted",
};

const GATE_STATE_KEYS: Readonly<Record<RepoTrustOutput["gate"]["state"], I18nKey>> = {
  passed: "consoleStaffGateState_passed",
  failed: "consoleStaffGateState_failed",
  running: "consoleStaffGateState_running",
  not_run: "consoleStaffGateState_not_run",
  none: "consoleStaffGateState_none",
};

const TRUST_MODE_KEYS: Readonly<Record<RepoTrustOutput["rules"][number]["mode"], I18nKey>> = {
  auto: "consoleStaffTrustMode_auto",
  ask: "consoleStaffTrustMode_ask",
  owner_only: "consoleStaffTrustMode_owner_only",
};

const LOADOUT_GROUP_ORDER: readonly LoadoutRole["items"][number]["type"][] = [
  "skill",
  "plugin",
  "mcp",
  "instructions",
  "tool",
];

const LOADOUT_GROUP_KEYS: Readonly<Record<LoadoutRole["items"][number]["type"], I18nKey>> = {
  skill: "consoleLoadoutColSkills",
  plugin: "consoleLoadoutColPlugins",
  mcp: "consoleLoadoutColMcp",
  instructions: "consoleLoadoutInstructions",
  tool: "consoleLoadoutTools",
};

/** Autonomy tab (P4): action classes × level control with ConfirmDialog + repo_trust block. */
export function StaffAutonomyTab({
  autonomy,
  repoTrust,
  repoTrustLoading,
  repoTrustError,
  onSetAutonomy,
}: {
  autonomy: ReadonlyArray<SpecialistAutonomyRow>;
  repoTrust: RepoTrustOutput | undefined;
  repoTrustLoading: boolean;
  repoTrustError: unknown;
  onSetAutonomy: (
    actionClass: string,
    level: AutonomyClass,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const { stackControls } = usePanelLayout();
  const [pendingChange, setPendingChange] = useState<{
    actionClass: string;
    from: AutonomyClass;
    to: AutonomyClass;
  } | null>(null);
  const [refused, setRefused] = useState<{ actionClass: string; reason: string } | null>(null);

  const levelItems = autonomyLevelItems();

  return (
    <div className="space-y-4" data-testid="staff-tab-autonomy">
      {refused ? (
        <Alert variant="destructive" data-testid="staff-autonomy-refused">
          <AlertTitle>{t("consoleStaffAutonomyRefusedTitle")}</AlertTitle>
          <AlertDescription>
            {refused.actionClass}: {refused.reason}
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-[13px] leading-[1.4] text-[var(--lp-body)]">{t("consoleStaffAutonomyLead")}</p>

      <Surface testId="staff-autonomy-table" className="overflow-hidden">
        {autonomy.length === 0 ? (
          <p className="p-4 text-xs text-[var(--lp-muted)]">{t("consoleStaffAutonomyEmpty")}</p>
        ) : (
          <>
            <div className="lp-autonomy-row lp-autonomy-head hidden bg-[var(--lp-bg)] sm:grid">
              <span>{t("consoleStaffAutonomyColAction")}</span>
              <span>{t("consoleStaffAutonomyColLevel")}</span>
              <span>{t("consoleStaffAutonomyColSample")}</span>
              <span>{t("consoleStaffAutonomyColConfidence")}</span>
            </div>
            {autonomy.map((row) => (
              <div
                key={row.actionClass}
                className="lp-autonomy-row border-t border-[var(--lp-line)]"
                data-testid={`staff-autonomy-row-${row.actionClass}`}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-[var(--lp-ink)]">
                  <span className="min-w-0 break-words">{row.actionClass}</span>
                  {row.frozen ? <StatusPill tone="warn">{t("consoleStaffAutonomyFrozen")}</StatusPill> : null}
                </span>
                <Segments
                  testId={`autonomy-level-${row.actionClass}`}
                  label={row.actionClass}
                  compact={stackControls}
                  size="sm"
                  value={row.level}
                  items={levelItems}
                  onChange={(next) => {
                    const target = next as AutonomyClass;
                    if (target === row.level) return;
                    setRefused(null);
                    setPendingChange({
                      actionClass: row.actionClass,
                      from: row.level,
                      to: target,
                    });
                  }}
                />
                <span className="text-[12.5px] tabular-nums text-[var(--lp-body)]">
                  {row.sample > 0 ? row.sample : "—"}
                </span>
                <span className="text-[12.5px] tabular-nums text-[var(--lp-body)]">
                  {row.confidence !== null ? `${Math.round(row.confidence * 100)}%` : "—"}
                </span>
              </div>
            ))}
          </>
        )}
      </Surface>

      <Surface testId="staff-repo-trust">
        <SurfaceHeader className="justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("consoleStaffRepoTrustTitle")}</h3>
          {repoTrust ? (
            <StatusPill tone={TRUST_LEVEL_TONE[repoTrust.level]}>
              <span data-testid="staff-repo-trust-level">{t(TRUST_LEVEL_KEYS[repoTrust.level])}</span>
            </StatusPill>
          ) : null}
        </SurfaceHeader>
        <SurfaceBody className="space-y-3">
          {repoTrustLoading && !repoTrust ? (
            <Skeleton className="h-16 w-full rounded-lg" />
          ) : repoTrustError ? (
            <p className="text-xs text-destructive-text" role="alert">
              {t("consoleStaffRepoTrustError")}: {errorText(repoTrustError)}
            </p>
          ) : repoTrust ? (
            <>
              <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4 [&_dd]:m-0">
                <div>
                  <dt className="text-muted-foreground">{t("consoleStaffRepoTrustGate")}</dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {t(GATE_STATE_KEYS[repoTrust.gate.state])}
                    {repoTrust.gate.reason ? ` · ${repoTrust.gate.reason}` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("consoleStaffRepoTrustTests")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                    {repoTrust.tests.lastCount !== null ? repoTrust.tests.lastCount : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("consoleStaffRepoTrustRollbacks")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                    {repoTrust.rollbacks30d}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("consoleStaffRepoTrustFirstTry")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                    {repoTrust.acceptedFirstTry30d !== null
                      ? `${Math.round(repoTrust.acceptedFirstTry30d * 100)}%`
                      : "—"}
                  </dd>
                </div>
              </dl>

              {repoTrust.rules.length > 0 ? (
                <div className="space-y-1.5 border-t border-[var(--lp-hairline)] pt-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("consoleStaffRepoTrustRules")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {repoTrust.rules.map((rule) => (
                      <Badge key={rule.actionClass} variant="outline" className="text-xs">
                        {rule.actionClass}: {t(TRUST_MODE_KEYS[rule.mode])}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </SurfaceBody>
      </Surface>

      <ConfirmDialog
        open={pendingChange !== null}
        title={t("consoleStaffAutonomyConfirmTitle")}
        body={
          pendingChange
            ? t("consoleStaffAutonomyConfirmBody")
                .replace("{action}", pendingChange.actionClass)
                .replace("{from}", formatAutonomyLabel(pendingChange.from))
                .replace("{to}", formatAutonomyLabel(pendingChange.to))
            : undefined
        }
        confirmLabel={t("consoleStaffAutonomyConfirmBtn")}
        cancelLabel={t("consoleHireCancelBtn")}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null);
        }}
        onConfirm={async () => {
          if (!pendingChange) return;
          const result = await onSetAutonomy(pendingChange.actionClass, pendingChange.to);
          if (!result.ok) {
            setRefused({ actionClass: pendingChange.actionClass, reason: result.reason });
          }
        }}
      />
    </div>
  );
}

/** Loadout tab (P4): model & level plus items grouped by type with source badges and «нет на хабе» when missing. */
export function StaffLoadoutTab({
  loadout,
  loading,
  error,
  roleId,
  domain,
}: {
  loadout: AgentLoadoutOutput | undefined;
  loading: boolean;
  error: unknown;
  roleId: string;
  domain: string;
}) {
  if (loading && !loadout) {
    return (
      <div className="space-y-3" data-testid="staff-loadout-loading" aria-busy="true">
        <Skeleton className="h-20 w-full rounded-[14px]" />
        <Skeleton className="h-40 w-full rounded-[14px]" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" data-testid="staff-loadout-error">
        <AlertTitle>{t("consoleLoadoutLoadError")}</AlertTitle>
        <AlertDescription>{errorText(error)}</AlertDescription>
      </Alert>
    );
  }

  const entry = loadout ? pickLoadoutRole(loadout.roles, roleId, domain) : null;
  if (!entry) {
    return (
      <Surface testId="staff-loadout-empty">
        <SurfaceBody>
          <p className="text-xs text-muted-foreground">{t("consoleStaffLoadoutEmpty")}</p>
        </SurfaceBody>
      </Surface>
    );
  }

  const missingCount = entry.items.filter((item) => item.missing).length;
  const modelText =
    entry.model.provider && entry.model.model
      ? `${entry.model.provider} · ${entry.model.model}`
      : entry.model.model ?? "—";

  return (
    <div className="space-y-4" data-testid="staff-tab-loadout">
      <Surface testId="staff-loadout-card">
        <SurfaceHeader className="justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("consoleStaffLoadoutTitle")}</h3>
          {entry.machine ? (
            <Badge variant="outline" className="text-[11px]">
              {t("consoleLoadoutMachine").replace("{machine}", entry.machine)}
            </Badge>
          ) : null}
        </SurfaceHeader>
        <SurfaceBody className="space-y-4">
          <div className="space-y-1.5">
            <div className="lp-caption">{t("consoleStaffLoadoutModelLabel")}</div>
            <div className="lp-tag gap-1.5 px-2 py-1">
              <span data-testid="staff-loadout-model">{modelText}</span>
              <span className="text-[10.5px] font-medium text-[var(--lp-muted)]" data-testid="staff-loadout-model-from">
                {t("consoleStaffLoadoutModelFrom").replace("{from}", entry.model.from)}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {LOADOUT_GROUP_ORDER.map((groupType) => {
              const items = entry.items.filter((item) => item.type === groupType);
              if (items.length === 0) return null;
              return (
                <div
                  key={groupType}
                  className="space-y-1.5"
                  data-testid={`staff-loadout-group-${groupType}`}
                >
                  <div className="lp-caption">
                    {t(LOADOUT_GROUP_KEYS[groupType])}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                      <div
                        key={`${item.type}:${item.name}`}
                        className="lp-tag max-w-full gap-1.5 px-2 py-1"
                        data-testid={`staff-loadout-item-${item.name}`}
                      >
                        <span className="min-w-0 break-all">{item.name}</span>
                        <span className="text-[10.5px] font-medium text-[var(--lp-muted)]">
                          {t("consoleLoadoutFromPrefix").replace("{from}", item.from)}
                        </span>
                        {item.missing ? (
                          <StatusPill tone="warn" className="text-[10px]">
                            <span data-testid={`staff-loadout-missing-${item.name}`}>
                              {t("consoleLoadoutMissingFlag")}
                            </span>
                          </StatusPill>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {entry.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("consoleStaffLoadoutGroupEmpty")}</p>
            ) : null}
          </div>

          {missingCount > 0 ? (
            <p
              className="rounded-lg bg-[var(--lp-warn-soft)] p-2.5 text-[11.5px] font-medium text-[var(--lp-warn)]"
              data-testid="staff-loadout-missing-banner"
            >
              {t("consoleLoadoutMissingBanner").replace("{n}", String(missingCount))}
            </p>
          ) : null}

          {entry.note ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
        </SurfaceBody>
      </Surface>
    </div>
  );
}
