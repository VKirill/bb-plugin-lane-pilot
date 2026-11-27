import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  PageHeader,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  Switch,
} from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../../contracts";
import type { DocsProject, DocsProjectsOutput, ManualModeOutput } from "../../../contracts/ui";
import { BRAKE_LABEL_KEYS } from "../../../owner-waiting/ui";
import { useLpRpcQuery } from "../../../ui-shell/ui";

const AUTOMATION_POLL_MS = 30_000;

function formatDateTime(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return t("consoleAutomationActionFailed");
}

/** System -> Automation screen: manual mode switch (with confirm on turn-off), read-only brakes, and per-project docs switch. */
export function AutomationScreen({ locale: localeProp }: { locale?: Locale }) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const manualQuery = useLpRpcQuery<ManualModeOutput>("manual_mode_get", {}, { pollMs: AUTOMATION_POLL_MS });
  const docsQuery = useLpRpcQuery<DocsProjectsOutput>("docs_projects", {}, { pollMs: AUTOMATION_POLL_MS });

  const [manualOverride, setManualOverride] = useState<ManualModeOutput | null>(null);
  const [docsOverride, setDocsOverride] = useState<DocsProject[] | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [docsBusyId, setDocsBusyId] = useState<string | null>(null);
  const [confirmOffOpen, setConfirmOffOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setManualOverride(null);
  }, [manualQuery.data]);

  useEffect(() => {
    setDocsOverride(null);
  }, [docsQuery.data]);

  const manual = manualOverride ?? manualQuery.data;
  const docsProjects = docsOverride ?? docsQuery.data?.projects ?? null;

  const applyManualMode = async (on: boolean) => {
    setManualBusy(true);
    setActionError(null);
    try {
      const next = (await rpc.call("manual_mode_set", { on })) as ManualModeOutput;
      setManualOverride(next);
      await manualQuery.refetch().catch(() => undefined);
    } catch (cause) {
      const message = errorMessage(cause);
      setActionError(message);
      toast.error(t("consoleAutomationActionFailed"), { description: message });
      throw cause;
    } finally {
      setManualBusy(false);
    }
  };

  const handleManualToggle = (nextOn: boolean) => {
    if (manualBusy) return;
    if (!nextOn) {
      setActionError(null);
      setConfirmOffOpen(true);
      return;
    }
    void applyManualMode(true).catch(() => undefined);
  };

  const handleDocsToggle = async (projectId: string, on: boolean) => {
    if (docsBusyId !== null) return;
    setDocsBusyId(projectId);
    setActionError(null);
    try {
      const updated = (await rpc.call("docs_set", { projectId, on })) as DocsProject;
      setDocsOverride((prev) => {
        const list = prev ?? docsQuery.data?.projects ?? [];
        return list.map((item) =>
          item.projectId === updated.projectId
            ? { projectId: updated.projectId, name: updated.name, on: updated.on }
            : item,
        );
      });
      await docsQuery.refetch().catch(() => undefined);
    } catch (cause) {
      const message = errorMessage(cause);
      setActionError(message);
      toast.error(t("consoleAutomationActionFailed"), { description: message });
    } finally {
      setDocsBusyId(null);
    }
  };

  const brakes = manual?.brakes ?? [];

  return (
    <div className="space-y-5" data-testid="automation-screen">
      <PageHeader title={t("consoleSysAutomation")} subtitle={t("consoleAutomationSubtitle")} />

      {actionError ? (
        <Alert variant="destructive" data-testid="automation-error">
          <AlertTitle>{t("consoleAutomationActionFailed")}</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <Surface testId="automation-manual-card">
        <SurfaceHeader className="justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium">{t("consoleAutomationManualTitle")}</h2>
              {manual ? (
                <StatusPill tone={manual.on ? "warn" : "ok"} data-testid="automation-manual-pill">
                  {t(manual.on ? "consoleAutomationManualOn" : "consoleAutomationManualOff")}
                </StatusPill>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t("consoleAutomationManualDesc")}</p>
          </div>
          {manual ? (
            <Switch
              checked={manual.on}
              disabled={manualBusy}
              size="default"
              aria-label={t("consoleAutomationManualSwitchAria")}
              data-testid="automation-manual-switch"
              onCheckedChange={handleManualToggle}
            />
          ) : null}
        </SurfaceHeader>
        <SurfaceBody>
          {!manual && !manualQuery.error ? (
            <p className="text-xs text-muted-foreground" data-testid="automation-manual-loading">
              {t("consoleAutomationLoading")}
            </p>
          ) : manualQuery.error && !manual ? (
            <Alert variant="destructive" data-testid="automation-manual-load-error">
              <AlertTitle>{t("consoleAutomationLoadError")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{errorMessage(manualQuery.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void manualQuery.refetch()}>
                  {t("consoleAutomationRetry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : manual ? (
            <div className="space-y-4">
              {manual.since !== null || manual.reason ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="automation-manual-meta">
                  {manual.since !== null ? (
                    <span>{t("consoleAutomationManualMetaSince").replace("{time}", formatDateTime(manual.since, locale))}</span>
                  ) : null}
                  {manual.reason ? (
                    <span>{t("consoleAutomationManualMetaReason").replace("{reason}", manual.reason)}</span>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-2" data-testid="automation-brakes">
                <div>
                  <h3 className="text-xs font-medium text-foreground">{t("consoleAutomationBrakesTitle")}</h3>
                  <p className="text-xs text-muted-foreground">{t("consoleAutomationBrakesHint")}</p>
                </div>
                <div className="divide-y divide-[var(--lp-hairline)] rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)]">
                  {brakes.map((brake) => (
                    <div
                      key={brake.id}
                      className="flex items-center justify-between gap-4 px-4 py-2.5"
                      data-testid={`automation-brake-${brake.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{t(BRAKE_LABEL_KEYS[brake.id])}</div>
                        <div className="text-xs text-muted-foreground">
                          {t("consoleBrakesImpact").replace("{n}", String(brake.impact.count))}
                        </div>
                      </div>
                      <StatusPill tone={brake.paused ? "warn" : "ok"}>
                        {t(brake.paused ? "consoleAutomationBrakePaused" : "consoleAutomationBrakeActive")}
                      </StatusPill>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </SurfaceBody>
      </Surface>

      <Surface testId="automation-docs-card">
        <SurfaceHeader>
          <div className="space-y-0.5">
            <h2 className="text-sm font-medium">{t("consoleAutomationDocsTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("consoleAutomationDocsHint")}</p>
          </div>
        </SurfaceHeader>
        <SurfaceBody>
          {!docsProjects && !docsQuery.error ? (
            <p className="text-xs text-muted-foreground" data-testid="automation-docs-loading">
              {t("consoleAutomationLoading")}
            </p>
          ) : docsQuery.error && !docsProjects ? (
            <Alert variant="destructive" data-testid="automation-docs-load-error">
              <AlertTitle>{t("consoleAutomationLoadError")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{errorMessage(docsQuery.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void docsQuery.refetch()}>
                  {t("consoleAutomationRetry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : docsProjects && docsProjects.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="automation-docs-empty">
              {t("consoleAutomationDocsEmpty")}
            </p>
          ) : docsProjects ? (
            <div className="divide-y divide-[var(--lp-hairline)] rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)]" data-testid="automation-docs-list">
              {docsProjects.map((project) => (
                <div
                  key={project.projectId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                  data-testid={`automation-docs-row-${project.projectId}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {project.name}
                  </span>
                  <Switch
                    checked={project.on}
                    disabled={docsBusyId !== null}
                    size="default"
                    aria-label={t("consoleAutomationDocsSwitchAria").replace("{name}", project.name)}
                    data-testid={`automation-docs-switch-${project.projectId}`}
                    onCheckedChange={(nextOn) => void handleDocsToggle(project.projectId, nextOn)}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </SurfaceBody>
      </Surface>

      <ConfirmDialog
        open={confirmOffOpen}
        onOpenChange={setConfirmOffOpen}
        title={t("consoleAutomationConfirmOffTitle")}
        body={t("consoleAutomationConfirmOffBody")}
        confirmLabel={t("consoleAutomationConfirmOffAction")}
        cancelLabel={t("confirmCancel")}
        onConfirm={() => applyManualMode(false)}
      />
    </div>
  );
}
