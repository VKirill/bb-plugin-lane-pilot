import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "@lane-pilot/ui-kit";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import type { BoardColumn, ErrandDefaultView, RunView, ScheduleView } from "../schedule/views";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "./use-lp-realtime";
import { ScheduleCalendar } from "./schedule-calendar";
import { ScheduleDefaultBlock } from "./schedule-default";
import { ScheduleDetail } from "./schedule-detail";
import { ScheduleForm } from "./schedule-form";
import { ScheduleHistory, useOpenRunThread } from "./schedule-history";
import { ScheduleTextCreate } from "./schedule-text";
import { COLUMNS, groupByColumn, machineName, placeText, taskSummary } from "./schedule-model";
import { RunPill, errorText, fill, fmtTime, whenText } from "./schedule-parts";
import { modelLine, sourceLabel } from "./schedule-who";

type Listing = { schedules: ScheduleView[]; hosts: Array<{ id: string; name: string; connected: boolean }>; now: number; errandDefault?: ErrandDefaultView };
type Mode = { kind: "board" } | { kind: "calendar" } | { kind: "history"; id: string; back: "board" | "calendar" } | { kind: "detail"; id: string; back: "board" | "calendar" } | { kind: "form"; existing: ScheduleView | null; runAt: number | null } | { kind: "text" };

const COLUMN_TONE: Record<BoardColumn, string> = { scheduled: "lp-pill-info", running: "lp-pill-info", waiting: "lp-pill-warning", done: "lp-pill-success", failed: "lp-pill-danger", paused: "lp-pill-muted" };
const LIVE = new Set<RunView["status"]>(["queued", "running", "waiting"]);

function Card({ schedule, projectName, busy, onRun, onTogglePause, onEdit, onHistory, onDetail, onCancel }: {
  schedule: ScheduleView; projectName: string | null; busy: boolean;
  onRun: () => void; onTogglePause: () => void; onEdit: () => void; onHistory: () => void; onDetail: () => void; onCancel: (runId: string) => void;
}) {
  const openThread = useOpenRunThread();
  const last = schedule.lastRun;
  const live = schedule.active.find((run) => LIVE.has(run.status));
  const next = schedule.nextFires[0];
  const paused = schedule.state === "paused";
  return (
    <article className="lp-card min-w-0 space-y-2 p-3" data-testid={`sch-card-${schedule.id}`} data-column={schedule.column}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <h3 className="min-w-0 flex-1 break-words text-sm font-medium"><button type="button" className="text-left hover:underline" data-testid={`sch-title-${schedule.id}`} onClick={onDetail}>{schedule.name}</button></h3>
        <span className="lp-pill-muted shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid={`sch-kind-${schedule.id}`}>{t(`schKind_${schedule.task.kind}` as I18nKey)}</span>
      </div>
      <p className="break-words text-xs text-muted-foreground" data-testid={`sch-what-${schedule.id}`}>{taskSummary(schedule)}</p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {placeText(schedule.where) || machineName(schedule.where) ? (
          <p className="break-words" data-testid={`sch-where-${schedule.id}`}>{[placeText(schedule.where), machineName(schedule.where)].filter(Boolean).join(" · ")}</p>
        ) : null}
        {schedule.model ? <p className="break-words" data-testid={`sch-who-${schedule.id}`}>{fill(t("schWhoLine"), { model: modelLine(schedule.model), source: sourceLabel(schedule.model) })}</p> : null}
        <p className="break-words" data-testid={`sch-when-${schedule.id}`}>{whenText(schedule.when)}</p>
        <p data-testid={`sch-next-${schedule.id}`}>{next !== undefined ? fill(t("schNext"), { time: fmtTime(next) }) : paused && schedule.pauseReason ? fill(t("schPausedBecause"), { reason: schedule.pauseReason }) : t("schNextNone")}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`sch-last-${schedule.id}`}>
          {last ? <><RunPill status={last.status} /><span>{fill(t("schLast"), { time: fmtTime(last.finishedAt ?? last.startedAt ?? last.scheduledAt) })}</span></> : <span>{t("schLastNone")}</span>}
        </p>
        {schedule.consecutiveFailures > 0 ? <p className="text-destructive-text">{fill(t("schFailuresRow"), { n: schedule.consecutiveFailures })}</p> : null}
        {schedule.machine ? <p className="break-words">{fill(t("schMachine"), { name: schedule.machine })}</p> : null}
        {projectName ? <p className="break-words" data-testid={`sch-project-${schedule.id}`}>{fill(t("schProject"), { name: projectName })}</p> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy} data-testid={`sch-run-now-${schedule.id}`} onClick={onRun}>{t("schRunNow")}</Button>
        <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy || schedule.state === "done"} data-testid={`sch-pause-${schedule.id}`} onClick={onTogglePause}>{paused ? t("schResume") : t("schPause")}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" data-testid={`sch-detail-${schedule.id}`} onClick={onDetail}>{t("schDetail")}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" data-testid={`sch-edit-${schedule.id}`} onClick={onEdit}>{t("schEdit")}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" data-testid={`sch-history-${schedule.id}`} onClick={onHistory}>{t("schHistory")}</Button>
        {live?.refKind === "thread" && live.refId ? <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" data-testid={`sch-open-${schedule.id}`} onClick={() => openThread(live.refId!, schedule.name)}>{t("schOpenThread")}</Button> : null}
        {live ? <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" data-testid={`sch-cancel-${schedule.id}`} onClick={() => onCancel(live.id)}>{t("schCancelRun")}</Button> : null}
      </div>
    </article>
  );
}

