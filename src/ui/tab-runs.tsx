import { stateLabel, t, type I18nKey } from "@lane-pilot/i18n";
import { ATTEMPT_STATES, RUN_STATES } from "../state-machine";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { AcceptanceStats } from "./acceptance-stats";
import { CriticValue } from "../rooms/critique/ui/critic-value";
import { WriterReuse } from "./writer-reuse";
import { Disclosure } from "@lane-pilot/ui-kit";
import { Pill } from "./pill";
import { OPEN_ATTEMPT_STATES, RUNS_PAGE, canCancelAttempt, canRetryAttempt, runTone, type MonitorRun } from "./page-model";
import { RunStages } from "./run-parts";
import { ServiceSegment } from "./runs-service";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "./tabs-model";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { LpPage } from "./use-lp-page";

/** A run with more attempts than this folds its finished ones. */
const FOLD_ATTEMPTS = 6;
const isOpen = (run: MonitorRun) => run.state === "pending" || run.state === "running";

/** Runs of the project: those in progress, the history, how the checks and writers did, the council's sessions and the machine. */
export function RunsTab({ page }: { page: LpPage }) {
  const { level, segmentOf, setSegment, tabSelect, activeRuns, isGlobal } = page;
  const ids = segmentsFor("runs", level);
  const segment = ids.includes(segmentOf("runs")) ? segmentOf("runs") : ids[0]!;
  return (
    <div className="space-y-4" data-testid="run-monitor">
      <Segments testId="runs" label={t("tabRuns")} compact={tabSelect} value={segment} onChange={(next) => setSegment("runs", next)}
        items={ids.map((id) => ({ id, label: t(SEGMENT_LABELS[id]!) }))} badge={{ active: activeRuns }} />
      {isGlobal ? <p className="text-sm text-muted-foreground" data-testid="runs-global-empty">{t("runsGlobalEmpty")}</p> : (
        <>
          {segment === "active" ? <RunsList page={page} view="active" /> : null}
          {segment === "history" ? <RunsList page={page} view="history" /> : null}
          {segment === "analytics" ? <Analytics page={page} /> : null}
          {segment === "council" ? <CouncilSessions page={page} /> : null}
          {segment === "service" ? <div className="space-y-5" data-testid="service-panel"><ServiceSegment page={page} /></div> : null}
        </>
      )}
    </div>
  );
}

function RunsList({ page, view }: { page: LpPage; view: "active" | "history" }) {
  const { data, projectId, rpc, load, locale, finishRuns, finishing, runsShown, setRunsShown, runsWindow, loadMoreRuns } = page;
  const runs = (data?.runs ?? []).filter((run) => (view === "active" ? isOpen(run) : !isOpen(run)));
  // Runs in progress first, then the newest; the history opens 20 at a time.
  const ordered = [...runs].sort((a, b) => b.updated_at - a.updated_at);
  const moreOnServer = view === "history" && (data?.runsTotal ?? 0) > runsWindow.current;
  return (
    <>
      {view === "active" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" variant="outline" onClick={() => projectId && void rpc.call("resume_runs", { projectId }).then(load)}>{t("resume")}</Button>
          <span className="text-xs text-muted-foreground">{t("runsResumeHelp")}</span>
        </div>
      ) : null}
      {!ordered.length && !moreOnServer ? (
        <p className="text-sm text-muted-foreground" data-testid={`runs-empty-${view}`}>{view === "active" ? (data?.runs.length ? t("runsNoneActive") : t("emptyRuns")) : t("runsNoneHistory")}</p>
      ) : (
        <>
          <div className="space-y-3" data-testid="run-list">
            {ordered.slice(0, view === "history" ? runsShown : ordered.length).map((run) => {
              const hasOpenAttempt = run.attempts.some((item) => OPEN_ATTEMPT_STATES.includes(item.state));
              return <Surface key={run.id} testId={`run-${run.id}`}>
                <SurfaceHeader className="flex-wrap justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    {run.pmThread?.title
                      ? <span className="min-w-0 truncate text-sm font-medium" title={run.id}>{run.pmThread.title}</span>
                      : <span className="min-w-0 truncate font-mono text-xs" title={run.id}>{run.id}</span>}
                    <Badge variant={runTone(run.state)}>{stateLabel(run.state)}</Badge>
                    {run.pmThread?.status ? <span className="shrink-0 text-xs text-muted-foreground">{t(run.pmThread.status === "active" ? "runChatActive" : run.pmThread.status === "gone" ? "runChatGone" : "runChatIdle")}</span> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">{run.kind}{run.updated_at > 1e11 ? ` · ${new Date(run.updated_at).toLocaleString(locale)}` : ""}</span>
                </SurfaceHeader>
                <SurfaceBody className="space-y-2">
                  {(() => {
                    const row = (attempt: MonitorRun["attempts"][number]) => (
                      <div key={attempt.id} data-testid={`attempt-${attempt.id}`} className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs" title={attempt.task_id}>{attempt.task_id}</div>
                          <div className="text-xs text-muted-foreground">{t("attempt")} {attempt.attempt_no || "—"}</div>
                        </div>
                        <Badge className="shrink-0" variant={runTone(run.state === "closed" ? run.state : attempt.state)}>{stateLabel(run.state === "closed" ? run.state : attempt.state)}</Badge>
                        {canCancelAttempt(run, attempt) ? <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId: attempt.id }).then(load)}>{t("cancel")}</Button> : null}
                        {canRetryAttempt(run, attempt) ? <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId: attempt.id }).then(load)}>{t("retry")}</Button> : null}
                      </div>
                    );
                    // A run of hundreds of attempts shows the ones in progress and folds the finished ones.
                    const live = run.attempts.filter((attempt) => OPEN_ATTEMPT_STATES.includes(attempt.state));
                    const folded = run.attempts.length > FOLD_ATTEMPTS ? run.attempts.filter((attempt) => !OPEN_ATTEMPT_STATES.includes(attempt.state)) : [];
                    return <>
                      {(folded.length ? live : run.attempts).map(row)}
                      {folded.length ? <Disclosure compact testId={`attempts-${run.id}`} summary={`${t("runAttempts")} (${folded.length})`}><div className="space-y-2">{folded.map(row)}</div></Disclosure> : null}
                    </>;
                  })()}
                  {run.state !== "closed" && !hasOpenAttempt ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                  {run.stageCount ? <RunStages runId={run.id} count={run.stageCount} /> : null}
                </SurfaceBody>
              </Surface>;
            })}
          </div>
          {view === "history" && (ordered.length > runsShown || moreOnServer) ? <Button size="sm" variant="outline" data-testid="runs-show-more" onClick={() => { setRunsShown((count) => count + RUNS_PAGE); if (moreOnServer) void loadMoreRuns(); }}>{t("runsShowMore").replace("{n}", String(Math.min(RUNS_PAGE, Math.max(ordered.length - runsShown, (data?.runsTotal ?? 0) - runsWindow.current))))}</Button> : null}
        </>
      )}
      <p className="sr-only">{[...RUN_STATES, ...ATTEMPT_STATES].join(" ")}</p>
    </>
  );
}

