import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { detectLocale, t, type I18nKey } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ConfirmDialog,
  Input,
  StatusPill,
  Switch,
} from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { BrakeId, BrakeState, BrakesOutput, StopAllOutput } from "../../contracts/ui";
import { useLpRpcQuery } from "../../ui-shell/ui";

const BRAKES_POLL_MS = 30_000;
const STOP_ALL_CONFIRM_TEXT = "СТОП";
const MIN_REASON_LEN = 3;
const MAX_REASON_LEN = 300;

const BRAKE_LABEL_KEYS: Record<BrakeId, I18nKey> = {
  schedules: "consoleBrakesLabel_schedules",
  conveyor: "consoleBrakesLabel_conveyor",
  graphs: "consoleBrakesLabel_graphs",
  staff: "consoleBrakesLabel_staff",
};

function brakeLabel(id: BrakeId): string {
  return t(BRAKE_LABEL_KEYS[id]);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return t("consoleBrakesActionFailed");
}

function formatPausedFooter(brakes: ReadonlyArray<BrakeState>): string | null {
  const paused = brakes.filter((brake) => brake.paused);
  if (paused.length === 0) return null;
  const list = paused.map((brake) => brakeLabel(brake.id).toLowerCase()).join(", ");
  const earliest = paused
    .map((brake) => brake.since)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  if (earliest === undefined) {
    return t("consoleBrakesPausedSummary").replace("{list}", list);
  }
  const time = new Intl.DateTimeFormat(detectLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(earliest));
  return t("consoleBrakesPausedSince").replace("{list}", list).replace("{time}", time);
}

interface StopAllSummary {
  halted: string[];
  failed: string[];
}

export interface BrakesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data?: BrakesOutput;
  error?: unknown;
  onRefresh?: () => Promise<void> | void;
}