/**
 * The automation area: the board of scheduled tasks (Scheduled, Running, Waiting for you, Done, Failed, Paused), their history,
 * the calendar, and the two ways to add one (a sentence to the project manager, or the form). With a project it shows that project's
 * tasks; without one, every project's. Re-reads on the server's `schedule` signal, with a slow poll behind it.
 */
export function ScheduleBoard({ projectId, projects = [], locale }: { projectId: string | null; projects?: ReadonlyArray<{ id: string; name: string }>; locale: Locale }) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "board" });
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("schedule_list", { ...(projectId ? { projectId } : {}), next: 5 });
      setListing(result); setFailure(null); setTick((n) => n + 1);
    } catch (cause) { setFailure(errorText(cause)); }
  }, [rpc, projectId]);
  useEffect(() => { setListing(null); setMode({ kind: "board" }); void load(); }, [load]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["schedule"], () => { void loadRef.current(); });
  useEffect(() => { const timer = setInterval(() => void loadRef.current(), pollMs); return () => clearInterval(timer); }, [pollMs]);

  const schedules = listing?.schedules ?? [];
  const groups = useMemo(() => groupByColumn(schedules), [schedules]);
  const projectName = (id: string) => projects.find((item) => item.id === id)?.name ?? id;

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id); setNotice(null); setFailure(null);
    try { await work(); if (done) setNotice(done); await load(); } catch (cause) { setFailure(fill(t("schActionError"), { reason: errorText(cause) })); } finally { setBusy(null); }
  };
  const runNow = (schedule: ScheduleView) => act(schedule.id, async () => {
    const result = await rpc.call("schedule_run_now", { id: schedule.id });
    if (!result.ok) throw new Error(result.reason ?? "refused");
  }, t("schRunNowDone"));
  const togglePause = (schedule: ScheduleView) => act(schedule.id, () => schedule.state === "paused" ? rpc.call("schedule_resume", { id: schedule.id }) : rpc.call("schedule_pause", { id: schedule.id }));
  const cancelRun = (scheduleId: string, runId: string) => act(scheduleId, () => rpc.call("schedule_cancel_run", { runId }));
  const remove = (schedule: ScheduleView) => act(schedule.id, async () => { await rpc.call("schedule_delete", { id: schedule.id }); setMode({ kind: "board" }); });

  const back = () => setMode({ kind: "board" });
  const saved = () => { setMode({ kind: "board" }); void load(); };

  if (mode.kind === "history") {
    const schedule = schedules.find((item) => item.id === mode.id);
    if (schedule) return <div data-testid="schedule-area"><ScheduleHistory schedule={schedule} refreshKey={tick} onBack={() => setMode({ kind: mode.back })} onChanged={() => void load()} /></div>;
  }
  if (mode.kind === "detail") {
    const schedule = schedules.find((item) => item.id === mode.id);
    if (schedule) {
      return (
        <div className="space-y-3" data-testid="schedule-area">
          <ScheduleDetail key={schedule.id} schedule={schedule} hosts={listing?.hosts ?? []} errandDefault={listing?.errandDefault} onBack={() => setMode({ kind: mode.back })} onChanged={() => void load()}
            onEdit={() => setMode({ kind: "form", existing: schedule, runAt: null })} onHistory={() => setMode({ kind: "history", id: schedule.id, back: mode.back })} />
          {failure ? <p className="break-words text-xs text-destructive-text" role="alert">{failure}</p> : null}
        </div>
      );
    }
  }
  if (mode.kind === "form") {
    const existing = mode.existing;
    return (
      <div className="space-y-3" data-testid="schedule-area">
        <ScheduleForm projectId={projectId} projects={projects} hosts={listing?.hosts ?? []} existing={existing} errandDefault={listing?.errandDefault} initialRunAt={mode.runAt} locale={locale} onSaved={saved} onCancel={back} />
        {existing ? <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-sm text-destructive-text" disabled={busy === existing.id} data-testid="sch-delete" onClick={() => void remove(existing)}>{t("schDelete")}</Button> : null}
        {failure ? <p className="break-words text-xs text-destructive-text" role="alert">{failure}</p> : null}
      </div>
    );
  }

  const calendar = mode.kind === "calendar" || (mode.kind === "history" && mode.back === "calendar");
  return (
    <div className="min-w-0 space-y-4" data-testid="schedule-area">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">{projectId ? t("schHelp") : t("schHelpAll")}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant={calendar ? "outline" : "secondary"} className="h-8 px-3 text-sm" aria-pressed={!calendar} data-testid="sch-view-board" onClick={() => setMode({ kind: "board" })}>{t("schViewBoard")}</Button>
          <Button type="button" size="sm" variant={calendar ? "secondary" : "outline"} className="h-8 px-3 text-sm" aria-pressed={calendar} data-testid="sch-view-calendar" onClick={() => setMode({ kind: "calendar" })}>{t("schViewCalendar")}</Button>
          <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-sm" data-testid="sch-create-text" onClick={() => setMode({ kind: "text" })}>{t("schCreateText")}</Button>
          <Button type="button" size="sm" className="lp-accent h-8 px-3 text-sm" data-testid="sch-create-form" onClick={() => setMode({ kind: "form", existing: null, runAt: null })}>{t("schCreateForm")}</Button>
        </div>
      </div>
      {listing?.errandDefault ? <ScheduleDefaultBlock projectId={projectId} value={listing.errandDefault} onChanged={() => void load()} /> : null}
      {mode.kind === "text" ? <ScheduleTextCreate projectId={projectId} projects={projects} onClose={back} /> : null}
      {failure ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="sch-error">{listing ? failure : fill(t("schError"), { reason: failure })}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground" role="status" data-testid="sch-notice">{notice}</p> : null}
      {!listing && !failure ? <p className="text-xs text-muted-foreground" role="status">{t("schLoading")}</p> : null}
      {calendar && listing ? (
        <ScheduleCalendar projectId={projectId} schedules={schedules} refreshKey={tick} now={listing.now}
          onCreateDay={(day) => setMode({ kind: "form", existing: null, runAt: day + 9 * 3_600_000 })}
          onOpenSchedule={(id) => setMode({ kind: "history", id, back: "calendar" })} />
      ) : null}
      {!calendar && listing ? (
        schedules.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="sch-empty">{t("schEmpty")}</p> : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="sch-board">
            {COLUMNS.map((column) => {
              const cards = groups[column];
              return (
                <Surface key={column} testId={`sch-column-${column}`} className={cards.length ? "" : "max-sm:hidden"}>
                  <SurfaceHeader className="justify-between">
                    <h2 className="text-sm font-medium">{t(`schColumn_${column}` as I18nKey)}</h2>
                    <span className={`${COLUMN_TONE[column]} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={`sch-count-${column}`}>{cards.length}</span>
                  </SurfaceHeader>
                  <SurfaceBody>
                    {cards.length === 0 ? <p className="text-xs text-muted-foreground">{t("schColumnEmpty")}</p> : cards.map((schedule) => (
                      <Card key={schedule.id} schedule={schedule} projectName={projectId ? null : projectName(schedule.projectId)} busy={busy === schedule.id}
                        onRun={() => void runNow(schedule)} onTogglePause={() => void togglePause(schedule)}
                        onEdit={() => setMode({ kind: "form", existing: schedule, runAt: null })} onHistory={() => setMode({ kind: "history", id: schedule.id, back: "board" })}
                        onDetail={() => setMode({ kind: "detail", id: schedule.id, back: "board" })}
                        onCancel={(runId) => void cancelRun(schedule.id, runId)} />
                    ))}
                  </SurfaceBody>
                </Surface>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}