/** Statistics from the recorded tasks: what the checks caught, which pair of provider and model does best, how often work is accepted first time. */
function Analytics({ page }: { page: LpPage }) {
  const { projectId, trackLines } = page;
  if (!projectId) return null;
  return (
    <div className="space-y-6" data-testid="runs-analytics">
      <WriterReuse projectId={projectId} />
      <CriticValue projectId={projectId} />
      <AcceptanceStats projectId={projectId} />
      {trackLines.length > 0 ? (
        <div className="max-w-xl text-xs text-muted-foreground" data-testid="routing-hints">
          <div className="font-medium">{t("routingHintTitle")}</div>
          {trackLines.map((row) => <div key={row.risk}>{row.text}</div>)}
        </div>
      ) : null}
    </div>
  );
}

/** The council's sessions of the project, and the conversation of the one that is open. */
function CouncilSessions({ page }: { page: LpPage }) {
  const { councils, council, councilsAll, setCouncilsAll, openCouncil } = page;
  return (
    <section className="lp-card min-w-0 space-y-2 p-3" data-testid="council-feed" data-bb-ru-skip>
      <h3 className="text-sm font-medium">{t("councilSessions")}</h3>
      {!councils.length ? <p className="text-xs text-muted-foreground">{t("councilEmpty")}</p> : (
        <>
          <ul className="-mx-1 space-y-0.5">
            {(councilsAll ? councils : councils.slice(0, 5)).map((row) => {
              // WebKit ignores line clamping on the button itself, so the clamp sits on an inner span.
              const tone = row.state === "done" ? "success" : row.state === "failed" || row.state === "stopped" ? "danger" : "info";
              return (
                <li key={row.id}>
                  <button type="button" aria-current={council?.id === row.id ? "true" : undefined} className="w-full min-w-0 rounded-lg px-2 py-2 text-left hover:bg-state-hover aria-[current=true]:bg-state-active" onClick={() => openCouncil(row.id)}>
                    <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{row.question}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <Pill tone={tone}>{t(`councilState_${row.state}` as I18nKey) || row.state}</Pill>
                      {t("councilRound")} {row.round}/{row.maxRounds}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {councils.length > 5 ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCouncilsAll((all) => !all)}>{councilsAll ? t("councilShowLess") : t("councilShowAll").replace("{n}", String(councils.length))}</Button> : null}
        </>
      )}
      {council ? (
        <div className="space-y-2 border-t border-[var(--lp-hairline)] pt-2 text-sm" data-testid="council-detail">
          <div className="text-xs text-muted-foreground">{council.seats.map((seat) => `${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join(" · ")}</div>
          {council.agenda.length ? <ol className="list-decimal pl-5 text-xs">{council.agenda.map((item) => <li key={item}>{item}</li>)}</ol> : null}
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {council.messages.map((message) => (
              <div key={message.seq} className="rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-2">
                <div className="text-xs font-medium">{council.seats.find((seat) => seat.id === message.seatId)?.title ?? message.seatId} · {t("councilRound")} {message.round} · {message.kind}</div>
                <div className="whitespace-pre-wrap break-words text-xs">{message.text}</div>
              </div>
            ))}
          </div>
          {council.recommendation ? <div className="text-xs"><span className="font-medium">{t("councilDecision")}: </span>{council.recommendation}{council.decisionPath ? ` (${council.decisionPath})` : ""}</div> : null}
          {council.reason ? <div className="text-xs text-destructive">{council.reason}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
