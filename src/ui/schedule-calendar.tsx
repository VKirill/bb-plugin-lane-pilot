import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import type { RunView, ScheduleView } from "../schedule/views";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { RunPill, errorText, fill, fmtClock } from "./schedule-parts";
import { addDays, addMonths, conflictKeys, eventsByDay, rangeOf, startOfDay, viewDays, CONFLICT_WINDOW_MS, type CalendarEvent, type CalendarView } from "./schedule-model";

type Calendar = { planned: Array<{ scheduleId: string; at: number }>; past: RunView[]; truncated: string[] };

const VIEWS: CalendarView[] = ["month", "week", "list"];
const VIEW_LABEL: Record<CalendarView, I18nKey> = { month: "schCalMonth", week: "schCalWeek", list: "schCalList" };
const DOT: Record<RunView["status"], string> = { queued: "bg-muted-foreground", running: "bg-[var(--lp-info)]", waiting: "bg-[var(--lp-warning)]", succeeded: "bg-[var(--lp-success)]", failed: "bg-destructive", timed_out: "bg-destructive", skipped: "bg-muted-foreground", canceled: "bg-muted-foreground" };
const dayLabel = (day: number) => new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** The calendar: future runs unrolled from the crons (planned) and the runs that happened (past), as a month, a week or the next seven days. */
export function ScheduleCalendar({ projectId, schedules, refreshKey, now, onCreateDay, onOpenSchedule }: {
  projectId: string | null; schedules: readonly ScheduleView[]; refreshKey: number; now: number;
  onCreateDay: (day: number) => void; onOpenSchedule: (id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(now));
  const [selected, setSelected] = useState<number | null>(null);
  const [data, setData] = useState<Calendar | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const days = useMemo(() => viewDays(view, anchor, now), [view, anchor, startOfDay(now)]); // eslint-disable-line react-hooks/exhaustive-deps
  const { from, to } = rangeOf(days);
  useEffect(() => {
    let live = true;
    void rpc.call("schedule_calendar", { ...(projectId ? { projectId } : {}), from, to })
      .then((result) => { if (live) { setData(result); setFailure(null); } })
      .catch((cause) => { if (live) setFailure(errorText(cause)); });
    return () => { live = false; };
  }, [rpc, projectId, from, to, refreshKey]);

  const byId = useMemo(() => new Map(schedules.map((item) => [item.id, item] as const)), [schedules]);
  const conflicts = useMemo(() => conflictKeys(data?.planned ?? [], schedules), [data, schedules]);
  const events = useMemo(() => eventsByDay(data?.planned ?? [], data?.past ?? [], new Set(conflicts.keys())), [data, conflicts]);

  const step = (dir: -1 | 1) => setAnchor((current) => view === "month" ? addMonths(current, dir) : addDays(current, 7 * dir));
  const today = startOfDay(now);
  const title = view === "month" ? new Date(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : `${dayLabel(days[0]!)} – ${dayLabel(days[days.length - 1]!)}`;
  const openDay = selected !== null && days.includes(selected) ? selected : null;

  const eventRow = (event: CalendarEvent) => {
    const schedule = byId.get(event.scheduleId);
    return (
      <li key={event.key}>
        <button type="button" className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid={`sch-cal-event-${event.key}`} data-kind={event.kind} data-conflict={event.conflict ? "1" : "0"} onClick={() => onOpenSchedule(event.scheduleId)}>
          <span className="font-mono text-muted-foreground">{fmtClock(event.at)}</span>
          <span className="min-w-0 break-words font-medium">{schedule?.name ?? event.scheduleId}</span>
          {event.run ? <RunPill status={event.run.status} /> : <span className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px] font-medium">{t("schColumn_scheduled")}</span>}
          {event.conflict ? <span className="lp-pill-warning rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid={`sch-cal-conflict-${event.key}`}>{fill(t("schCalConflict"), { machine: conflicts.get(event.key.slice(2)) ?? schedule?.machine ?? "", n: CONFLICT_WINDOW_MS / 60_000 })}</span> : null}
        </button>
      </li>
    );
  };

  const daySection = (day: number) => {
    const list = events.get(day) ?? [];
    return (
      <section key={day} className="space-y-1" data-testid={`sch-cal-section-${day}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className={`text-xs font-medium ${day === today ? "text-timeline-accent" : ""}`}>{dayLabel(day)}</h3>
          {day >= today ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid={`sch-cal-add-${day}`} aria-label={t("schCalCreateDay")} onClick={() => onCreateDay(day)}>＋</Button> : null}
        </div>
        {list.length ? <ul className="divide-y divide-border/60">{list.map(eventRow)}</ul> : <p className="px-2 text-xs text-muted-foreground">{t("schCalNoEvents")}</p>}
      </section>
    );
  };

  const weekdays = days.slice(0, 7).map((day) => new Date(day).toLocaleDateString(undefined, { weekday: "short" }));
  const monthIndex = new Date(anchor).getMonth();

  return (
    <Surface testId="schedule-calendar" data-view={view}>
      <SurfaceHeader className="flex-wrap justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("schViewCalendar")}>
          {VIEWS.map((item) => <Button key={item} type="button" size="sm" variant={view === item ? "secondary" : "ghost"} className="h-7 px-2 text-xs" aria-pressed={view === item} data-testid={`sch-cal-view-${item}`} onClick={() => { setView(item); setSelected(null); }}>{t(VIEW_LABEL[item])}</Button>)}
        </div>
        {view !== "list" ? (
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" aria-label={t("schCalPrev")} data-testid="sch-cal-prev" onClick={() => step(-1)}>‹</Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" data-testid="sch-cal-today" onClick={() => { setAnchor(today); setSelected(today); }}>{t("schCalToday")}</Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" aria-label={t("schCalNext")} data-testid="sch-cal-next" onClick={() => step(1)}>›</Button>
          </div>
        ) : null}
      </SurfaceHeader>
      <SurfaceBody>
        <p className="text-sm font-medium capitalize" data-testid="sch-cal-title">{title}</p>
        {failure ? <p className="break-words text-xs text-destructive-text" role="alert">{failure}</p> : null}
        {data?.truncated.length ? <p className="text-xs text-muted-foreground" data-testid="sch-cal-truncated">{t("schCalTruncated")}</p> : null}
        {view === "month" ? <>
          <div className="grid grid-cols-7 gap-px text-center text-[11px] text-muted-foreground">{weekdays.map((name) => <span key={name}>{name}</span>)}</div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--lp-hairline)] bg-[var(--lp-hairline)]" data-testid="sch-cal-grid">
            {days.map((day) => {
              const list = events.get(day) ?? [];
              const outside = new Date(day).getMonth() !== monthIndex;
              return (
                <button key={day} type="button" className={`flex min-h-12 min-w-0 flex-col items-stretch gap-0.5 bg-[var(--lp-card)] p-1 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-20 ${outside ? "opacity-50" : ""} ${openDay === day ? "ring-1 ring-inset ring-[var(--lp-info)]" : ""}`}
                  data-testid={`sch-cal-day-${day}`} data-count={list.length} aria-pressed={openDay === day} onClick={() => setSelected(day)}>
                  <span className={`text-[11px] ${day === today ? "font-semibold text-timeline-accent" : ""}`}>{new Date(day).getDate()}</span>
                  <span className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                    {list.slice(0, 4).map((event) => <span key={event.key} className={`size-1.5 rounded-full ${event.run ? DOT[event.run.status] : "border border-muted-foreground"}`} />)}
                  </span>
                  <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                    {list.slice(0, 3).map((event) => (
                      <span key={event.key} className={`truncate rounded px-1 text-[10px] ${event.run ? "bg-[var(--lp-well)]" : "border border-[var(--lp-hairline)]"}`}>
                        {event.conflict ? "⚠ " : ""}{fmtClock(event.at)} {byId.get(event.scheduleId)?.name ?? ""}
                      </span>
                    ))}
                    {list.length > 3 ? <span className="text-[10px] text-muted-foreground">{fill(t("schCalMore"), { n: list.length - 3 })}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {openDay !== null ? daySection(openDay) : null}
        </> : (
          <div className="space-y-3" data-testid="sch-cal-days">{days.map(daySection)}</div>
        )}
      </SurfaceBody>
    </Surface>
  );
}
