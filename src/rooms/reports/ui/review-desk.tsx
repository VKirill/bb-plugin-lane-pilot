import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { detectLocale, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  Icon,
  Skeleton,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
} from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { ReviewDeskItem, ReviewDeskView } from "../../contracts/ui";
import { useLpRpcQuery } from "../../ui-shell/ui";
import {
  DESK_SECTIONS,
  DESK_SECTION_LABELS,
  deskWeekKey,
  isoWeekMondayUtc,
  shiftIsoWeek,
  type DeskSection,
} from "../models/review-desk";

const DESK_POLL_MS = 30_000;
const DAY_MS = 86_400_000;

const SECTION_LABEL_KEYS: Record<DeskSection, I18nKey> = {
  candidates: "consoleDeskSection_candidates",
  drafts: "consoleDeskSection_drafts",
  evolve: "consoleDeskSection_evolve",
  employee: "consoleDeskSection_employee",
  deferred: "consoleDeskSection_deferred",
  "loop-health": "consoleDeskSection_loop_health",
  durability: "consoleDeskSection_durability",
};

function sectionTitle(section: string): string {
  if (section in SECTION_LABEL_KEYS) {
    return t(SECTION_LABEL_KEYS[section as DeskSection]);
  }
  return DESK_SECTION_LABELS[section as DeskSection] ?? section;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return fallback;
}

function formatWeekDateRange(week: string, locale: Locale): string | null {
  const monday = isoWeekMondayUtc(week);
  if (!monday) return null;
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  const fmt = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" });
  return `${fmt.format(monday)} – ${fmt.format(sunday)}`;
}

