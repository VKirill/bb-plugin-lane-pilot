import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, ConfirmDialog, Disclosure, Input, Switch } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { useLpRpcQuery } from "../../ui-shell/ui";
import type { OwnerAction, OwnerItem, OwnerWaiting } from "../models/owner-item";
import {
  OwnerItemCard,
  confirmTitleFor,
  foldLabel,
  isClosingAction,
  isTaskWordNo,
  kindLabel,
  ownerChipClass,
  resolveDeferTarget,
  shortRef,
} from "./owner-waiting-card";

/**
 * «Waiting for you» (SMA D0-3): the one screen of what only the owner can decide. It is read by a person who does not program (the owner,
 * 2026-11-01), so a card is four plain answers: what happened, why it is his, what to do (a button when the plugin has the RPC, else one
 * plain instruction), and «Details» folded under it with the technical part: when it appeared, the key, where to look, the commands.
 */
type Config = { enabled: boolean; quiet: string; timezone: string };
const POLL_MS = 30_000;
/** The sources in the order they are read, each named in words; a source not listed is shown under its own name. */
const SECTIONS: Array<{ source: string; title: I18nKey; folded?: boolean }> = [
  { source: "deferral_overdue", title: "ow_section_deferral_overdue" }, { source: "lead", title: "ow_section_lead" }, { source: "phase", title: "ow_section_phase" },
  { source: "writer", title: "ow_section_writer" }, { source: "workflow", title: "ow_section_workflow" }, { source: "schedule", title: "ow_section_schedule" },
  { source: "night", title: "ow_section_night" }, { source: "wall", title: "ow_section_wall" }, { source: "backlog", title: "ow_section_backlog" },
  { source: "integration-gate", title: "ow_section_gate" }, { source: "outage", title: "ow_section_outage" },
  { source: "memory_conflict", title: "ow_section_memory_conflict" },
  { source: "deferral_term", title: "ow_section_deferral_term", folded: true },
];
const STATE_KEYS: Record<string, I18nKey> = { blocked: "ow_state_blocked", failed: "ow_state_failed", provider_error: "ow_state_provider_error", validation_failed: "ow_state_validation_failed" };
/** An attempt's state is a code (`validation_failed`): the known ones are said in words, the rest without the underscores. */
const stateLabel = (state: string) => (STATE_KEYS[state] ? t(STATE_KEYS[state]!) : state.replace(/_/g, " "));
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const FOLD_OVER = 8;

/** Notification & quiet-hours settings block (kept exported for System → Settings migration in Task 34). */
export function PushSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { void rpc.call("owner_waiting_config", {}).then((value) => setConfig(value as Config)).catch(() => undefined); }, [rpc]);
  if (!config) return null;
  const save = async (patch: Record<string, string>) => {
    try { setConfig(await rpc.call("owner_waiting_config", { patch }) as Config); toast.success(t("ow_push_saved")); }
    catch (cause) { toast.error(t("ow_action_failed"), { description: cause instanceof Error ? cause.message : String(cause) }); }
  };
  return (
    <section className="space-y-2 rounded-lg border border-border p-3.5" data-testid="owner-push">
      <div><h3 className="text-sm font-semibold">{t("ow_push")}</h3><p className="text-xs text-muted-foreground">{t("ow_push_help")}</p></div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={config.enabled} onCheckedChange={(on) => void save({ enabled: on ? "on" : "off" })} data-testid="owner-push-enabled" />{t("ow_push_on")}</label>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground basis-40">{t("ow_push_quiet")}
          <Input className="h-8" defaultValue={config.quiet} data-testid="owner-push-quiet" onBlur={(event) => { if (event.target.value !== config.quiet) void save({ quiet: event.target.value }); }} />
        </label>
        <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground basis-40">{t("ow_push_zone")}
          <Input className="h-8" defaultValue={config.timezone} data-testid="owner-push-zone" onBlur={(event) => { if (event.target.value !== config.timezone) void save({ timezone: event.target.value }); }} />
        </label>
      </div>
    </section>
  );
}

export interface OwnerWaitingBoardProps {
  projects: Array<{ id: string; name: string }>;
  projectId?: string | null;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
  onOpenSettings?: () => void;
}

