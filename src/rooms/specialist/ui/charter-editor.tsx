import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  CONTROL_H,
  Input,
  Label,
  Surface,
  SurfaceBody,
  SurfaceHeader,
} from "@lane-pilot/ui-kit";
import { toast } from "sonner";
import type { SpecialistDetailOutput } from "../../contracts/ui";
import type { ScheduleBoardContract } from "../../schedule";
import {
  buildCharterPayload,
  computeCharterDiff,
  parseCharterForm,
  parseOptionalNonNegativeNumber,
  type CharterEditorForm,
} from "./charter-editor-model";
import { errorText } from "./staff-list-parts";

export interface CharterEditorProps {
  projectId: string;
  domain: string;
  charter: SpecialistDetailOutput["charter"];
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
}

/** Charter editor (P4a): edits charter fields, proposes drafts, diffs pending drafts, and approves via ConfirmDialog. */
export function CharterEditor({
  projectId,
  domain,
  charter,
  onClose,
  onRefresh,
}: CharterEditorProps) {
  const rpc = useRpc<ScheduleBoardContract>();
  const currentBody = charter?.body ?? {};
  const pendingDraft = charter?.pendingDraft ?? null;

  const initialForm = useMemo(
    () =>
      parseCharterForm(pendingDraft ? pendingDraft.body : currentBody),
    // Re-seed only when the underlying version or pending draft id changes so user edits aren't clobbered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [charter?.version, pendingDraft?.draftId],
  );

  const [form, setForm] = useState<CharterEditorForm>(initialForm);
  const [proposeBusy, setProposeBusy] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialForm);
  }, [initialForm]);

  const diffRows = useMemo(
    () => (pendingDraft ? computeCharterDiff(currentBody, pendingDraft.body) : []),
    [currentBody, pendingDraft],
  );

  const targetInvalid = parseOptionalNonNegativeNumber(form.target) === "invalid";
  const budgetDayInvalid = parseOptionalNonNegativeNumber(form.budgetDay) === "invalid";
  const budgetMonthInvalid = parseOptionalNonNegativeNumber(form.budgetMonth) === "invalid";
  const budgetTestInvalid = parseOptionalNonNegativeNumber(form.budgetTest) === "invalid";
  const hasValidationError = targetInvalid || budgetDayInvalid || budgetMonthInvalid || budgetTestInvalid;

  const handleAddConstraint = () => {
    setForm((prev) => ({
      ...prev,
      constraints: [
        ...prev.constraints,
        { id: `c_new_${Date.now()}_${prev.constraints.length}`, key: "", value: "" },
      ],
    }));
  };

  const handleUpdateConstraint = (index: number, patch: { key?: string; value?: string }) => {
    setForm((prev) => ({
      ...prev,
      constraints: prev.constraints.map((item, idx) =>
        idx === index ? { ...item, ...patch } : item,
      ),
    }));
  };

  const handleRemoveConstraint = (index: number) => {
    setForm((prev) => ({
      ...prev,
      constraints: prev.constraints.filter((_, idx) => idx !== index),
    }));
  };

  const handleSaveDraft = async () => {
    if (proposeBusy || hasValidationError) return;
    setErrorBanner(null);
    setProposeBusy(true);
    try {
      const payload = buildCharterPayload(currentBody, form);
      const res = await rpc.call("charter_propose", {
        projectId,
        domain,
        charter: payload,
      });
      console.info("[lane-pilot:staff] charter draft proposed", {
        projectId,
        domain,
        draftId: res.draftId,
      });
      toast.success(t("consoleStaffCharterEditDraftSaved"));
      await Promise.resolve(onRefresh());
    } catch (cause) {
      const message = errorText(cause);
      console.warn("[lane-pilot:staff] charter_propose failed", { projectId, domain, message });
      setErrorBanner(message);
    } finally {
      setProposeBusy(false);
    }
  };

  const handleApproveConfirm = async () => {
    if (!pendingDraft) return;
    setErrorBanner(null);
    const res = await rpc.call("charter_approve", {
      projectId,
      domain,
      draftId: pendingDraft.draftId,
    });
    if (!res.ok) {
      if (res.reason === "draft_not_found") {
        console.warn("[lane-pilot:staff] charter_approve draft_not_found", {
          projectId,
          domain,
          draftId: pendingDraft.draftId,
        });
        await Promise.resolve(onRefresh());
        setErrorBanner(t("consoleStaffCharterDraftNotFound"));
        return;
      }
      console.warn("[lane-pilot:staff] charter_approve refused", {
        projectId,
        domain,
        reason: res.reason,
      });
      setErrorBanner(res.reason);
      return;
    }

    console.info("[lane-pilot:staff] charter approved", {
      projectId,
      domain,
      version: res.version,
    });
    toast.success(t("consoleStaffCharterApproveOk").replace("{v}", String(res.version)));
    await Promise.resolve(onRefresh());
    onClose();
  };

  return (
    <div className="space-y-4" data-testid="charter-editor">
      {errorBanner ? (
        <Alert variant="destructive" data-testid="charter-editor-error">
          <AlertTitle>{t("consoleStaffActionError")}</AlertTitle>
          <AlertDescription>{errorBanner}</AlertDescription>
        </Alert>
      ) : null}

      <div className={pendingDraft ? "grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "space-y-4"}>
        <Surface testId="charter-editor-form">
          <SurfaceHeader className="justify-between gap-2">
            <h3 className="text-sm font-semibold">{t("consoleStaffCharterEditTitle")}</h3>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="charter-edit-back"
              onClick={onClose}
            >
              {t("consoleStaffCharterEditBack")}
            </Button>
          </SurfaceHeader>
          <SurfaceBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="charter-edit-metric" className="text-xs font-medium">
                  {t("consoleStaffCharterMetric")}
                </Label>
                <Input
                  id="charter-edit-metric"
                  className={`${CONTROL_H} w-full`}
                  data-testid="charter-edit-metric"
                  value={form.metric}
                  onChange={(e) => setForm((p) => ({ ...p, metric: e.target.value }))}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="charter-edit-source" className="text-xs font-medium">
                  {t("consoleStaffCharterDataSource")}
                </Label>
                <Input
                  id="charter-edit-source"
                  className={`${CONTROL_H} w-full`}
                  data-testid="charter-edit-source"
                  value={form.source}
                  onChange={(e) => setForm((p) => ({ ...p, source: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="charter-edit-formula" className="text-xs font-medium">
                {t("consoleStaffCharterFormula")}
              </Label>
              <Input
                id="charter-edit-formula"
                className={`${CONTROL_H} w-full font-mono text-xs`}
                data-testid="charter-edit-formula"
                value={form.formula}
                onChange={(e) => setForm((p) => ({ ...p, formula: e.target.value }))}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="charter-edit-target" className="text-xs font-medium">
                  {t("consoleStaffCharterEditTarget")}
                </Label>
                <Input
                  id="charter-edit-target"
                  type="number"
                  min="0"
                  step="any"
                  className={`${CONTROL_H} w-full tabular-nums`}
                  data-testid="charter-edit-target"
                  value={form.target}
                  onChange={(e) => setForm((p) => ({ ...p, target: e.target.value }))}
                />
                {targetInvalid ? (
                  <p className="text-xs text-destructive-text">{t("consoleStaffCharterEditInvalidNum")}</p>
                ) : null}
              </div>

              <div className="space-y-1">
                <Label htmlFor="charter-edit-due" className="text-xs font-medium">
                  {t("consoleStaffCharterDue")}
                </Label>
                <Input
                  id="charter-edit-due"
                  className={`${CONTROL_H} w-full`}
                  data-testid="charter-edit-due"
                  placeholder="2027-03-01"
                  value={form.due}
                  onChange={(e) => setForm((p) => ({ ...p, due: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2 border-t border-[var(--lp-hairline)] pt-3">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs font-medium">{t("consoleStaffCharterConstraints")}</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="charter-edit-constraint-add"
                  onClick={handleAddConstraint}
                >
                  {t("consoleStaffCharterEditAddConstraint")}
                </Button>
              </div>
              {form.constraints.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("consoleStaffCharterConstraintsEmpty")}</p>
              ) : (
                <div className="space-y-2" data-testid="charter-edit-constraints-list">
                  {form.constraints.map((item, idx) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-2">
                      <Input
                        className={`${CONTROL_H} w-40 flex-1`}
                        data-testid={`charter-edit-constraint-key-${idx}`}
                        placeholder={t("consoleStaffCharterEditConstraintKey")}
                        aria-label={t("consoleStaffCharterEditConstraintKey")}
                        value={item.key}
                        onChange={(e) => handleUpdateConstraint(idx, { key: e.target.value })}
                      />
                      <Input
                        className={`${CONTROL_H} w-48 flex-1`}
                        data-testid={`charter-edit-constraint-val-${idx}`}
                        placeholder={t("consoleStaffCharterEditConstraintValue")}
                        aria-label={t("consoleStaffCharterEditConstraintValue")}
                        value={item.value}
                        onChange={(e) => handleUpdateConstraint(idx, { value: e.target.value })}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        data-testid={`charter-edit-constraint-remove-${idx}`}
                        onClick={() => handleRemoveConstraint(idx)}
                      >
                        {t("consoleStaffCharterEditRemoveConstraint")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-[var(--lp-hairline)] pt-3">
              <div className="text-xs font-medium text-foreground">{t("consoleStaffCharterBudgets")}</div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="charter-edit-budget-day" className="text-xs text-muted-foreground">
                    {t("consoleStaffCharterEditBudgetDay")}
                  </Label>
                  <Input
                    id="charter-edit-budget-day"
                    type="number"
                    min="0"
                    step="any"
                    className={`${CONTROL_H} w-full tabular-nums`}
                    data-testid="charter-edit-budget-day"
                    value={form.budgetDay}
                    onChange={(e) => setForm((p) => ({ ...p, budgetDay: e.target.value }))}
                  />
                  {budgetDayInvalid ? (
                    <p className="text-xs text-destructive-text">{t("consoleStaffCharterEditInvalidNum")}</p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="charter-edit-budget-month" className="text-xs text-muted-foreground">
                    {t("consoleStaffCharterEditBudgetMonth")}
                  </Label>
                  <Input
                    id="charter-edit-budget-month"
                    type="number"
                    min="0"
                    step="any"
                    className={`${CONTROL_H} w-full tabular-nums`}
                    data-testid="charter-edit-budget-month"
                    value={form.budgetMonth}
                    onChange={(e) => setForm((p) => ({ ...p, budgetMonth: e.target.value }))}
                  />
                  {budgetMonthInvalid ? (
                    <p className="text-xs text-destructive-text">{t("consoleStaffCharterEditInvalidNum")}</p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="charter-edit-budget-test" className="text-xs text-muted-foreground">
                    {t("consoleStaffCharterEditBudgetTest")}
                  </Label>
                  <Input
                    id="charter-edit-budget-test"
                    type="number"
                    min="0"
                    step="any"
                    className={`${CONTROL_H} w-full tabular-nums`}
                    data-testid="charter-edit-budget-test"
                    value={form.budgetTest}
                    onChange={(e) => setForm((p) => ({ ...p, budgetTest: e.target.value }))}
                  />
                  {budgetTestInvalid ? (
                    <p className="text-xs text-destructive-text">{t("consoleStaffCharterEditInvalidNum")}</p>
                  ) : null}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground" data-testid="charter-budget-no-auto-hint">
                {t("consoleStaffCharterEditBudgetNoAuto")}
              </p>
            </div>

            <div className="space-y-1 border-t border-[var(--lp-hairline)] pt-3">
              <Label htmlFor="charter-edit-channels" className="text-xs font-medium">
                {t("consoleStaffCharterEditChannels")}
              </Label>
              <Input
                id="charter-edit-channels"
                className={`${CONTROL_H} w-full`}
                data-testid="charter-edit-channels"
                value={form.channels}
                onChange={(e) => setForm((p) => ({ ...p, channels: e.target.value }))}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                disabled={proposeBusy || hasValidationError}
                data-testid="charter-save-draft-btn"
                onClick={() => void handleSaveDraft()}
              >
                {proposeBusy
                  ? t("consoleStaffCharterEditSavingDraft")
                  : t("consoleStaffCharterEditSaveDraft")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={proposeBusy}
                onClick={onClose}
              >
                {t("consoleHireCancelBtn")}
              </Button>
            </div>
          </SurfaceBody>
        </Surface>

        {pendingDraft ? (
          <Surface testId="charter-editor-diff" className="h-fit">
            <SurfaceHeader className="justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {t("consoleStaffCharterDiffTitle").replace("{id}", pendingDraft.draftId)}
              </h3>
              <Badge variant="secondary" className="text-[11px]">
                {pendingDraft.draftId}
              </Badge>
            </SurfaceHeader>
            <SurfaceBody className="space-y-4">
              {diffRows.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="charter-diff-empty">
                  {t("consoleStaffCharterDiffNone")}
                </p>
              ) : (
                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-[var(--lp-hairline)] pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <span>{t("consoleStaffCharterDiffColField")}</span>
                    <span>{t("consoleStaffCharterDiffColOld")}</span>
                    <span>{t("consoleStaffCharterDiffColNew")}</span>
                  </div>
                  {diffRows.map((row) => (
                    <div
                      key={row.fieldKey}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 rounded-lg bg-[var(--lp-well)]/50 p-2"
                      data-testid={`charter-diff-row-${row.fieldKey}`}
                    >
                      <span className="font-medium text-foreground">{row.label}</span>
                      <span
                        className="break-words text-muted-foreground line-through"
                        data-testid={`charter-diff-old-${row.fieldKey}`}
                      >
                        {row.oldValue}
                      </span>
                      <span
                        className="break-words font-medium text-foreground"
                        data-testid={`charter-diff-new-${row.fieldKey}`}
                      >
                        {row.newValue}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <Button
                type="button"
                size="sm"
                data-testid="charter-approve-btn"
                onClick={() => setApproveOpen(true)}
              >
                {t("consoleStaffCharterApproveBtn")}
              </Button>
            </SurfaceBody>
          </Surface>
        ) : null}
      </div>

      <ConfirmDialog
        open={approveOpen}
        title={t("consoleStaffCharterApproveTitle")}
        body={t("consoleStaffCharterApproveBody")}
        confirmLabel={t("consoleStaffCharterApproveConfirm")}
        cancelLabel={t("consoleHireCancelBtn")}
        onOpenChange={setApproveOpen}
        onConfirm={handleApproveConfirm}
      />
    </div>
  );
}