function formatDefaultAt(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function groupDeskSections(items: ReadonlyArray<ReviewDeskItem>): Array<{ section: string; items: ReviewDeskItem[] }> {
  const bySection = new Map<string, ReviewDeskItem[]>();
  for (const item of items) {
    const list = bySection.get(item.section);
    if (list) list.push(item);
    else bySection.set(item.section, [item]);
  }
  const ordered: Array<{ section: string; items: ReviewDeskItem[] }> = [];
  for (const sec of DESK_SECTIONS) {
    const list = bySection.get(sec);
    if (list && list.length > 0) {
      ordered.push({ section: sec, items: list });
      bySection.delete(sec);
    }
  }
  for (const [sec, list] of bySection.entries()) {
    ordered.push({ section: sec, items: list });
  }
  return ordered;
}

export interface ReviewDeskProps {
  week?: string;
  onWeekChange?: (week: string | undefined) => void;
  onOpenTask?: (runId: string, taskId: string) => void;
  locale?: Locale;
}

/** Decisions — Weekly review desk tab (P2): grouped items, option radios, evidence links, week switcher, and confirmed accept-defaults. */
export function ReviewDesk({ week, onWeekChange, onOpenTask, locale: localeProp }: ReviewDeskProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [internalWeek, setInternalWeek] = useState<string | undefined>(week);
  useEffect(() => {
    if (onWeekChange) return;
    setInternalWeek(week);
  }, [week, onWeekChange]);

  const selectedWeek = onWeekChange ? week : internalWeek;
  const setWeek = (next: string | undefined) => {
    if (onWeekChange) onWeekChange(next);
    else setInternalWeek(next);
  };

  const fallbackCurrentWeek = useMemo(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return deskWeekKey(Date.now(), tz);
  }, []);
  const observedCurrentWeekRef = useRef<string | null>(null);

  const deskInput = useMemo(() => (selectedWeek ? { week: selectedWeek } : {}), [selectedWeek]);
  const deskQuery = useLpRpcQuery<ReviewDeskView>("desk_get", deskInput, { pollMs: DESK_POLL_MS });

  if (!selectedWeek && deskQuery.data?.week) {
    observedCurrentWeekRef.current = deskQuery.data.week;
  }

  const currentWeek = observedCurrentWeekRef.current ?? fallbackCurrentWeek;
  const activeWeek = deskQuery.data?.week ?? selectedWeek ?? currentWeek;

  const [answeredOverrides, setAnsweredOverrides] = useState<Record<string, ReviewDeskItem>>({});
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [confirmDefaultsOpen, setConfirmDefaultsOpen] = useState(false);

  useEffect(() => {
    setAnsweredOverrides({});
    setItemErrors({});
  }, [activeWeek]);

  const data = deskQuery.data;
  const items = useMemo(() => {
    const raw = data?.items ?? [];
    return raw.map((item) => answeredOverrides[item.id] ?? item);
  }, [data?.items, answeredOverrides]);

  const isPreviousWeek = activeWeek < currentWeek;
  const allAnswered = items.length > 0 && items.every((item) => item.answered !== null);
  const isReadOnly = isPreviousWeek && allAnswered;
  const answeredCount = items.filter((item) => item.answered !== null).length;
  const openCount = items.length - answeredCount;
  const sections = useMemo(() => groupDeskSections(items), [items]);
  const weekRange = formatWeekDateRange(activeWeek, locale);

  const handleOpenEvidence = (evidence: string) => {
    const taskWordMatch = /^task-word:([^:]+):([^:]+)/.exec(evidence);
    if (taskWordMatch?.[1] && taskWordMatch[2]) {
      if (onOpenTask) onOpenTask(taskWordMatch[1], taskWordMatch[2]);
      else navigate?.toPluginPanel?.("lane-pilot", { subPath: `work/task/${taskWordMatch[1]}/${taskWordMatch[2]}` });
      return;
    }
    if (evidence.startsWith("draft:") || evidence.startsWith("hypothesis:")) {
      navigate?.toPluginPanel?.("lane-pilot", { subPath: "system/graphs" });
      return;
    }
    const staffMatch = /^([^/\s:]+)\/([^:\s]+):/.exec(evidence);
    if (staffMatch?.[1] && staffMatch[2]) {
      navigate?.toPluginPanel?.("lane-pilot", { subPath: `staff/${staffMatch[1]}/${staffMatch[2]}` });
      return;
    }
    if (/^thr_/.test(evidence)) {
      const threadId = evidence.split(/[#:]/)[0];
      if (threadId) {
        navigate?.toThread?.(threadId);
        return;
      }
    }
    void navigator.clipboard?.writeText(evidence).then(() => {
      toast.success(t("consoleDeskEvidenceCopied"));
    }).catch(() => undefined);
  };

  const handleAnswer = async (item: ReviewDeskItem, optionId: string) => {
    if (isReadOnly || busyItemId !== null) return;
    setBusyItemId(item.id);
    setItemErrors((prev) => {
      if (!(item.id in prev)) return prev;
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      const result = await rpc.call("desk_answer", { itemId: item.id, option: optionId });
      if (!result.ok) {
        const message = result.reason || t("consoleDeskAnswerFailed");
        setItemErrors((prev) => ({ ...prev, [item.id]: message }));
        console.warn("[lane-pilot:desk] answer refused", { itemId: item.id, option: optionId, reason: message });
        toast.error(t("consoleDeskAnswerFailed"), { description: message });
        return;
      }
      setAnsweredOverrides((prev) => ({ ...prev, [item.id]: result.item }));
      toast.success(t("consoleDeskAnswerSaved"));
      await deskQuery.refetch();
    } catch (cause) {
      const message = errorMessage(cause, t("consoleDeskAnswerFailed"));
      setItemErrors((prev) => ({ ...prev, [item.id]: message }));
      console.warn("[lane-pilot:desk] answer failed", { itemId: item.id, option: optionId, message });
      toast.error(t("consoleDeskAnswerFailed"), { description: message });
    } finally {
      setBusyItemId(null);
    }
  };

  const handleAcceptDefaults = async () => {
    const targetWeek = data?.week ?? activeWeek;
    try {
      const result = await rpc.call("desk_accept_defaults", { week: targetWeek });
      if (!result.ok) {
        throw new Error(t("consoleDeskAcceptDefaultsFailed"));
      }
      toast.success(t("consoleDeskAcceptDefaultsDone").replace("{n}", String(result.accepted)));
      setAnsweredOverrides({});
      await deskQuery.refetch();
    } catch (cause) {
      const message = errorMessage(cause, t("consoleDeskAcceptDefaultsFailed"));
      console.warn("[lane-pilot:desk] accept-defaults failed", { week: targetWeek, message });
      throw cause instanceof Error ? cause : new Error(message);
    }
  };

  const handlePrevWeek = () => {
    setWeek(shiftIsoWeek(activeWeek, -1));
  };

  const handleNextWeek = () => {
    if (activeWeek >= currentWeek) return;
    const next = shiftIsoWeek(activeWeek, 1);
    setWeek(next >= currentWeek ? undefined : next);
  };

  return (
    <div className="space-y-4" data-testid="review-desk">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label={t("consoleDecisionsTabDesk")}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              aria-label={t("consoleDeskPrevWeek")}
              data-testid="desk-prev-week"
              onClick={handlePrevWeek}
            >
              <Icon name="ChevronRight" className="size-4 rotate-180" aria-hidden />
            </Button>
            <div className="px-2 text-sm font-medium text-foreground" data-testid="desk-week-label">
              {t("consoleDeskWeekLabel").replace("{week}", activeWeek)}
              {weekRange ? <span className="ml-1.5 font-normal text-muted-foreground">· {weekRange}</span> : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              aria-label={t("consoleDeskNextWeek")}
              data-testid="desk-next-week"
              disabled={activeWeek >= currentWeek}
              onClick={handleNextWeek}
            >
              <Icon name="ChevronRight" className="size-4" aria-hidden />
            </Button>
          </div>
          {activeWeek !== currentWeek ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2.5 text-xs"
              data-testid="desk-current-week"
              onClick={() => setWeek(undefined)}
            >
              {t("consoleDeskCurrentWeek")}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isReadOnly ? (
            <span data-testid="desk-readonly-badge">
              <StatusPill tone="muted">{t("consoleDeskReadOnlyBadge")}</StatusPill>
            </span>
          ) : null}
          {data ? (
            <span className="text-xs text-muted-foreground" data-testid="desk-counts">
              {t("consoleDeskSummaryCounts")
                .replace("{open}", String(openCount))
                .replace("{answered}", String(answeredCount))}
            </span>
          ) : null}
        </div>
      </div>

      {deskQuery.error ? (
        <Alert variant="destructive" data-testid="desk-load-error">
          <AlertTitle>{t("consoleDeskLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorMessage(deskQuery.error, t("consoleDeskLoadError"))}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="desk-retry"
              onClick={() => void deskQuery.refetch()}
            >
              {t("consoleDeskRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!data && deskQuery.isLoading ? (
        <div className="space-y-3" data-testid="desk-loading" aria-busy="true" aria-label={t("consoleDeskLoading")}>
          <Skeleton className="h-32 rounded-[14px]" />
          <Skeleton className="h-32 rounded-[14px]" />
        </div>
      ) : data && items.length === 0 ? (
        <Surface testId="desk-empty">
          <SurfaceBody>
            <p className="text-sm text-muted-foreground">
              {isPreviousWeek
                ? t("consoleDeskEmptyArchive").replace("{week}", activeWeek)
                : t("consoleDeskEmptyCurrent")}
            </p>
          </SurfaceBody>
        </Surface>
      ) : data ? (
        <div className="space-y-4" data-testid="desk-sections">
          {sections.map((group) => (
            <Surface key={group.section} testId={`desk-section-${group.section}`}>
              <SurfaceHeader className="justify-between">
                <div className="flex items-center gap-2">
                  <StatusPill tone="accent">{sectionTitle(group.section)}</StatusPill>
                  <span className="text-xs text-muted-foreground">{group.items.length}</span>
                </div>
              </SurfaceHeader>
              <SurfaceBody className="divide-y divide-[var(--lp-hairline)] space-y-0 p-0">
                {group.items.map((item) => {
                  const defaultLabel = formatDefaultAt(item.defaultAt, locale);
                  const isAnswered = item.answered !== null;
                  const itemError = itemErrors[item.id];
                  return (
                    <div
                      key={item.id}
                      className="space-y-2.5 px-4 py-3.5"
                      data-testid={`desk-item-${item.id}`}
                      data-answered={item.answered ?? ""}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-sm font-medium text-foreground" data-testid={`desk-question-${item.id}`}>
                            {item.question}
                          </p>
                          {item.evidence ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              data-testid={`desk-evidence-${item.id}`}
                              onClick={() => handleOpenEvidence(item.evidence!)}
                            >
                              <Icon name="ArrowUpRight" className="size-3 shrink-0" aria-hidden />
                              <span className="break-all font-mono">{item.evidence}</span>
                            </button>
                          ) : null}
                        </div>
                        {isAnswered ? (
                          <span data-testid={`desk-answered-${item.id}`}>
                            <StatusPill tone="ok">
                              {t("consoleDeskAnsweredBadge").replace("{option}", item.answered!)}
                            </StatusPill>
                          </span>
                        ) : null}
                      </div>

                      <div
                        role="radiogroup"
                        aria-label={item.question}
                        className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap"
                        data-testid={`desk-options-${item.id}`}
                      >
                        {item.options.map((opt) => {
                          const selected = item.answered === opt.id;
                          return (
                            <label
                              key={opt.id}
                              data-testid={`desk-option-label-${item.id}-${opt.id}`}
                              className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                                selected
                                  ? "border-primary bg-primary/10 font-medium text-foreground"
                                  : "border-[var(--lp-hairline)] bg-[var(--lp-well)]/40 text-foreground hover:bg-state-hover"
                              } ${isReadOnly || busyItemId === item.id ? "cursor-not-allowed opacity-70" : ""}`}
                            >
                              <input
                                type="radio"
                                name={`desk-radio-${item.id}`}
                                value={opt.id}
                                checked={selected}
                                disabled={isReadOnly || busyItemId !== null}
                                data-testid={`desk-radio-${item.id}-${opt.id}`}
                                onChange={() => void handleAnswer(item, opt.id)}
                              />
                              <span>{opt.label}</span>
                              {opt.isDefault ? (
                                <span
                                  className="text-[11px] font-normal text-muted-foreground"
                                  data-testid={`desk-default-mark-${item.id}-${opt.id}`}
                                >
                                  ({t("consoleDeskOptionDefaultUntil").replace("{date}", defaultLabel)})
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>

                      {itemError ? (
                        <p role="alert" className="text-xs text-destructive" data-testid={`desk-error-${item.id}`}>
                          {itemError}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </SurfaceBody>
            </Surface>
          ))}
        </div>
      ) : null}

      <footer
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)] px-4 py-3"
        data-testid="desk-footer"
      >
        <div className="text-xs text-muted-foreground">
          {data
            ? t("consoleDeskSummaryCounts")
                .replace("{open}", String(openCount))
                .replace("{answered}", String(answeredCount))
            : null}
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={!data || isReadOnly || isPreviousWeek || openCount === 0}
          data-testid="desk-accept-defaults"
          onClick={() => setConfirmDefaultsOpen(true)}
        >
          {t("consoleDeskAcceptDefaults")}
        </Button>
      </footer>

      <ConfirmDialog
        open={confirmDefaultsOpen}
        onOpenChange={setConfirmDefaultsOpen}
        title={t("consoleDeskAcceptDefaultsTitle")}
        body={t("consoleDeskAcceptDefaultsBody")
          .replace("{n}", String(openCount))
          .replace("{week}", activeWeek)}
        confirmLabel={t("consoleDeskAcceptDefaultsConfirm")}
        cancelLabel={t("cancel")}
        onConfirm={handleAcceptDefaults}
      />
    </div>
  );
}