export function OwnerWaitingBoard({ projects, projectId = null, onOpenTask, onOpenWork, onOpenSettings }: OwnerWaitingBoardProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [pendingConfirm, setPendingConfirm] = useState<{ item: OwnerItem; action: OwnerAction } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const query = useLpRpcQuery("owner_waiting", {}, { pollMs: POLL_MS });
  const waiting = (query.data ?? null) as OwnerWaiting | null;
  const failed = query.error != null;
  const load = useCallback(async () => { await query.refetch(); }, [query.refetch]);

  const clearCardError = (key: string) => setCardErrors((prev) => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });

  const executeRpcAction = async (item: OwnerItem, method: string, input: Record<string, unknown>, successText = t("ow_done")) => {
    setBusy(item.key);
    clearCardError(item.key);
    try {
      const result = await (rpc.call as (m: string, i: unknown) => Promise<unknown>)(method, input) as { ok?: unknown; reason?: unknown } | null;
      // Transport success is not business success: `lead_decide` / `task_word` answer {ok:false, reason} for a branch already settled elsewhere.
      if (result && typeof result === "object" && result.ok === false) {
        const message = typeof result.reason === "string" && result.reason ? result.reason : t("ow_action_refused");
        setCardErrors((prev) => ({ ...prev, [item.key]: message }));
        toast.error(t("ow_action_refused"), { description: typeof result.reason === "string" ? result.reason : undefined });
        throw new Error(message);
      }
      toast.success(successText);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCardErrors((prev) => ({ ...prev, [item.key]: message }));
      console.warn("[lane-pilot:owner-waiting] action failed", { key: item.key, method, message });
      toast.error(t("ow_action_failed"), { description: message });
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  const handleAction = (item: OwnerItem, action: OwnerAction) => {
    if (!action.rpc) return;
    if (isClosingAction(action)) {
      setRejectReason("");
      setPendingConfirm({ item, action });
      return;
    }
    void executeRpcAction(item, action.rpc.method, action.rpc.input).catch(() => undefined);
  };

  const handleConfirm = async () => {
    if (!pendingConfirm) return;
    const { item, action } = pendingConfirm;
    if (!action.rpc) return;
    let input = action.rpc.input;
    if (isTaskWordNo(action)) {
      const trimmed = rejectReason.trim();
      if (!trimmed) throw new Error(t("consoleDecisionsRejectReasonRequired"));
      input = { ...input, decision: "no", text: trimmed };
    }
    await executeRpcAction(item, action.rpc.method, input);
  };

  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? id : null);
  const allItems = waiting?.items ?? [];
  const items = useMemo(
    () => (projectId ? allItems.filter((item) => item.projectId === projectId) : allItems),
    [allItems, projectId],
  );
  // «now» is the five rows worth his attention (items.ts NOW_CAP); the rest wait folded. A row without a tier (an older server) is «now».
  const tierOf = (item: OwnerItem) => (item as { tier?: "now" | "later" }).tier ?? "now";
  const nowItems = items.filter((item) => tierOf(item) === "now"), laterItems = items.filter((item) => tierOf(item) === "later");
  const known = new Set(SECTIONS.map((section) => section.source));
  const sectionsOf = (rows: OwnerItem[]) => [...SECTIONS, ...[...new Set(rows.filter((item) => !known.has(item.source)).map((item) => item.source))].map((source) => ({ source, title: null as I18nKey | null, folded: false }))];
  const renderSections = (all: OwnerItem[], folding: boolean) => sectionsOf(all).map((section) => {
    const rows = all.filter((item) => item.source === section.source);
    if (!rows.length) return null;
    const title = section.title ? t(section.title) : section.source;
    const list = (
      <ul className="space-y-3.5" data-testid={`owner-list-${section.source}`}>
        {rows.map((item) => {
          return (
            <OwnerItemCard
              key={item.key}
              item={item}
              projectName={projectName(item.projectId)}
              busy={busy === item.key}
              error={cardErrors[item.key]}
              onRun={(action) => handleAction(item, action)}
              canDefer={resolveDeferTarget(item) !== null}
              onOpenTask={onOpenTask}
              onOpenWork={onOpenWork}
            />
          );
        })}
      </ul>
    );
    return (
      <section key={section.source} className="space-y-2" data-testid={`owner-section-${section.source}`}>
        {folding && (section.folded || rows.length > FOLD_OVER) && !rows.some((item) => item.wake) ? (
          <Disclosure summary={<span className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></span>}>{list}</Disclosure>
        ) : (
          <>
            <h3 className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></h3>
            {list}
          </>
        )}
      </section>
    );
  });
  const redAttempts = waiting?.overnight.red.flatMap((row) => row.attempts) ?? [];
  const attention = waiting?.attention;
  const openSettings = () => {
    if (onOpenSettings) onOpenSettings();
    else navigate?.toPluginPanel?.("lane-pilot", { subPath: "system/settings" });
  };
  return (
    <div className="space-y-4" data-testid="owner-waiting">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--lp-ink)]">{t("ow_title")} <span className="text-sm font-normal text-muted-foreground" data-testid="owner-count">{items.length}</span></h2>
        </div>
        {attention ? (
          <div className="shrink-0 space-y-1 text-right" data-testid="owner-attention">
            <span className="text-xs font-medium text-[var(--lp-body)]">
              {fill("consoleDecisionsAttention", { shown: attention.shown, cap: attention.cap })}
            </span>
            {attention.cap > 0 ? (
              <div className="flex justify-end gap-1" aria-hidden>
                {Array.from({ length: attention.cap }, (_, idx) => (
                  <span key={idx} className={`h-[5px] w-[30px] rounded-[3px] ${idx < attention.shown ? "bg-[var(--lp-accent)]" : "bg-[var(--lp-line)]"}`} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {failed && !waiting ? <p role="alert" className="text-sm text-destructive">{t("ow_failed")}</p> : null}
      {!waiting && !failed ? <p className="text-sm text-muted-foreground">{t("ow_loading")}</p> : null}
      {waiting ? (
        <section className="lp-card space-y-1 p-4 text-[13px] text-[var(--lp-body)]" data-testid="owner-overnight">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("ow_overnight")}</h3>
          <p data-testid="owner-accepted">{fill("ow_accepted", { n: waiting.overnight.accepted, adopted: waiting.overnight.rulesAdopted, confirmed: waiting.overnight.rulesConfirmed })}</p>
          {waiting.answered ? <p data-testid="owner-answered">{fill("ow_answered", waiting.answered)}</p> : null}
          <p data-testid="owner-red"><span className="font-medium">{t("ow_red")}:</span> {waiting.overnight.red.length
            ? waiting.overnight.red.map((row) => `${stateLabel(row.state)} ${row.count}`).join(", ") : t("ow_red_none")}</p>
          {redAttempts.length ? (
            <Disclosure summary={foldLabel(t("ow_details"))} compact>
              <div className="flex flex-wrap gap-1.5 pt-1">{redAttempts.map((id) => <span key={id} className={ownerChipClass} title={id}>{kindLabel("attempt")}: {shortRef("attempt", id)}</span>)}</div>
            </Disclosure>
          ) : null}
        </section>
      ) : null}
      {waiting && !items.length ? <p className="text-sm text-muted-foreground" data-testid="owner-empty">{t("ow_empty")}</p> : null}
      {nowItems.length ? (
        <section className="space-y-3" data-testid="owner-now">
          {laterItems.length ? <div><h3 className="text-sm font-semibold">{t("ow_now")} <span className="font-normal text-muted-foreground">{nowItems.length}</span></h3><p className="text-xs text-muted-foreground">{t("ow_now_help")}</p></div> : null}
          {renderSections(nowItems, true)}
        </section>
      ) : null}
      {laterItems.length ? (
        <section data-testid="owner-later">
          <Disclosure summary={<span className="text-sm font-semibold">{t("ow_later")} <span className="font-normal text-muted-foreground">{laterItems.length}</span></span>}>
            <div className="space-y-3 pt-2">{renderSections(laterItems, false)}</div>
          </Disclosure>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--lp-muted)]" data-testid="owner-push-link">
        <span>{t("consoleDecisionsSettingsNote")}</span>
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" data-testid="owner-open-settings" onClick={openSettings}>
          {t("consoleDecisionsSettingsLink")}
        </Button>
      </div>
      <ConfirmDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}
        title={pendingConfirm ? confirmTitleFor(pendingConfirm.action) : ""}
        tone="danger"
        confirmLabel={pendingConfirm?.action.label ?? t("ow_done")}
        cancelLabel={t("cancel")}
        onConfirm={handleConfirm}
        body={pendingConfirm ? (
          <div className="space-y-3">
            <p>{pendingConfirm.item.what}</p>
            {isTaskWordNo(pendingConfirm.action) ? (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">{t("consoleDecisionsRejectReasonLabel")}</span>
                <Input
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                  placeholder={t("consoleDecisionsRejectReasonPlaceholder")}
                  data-testid="owner-confirm-reason"
                  autoFocus
                />
              </label>
            ) : null}
          </div>
        ) : null}
      />
    </div>
  );
}