/** Global brakes dialog (D1): toggle individual brakes or halt all active work via confirmed `stop_all`. */
export function BrakesDialog({
  open,
  onOpenChange,
  data: dataProp,
  error: errorProp,
  onRefresh,
}: BrakesDialogProps) {
  const rpc = useRpc<typeof rpcContract>();
  const standalone = dataProp === undefined && errorProp === undefined && onRefresh === undefined;
  const internalQuery = useLpRpcQuery<BrakesOutput>("brakes_get", {}, {
    pollMs: BRAKES_POLL_MS,
    enabled: open && standalone,
  });

  const [overrideData, setOverrideData] = useState<BrakesOutput | null>(null);
  const [busyId, setBusyId] = useState<BrakeId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRelease, setPendingRelease] = useState<BrakeState | null>(null);
  const [stopAllConfirmOpen, setStopAllConfirmOpen] = useState(false);
  const [stopAllReason, setStopAllReason] = useState("");
  const [stopAllResult, setStopAllResult] = useState<StopAllSummary | null>(null);

  const sourceData = dataProp ?? internalQuery.data;
  const loadError = errorProp ?? internalQuery.error;
  const data = overrideData ?? sourceData;

  useEffect(() => {
    setOverrideData(null);
  }, [sourceData]);

  useEffect(() => {
    if (!open) {
      setPendingRelease(null);
      setStopAllConfirmOpen(false);
      setStopAllReason("");
      setActionError(null);
      setStopAllResult(null);
    }
  }, [open]);

  const refresh = async () => {
    try {
      await Promise.resolve(onRefresh ? onRefresh() : internalQuery.refetch());
    } catch {
      // Primary mutation result is already applied; background refresh failure is non-fatal.
    }
  };

  const applyBrake = async (id: BrakeId, paused: boolean) => {
    setBusyId(id);
    setActionError(null);
    try {
      const next = (await rpc.call("brakes_set", { id, paused })) as BrakesOutput;
      setOverrideData(next);
      await refresh();
    } catch (cause) {
      const message = errorMessage(cause);
      setActionError(message);
      toast.error(t("consoleBrakesActionFailed"), { description: message });
      throw cause;
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = (brake: BrakeState) => {
    if (busyId !== null) return;
    if (brake.paused) {
      setActionError(null);
      setPendingRelease(brake);
      return;
    }
    void applyBrake(brake.id, true).catch(() => undefined);
  };

  const handleStopAllConfirm = async () => {
    const trimmed = stopAllReason.trim();
    if (trimmed.length < MIN_REASON_LEN || trimmed.length > MAX_REASON_LEN) {
      throw new Error(t("consoleBrakesReasonInvalid"));
    }
    setActionError(null);
    const result = (await rpc.call("stop_all", { reason: trimmed })) as StopAllOutput;
    const halted = result.halted.filter((item) => item.ok).map((item) => item.runId);
    const failed = result.halted.filter((item) => !item.ok).map((item) => item.runId);
    console.info("[lane-pilot:brakes] stop_all", { halted, failed });
    setOverrideData({ brakes: result.brakes });
    setStopAllResult({ halted, failed });
    await refresh();
  };

  // Yield the main AlertDialog while a ConfirmDialog is active so Radix modal portals never contend for focus/aria-hidden.
  const confirmActive = pendingRelease !== null || stopAllConfirmOpen;
  const brakes = data?.brakes ?? [];
  const pausedSummary = formatPausedFooter(brakes);

  return (
    <>
      <AlertDialog
        open={open && !confirmActive}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && busyId === null) onOpenChange(false);
        }}
      >
        <AlertDialogContent data-testid="brakes-dialog" className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("consoleBrakesTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("consoleBrakesSubtitle")}</AlertDialogDescription>
          </AlertDialogHeader>

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground" data-testid="brakes-loading">
              {t("consoleBrakesLoading")}
            </p>
          ) : null}

          {loadError && !data ? (
            <Alert variant="destructive" data-testid="brakes-load-error">
              <AlertTitle>{t("consoleBrakesLoadError")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{errorMessage(loadError)}</p>
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  {t("consoleBrakesRetry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {actionError ? (
            <Alert variant="destructive" data-testid="brakes-error">
              <AlertTitle>{t("consoleBrakesActionFailed")}</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          {brakes.length > 0 ? (
            <div className="divide-y divide-[var(--lp-hairline)] rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)]" data-testid="brakes-list">
              {brakes.map((brake) => {
                const label = brakeLabel(brake.id);
                const impact = t("consoleBrakesImpact").replace("{n}", String(brake.impact.count));
                const unavailable = brake.reason === "unavailable" ? ` · ${t("consoleBrakesUnavailable")}` : "";
                return (
                  <div
                    key={brake.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                    data-testid={`brake-row-${brake.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">{label}</div>
                      <div className="text-xs text-muted-foreground" data-testid={`brake-impact-${brake.id}`}>
                        {impact}
                        {unavailable}
                      </div>
                    </div>
                    <Switch
                      checked={brake.paused}
                      disabled={busyId !== null}
                      size="default"
                      aria-label={t("consoleBrakesSwitchAria").replace("{label}", label)}
                      data-testid={`brake-switch-${brake.id}`}
                      onCheckedChange={() => handleToggle(brake)}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {stopAllResult !== null ? (
            <div
              className="space-y-2 rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)]/50 p-3 text-xs"
              data-testid="brakes-stop-all-result"
            >
              <div className="font-semibold text-foreground">{t("consoleBrakesResultTitle")}</div>
              {stopAllResult.halted.length === 0 && stopAllResult.failed.length === 0 ? (
                <p className="text-muted-foreground">{t("consoleBrakesResultNone")}</p>
              ) : (
                <>
                  {stopAllResult.halted.length > 0 ? (
                    <div data-testid="brakes-halted-list">
                      <span className="font-medium text-foreground">
                        {t("consoleBrakesResultHalted").replace("{n}", String(stopAllResult.halted.length))}
                      </span>{" "}
                      <span className="font-mono text-muted-foreground">{stopAllResult.halted.join(", ")}</span>
                    </div>
                  ) : null}
                  {stopAllResult.failed.length > 0 ? (
                    <div className="text-destructive" data-testid="brakes-failed-list">
                      <span className="font-medium">
                        {t("consoleBrakesResultFailed").replace("{n}", String(stopAllResult.failed.length))}
                      </span>{" "}
                      <span className="font-mono">{stopAllResult.failed.join(", ")}</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          <AlertDialogFooter className="items-center sm:justify-between">
            <div className="min-w-0 flex-1 text-left">
              {pausedSummary ? (
                <p className="text-xs font-medium text-destructive" data-testid="brakes-paused-summary">
                  {pausedSummary}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <AlertDialogCancel
                className="mt-0"
                disabled={busyId !== null}
                data-testid="brakes-close"
              >
                {t("consoleBrakesClose")}
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={busyId !== null}
                data-testid="brakes-stop-all"
                onClick={() => {
                  setActionError(null);
                  setStopAllReason("");
                  setStopAllConfirmOpen(true);
                }}
              >
                {t("consoleBrakesStopAll")}
              </Button>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDialog
        open={open && pendingRelease !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingRelease(null);
        }}
        title={pendingRelease ? t("consoleBrakesReleaseTitle").replace("{label}", brakeLabel(pendingRelease.id)) : ""}
        body={t("consoleBrakesReleaseBody")}
        confirmLabel={t("consoleBrakesReleaseConfirm")}
        cancelLabel={t("confirmCancel")}
        onConfirm={async () => {
          if (!pendingRelease) return;
          await applyBrake(pendingRelease.id, false);
        }}
      />

      <ConfirmDialog
        open={open && stopAllConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setStopAllConfirmOpen(false);
        }}
        title={t("consoleBrakesStopAllTitle")}
        confirmLabel={t("consoleBrakesStopAllConfirm")}
        cancelLabel={t("confirmCancel")}
        tone="danger"
        requireText={STOP_ALL_CONFIRM_TEXT}
        onConfirm={handleStopAllConfirm}
        body={
          <div className="space-y-3">
            <p>{t("consoleBrakesStopAllBody")}</p>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("consoleBrakesReasonLabel")}</span>
              <Input
                value={stopAllReason}
                onChange={(event) => setStopAllReason(event.target.value)}
                placeholder={t("consoleBrakesReasonPlaceholder")}
                minLength={MIN_REASON_LEN}
                maxLength={MAX_REASON_LEN}
                data-testid="brakes-stop-all-reason"
                autoFocus
              />
            </label>
          </div>
        }
      />
    </>
  );
}

/** Header button mounted in `ConsoleShell.headerExtras`: polls `brakes_get` every 30 s and opens `BrakesDialog`. */
export function BrakeButton() {
  const [open, setOpen] = useState(false);
  const query = useLpRpcQuery<BrakesOutput>("brakes_get", {}, { pollMs: BRAKES_POLL_MS });
  const pausedCount = (query.data?.brakes ?? []).filter((brake) => brake.paused).length;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        data-testid="brakes-button"
        onClick={() => setOpen(true)}
      >
        <span>{t("consoleBrakesButton")}</span>
        {pausedCount > 0 ? (
          <StatusPill tone="warn" className="lp-pill-warning px-1.5 py-0 text-[11px] leading-5">
            <span data-testid="brakes-paused-pill">
              {t("consoleBrakesPausedPill").replace("{n}", String(pausedCount))}
            </span>
          </StatusPill>
        ) : null}
      </Button>
      <BrakesDialog
        open={open}
        onOpenChange={setOpen}
        data={query.data}
        error={query.error}
        onRefresh={query.refetch}
      />
    </>
  );
}
