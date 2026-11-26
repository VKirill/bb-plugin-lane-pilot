import { t } from "@lane-pilot/i18n";
import { AcceptanceCard as RawAcceptanceCard, AcceptanceStats, TaskBoard } from "../../runs/ui";
import { ReturnStage } from "../../stage-return/ui";
import type { ComponentProps } from "react";

const AcceptanceCard = (props: ComponentProps<typeof RawAcceptanceCard>) => <RawAcceptanceCard {...props} ReturnStage={ReturnStage} />;
import { ServiceSegment } from "./service-segment";
import { CriticValue } from "../../critique/ui";
import { WriterReuse } from "../../writer/ui";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "../models/tabs-model";
import type { LpPage } from "./use-lp-page";

/**
 * The project's «Tasks»: the same board as the rail's «Tasks», locked to this project (0.1.470, the owner: one word, one thing); then how the
 * checks and writers did and the machine. The per-run list with its history pages went with it: a task opens on the
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
