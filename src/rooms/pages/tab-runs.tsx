import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { AcceptanceStats, TaskBoard } from "../runs/ui";
import { AcceptanceCard } from "../acceptance/ui";
import { ServiceSegment } from "./service-segment";
import { CriticValue } from "../critique/ui";
import { WriterReuse } from "../writer/ui";
import { Pill } from "../ui-shell/ui";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "./tabs-model";
import type { LpPage } from "./use-lp-page";

/**
 * The project's «Tasks»: the same board as the rail's «Tasks», locked to this project (0.1.470, the owner: one word, one thing); then how the
 * checks and writers did, the council's sessions and the machine. The per-run list with its history pages went with it: a task opens on the
 * board, its stage receipts sit on the task page, «Resume» lives in Maintenance, and a run with no open attempts is closed by the sweep.
 */
export function RunsTab({ page }: { page: LpPage }) {
  const { level, segmentOf, setSegment, tabSelect, activeRuns, isGlobal, projectId, projects, locale } = page;
  const ids = segmentsFor("runs", level);
  const segment = ids.includes(segmentOf("runs")) ? segmentOf("runs") : ids[0]!;
  return (
    <div className="space-y-4" data-testid="run-monitor">
      <Segments testId="runs" label={t("tabRuns")} compact={tabSelect} value={segment} onChange={(next) => setSegment("runs", next)}
        items={ids.map((id) => ({ id, label: t(SEGMENT_LABELS[id]!) }))} badge={{ active: activeRuns }} />
      {isGlobal ? <p className="text-sm text-muted-foreground" data-testid="runs-global-empty">{t("runsGlobalEmpty")}</p> : (
        <>
          {segment === "board" && projectId ? <TaskBoard projects={projects} lockedProjectId={projectId} locale={locale} AcceptanceCard={AcceptanceCard} /> : null}
          {segment === "analytics" ? <Analytics page={page} /> : null}
          {segment === "council" ? <CouncilSessions page={page} /> : null}
          {segment === "service" ? <div className="space-y-5" data-testid="service-panel"><ServiceSegment page={page} /></div> : null}
        </>
      )}
    </div>
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
