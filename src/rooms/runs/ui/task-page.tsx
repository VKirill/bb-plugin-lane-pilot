import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { CHECK_STAGE_IDS, OPEN_ATTEMPT_STATES } from "@lane-pilot/contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, ConfirmDialog, Disclosure, Icon, Input } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { WorkBreakdown } from "../../work-graph/ui";
import { RunStages } from "./run-parts";
import {
  RailRow,
  StageRail,
  TaskDiff,
  TaskSection,
  ThreadRow,
  WorkFileLine,
  countLiveThreads,
} from "./task-page-parts";
import {
  KindChip,
  StatusIcon,
  ago,
  areaLabel,
  attemptState,
  chip,
  fill,
  reasonText,
  runState,
  shortModel,
  shortTaskId,
  stageName,
  stageState,
  type AcceptanceCardView,
  type BoardColumn,
  type TaskBoardItem,
  type TaskCardData,
} from "./task-shared";
import { WorkflowRunSteps } from "./workflow-run-steps";

const OPEN_STATES = new Set<string>(OPEN_ATTEMPT_STATES);

function deriveBoardStatus(card: TaskCardData): { column: BoardColumn; phase: TaskBoardItem["phase"] } {
  if (card.kind === "workflow") {
    if (card.state === "running") return { column: "running", phase: "chain" };
    if (card.state === "waiting") return { column: "queued", phase: "chain" };
    if (card.state === "succeeded" || card.state === "canceled") {
      return { column: "done", phase: card.state === "canceled" ? "canceled" : "chain" };
    }
    return { column: "blocked", phase: "chain" };
  }
  if (card.state === "accepted") return { column: "done", phase: "accepted" };
  if (card.state === "canceled") return { column: "done", phase: "canceled" };
  if (card.state === "queued") return { column: "queued", phase: "queued" };
  if (OPEN_STATES.has(card.state)) {
    const checking = card.stages.some((stage) => CHECK_STAGE_IDS.has(stage.id as never) && stage.state === "running");
    return checking ? { column: "checking", phase: "checking" } : { column: "running", phase: "writing" };
  }
  return { column: "blocked", phase: card.state === "blocked" ? "blocked" : "stuck" };
}

export interface TaskPageProps {
  runId: string;
  taskId: string | null;
  item?: TaskBoardItem;
  locale: string;
  projectName?: string;
  projects?: ReadonlyArray<{ id: string; name: string }>;
  onBack: () => void;
  AcceptanceCard: AcceptanceCardView;
}

const finished = (state: string) => state === "accepted" || state === "succeeded";

/** P6 Task page: stage rail at top, acceptance & threads right, breakdown, diff, files & stage receipts below. */
export function TaskPage({ runId, taskId, item, locale, projectName, projects = [], onBack, AcceptanceCard }: TaskPageProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const cardTaskId = item ? item.taskId : taskId && taskId !== runId ? taskId : null;
  const [card, setCard] = useState<TaskCardData | null | "gone">(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNote, setCancelNote] = useState("");

  const read = useCallback(() => {
    void rpc.call("task_card", { runId, taskId: cardTaskId })
      .then((result) => setCard(result ?? "gone"))
      .catch(() => setCard("gone"));
  }, [rpc, runId, cardTaskId]);

  useEffect(() => {
    read();
  }, [read]);

  const resolved = card && card !== "gone" ? card : null;
  const derived = resolved ? deriveBoardStatus(resolved) : item ? { column: item.column, phase: item.phase } : { column: "queued" as BoardColumn, phase: "queued" as const };
  const activeAttemptId = resolved?.attempts.at(-1)?.id ?? item?.attemptId ?? null;
  const isTask = (resolved?.kind ?? item?.kind) === "task" && cardTaskId !== null;
  const canStop = isTask && ["queued", "running", "checking"].includes(derived.column) && activeAttemptId !== null;
  const canRetry = isTask && derived.column === "blocked" && activeAttemptId !== null;
  const resolvedProjectId = resolved?.projectId ?? item?.projectId ?? null;
  const resolvedProjectName = projectName ?? (resolvedProjectId ? projects.find((project) => project.id === resolvedProjectId)?.name ?? resolvedProjectId : "—");
  const updatedMs = item?.updatedAt ?? resolved?.attempts.at(-1)?.updatedAt ?? resolved?.stages.at(-1)?.updatedAt ?? 0;
  const attemptNo = resolved?.attempts.at(-1)?.no ?? item?.attemptNo ?? null;

  const openCancelDialog = () => {
    setCancelNote("");
    setCancelOpen(true);
  };

  const handleCancelConfirm = async () => {
    if (!activeAttemptId) return;
    const note = cancelNote.trim();
    if (note.length > 0 && note.length < 3) {
      throw new Error(t("consoleTaskCancelNoteTooShort"));
    }
    const result = await rpc.call("cancel_attempt", {
      attemptId: activeAttemptId,
      ...(note ? { note } : {}),
    });
    if (!result.ok) {
      throw new Error(result.reason ?? t("consoleTaskActionFailed"));
    }
    setCancelNote("");
    read();
  };

  const handleRetry = () => {
    if (!activeAttemptId) return;
    void rpc.call("retry_attempt", { attemptId: activeAttemptId }).then(read);
  };

  const breadId = cardTaskId ? shortTaskId(cardTaskId) : t("boardChain");
  const subtitleParts = [
    resolvedProjectName !== "—" ? resolvedProjectName : null,
    resolved?.area ? areaLabel(resolved.area) : null,
    attemptNo ? fill("consoleTaskAttemptN", { n: attemptNo }) : null,
    updatedMs ? ago(updatedMs, locale) : null,
  ].filter(Boolean);

  return (
    <div className="space-y-3" data-testid="task-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" onClick={onBack} data-testid="board-back" className="text-muted-foreground hover:text-foreground">{t("navTasks")}</button>
        <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" />
        <span className="font-medium tabular-nums">{breadId}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          {canRetry ? <Button size="sm" variant="outline" onClick={handleRetry}>{t("retry")}</Button> : null}
          {canStop ? <Button size="sm" variant="destructive" data-testid="task-cancel-btn" onClick={openCancelDialog}>{t("cancel")}</Button> : null}
          <Button size="sm" variant="outline" onClick={onBack}>{t("boardBack")}</Button>
        </span>
      </div>

      {card === null ? (
        <p className="text-sm text-muted-foreground">{t("boardLoading")}</p>
      ) : card === "gone" ? (
        <p className="text-sm text-muted-foreground">{t("boardGone")}</p>
      ) : (
        <div className="@container rounded-lg bg-[var(--lp-well,transparent)] p-2">
          <div className="rounded-lg border border-border bg-card p-5 shadow-2xs @3xl:p-7">
            <div>
              {card.objective ? (
                <div className="mb-3">
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs">
                    {t("boardGoal")}<span className="min-w-0 truncate font-medium text-foreground">{card.objective}</span>
                  </span>
                </div>
              ) : null}
              <h1 className="text-2xl font-semibold leading-tight">{card.title}</h1>
              {subtitleParts.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">{subtitleParts.join(" · ")}</p>
              ) : null}
              <StageRail card={card} />
            </div>

            <div className="mt-5 grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_23rem]">
              <div className="min-w-0 space-y-6">
                {card.reason && !finished(card.state) ? (
                  <p className="whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{card.reason}</p>
                ) : null}
                {card.contract?.dependsOn.length ? (
                  <TaskSection title={t("boardDepends")}>
                    <div className="flex flex-wrap gap-1.5">
                      {card.contract.dependsOn.map((id) => <span key={id} className={chip} title={id}>{shortTaskId(id)}</span>)}
                    </div>
                  </TaskSection>
                ) : null}
                {card.kind === "task" && cardTaskId ? (
                  <TaskSection title={t("graphTitle")}>
                    <WorkBreakdown runId={runId} taskId={cardTaskId} locale={locale} />
                  </TaskSection>
                ) : null}
                {card.kind === "task" && cardTaskId ? null : card.stages.length ? (
                  <TaskSection title={card.kind === "workflow" ? t("boardSteps") : t("boardProgress")}>
                    <ol className="relative space-y-0 border-l border-border pl-4" data-testid="task-card-stages">
                      {card.stages.map((stage, index) => (
                        <li key={`${stage.id}:${index}`} className="relative pb-2.5">
                          <span aria-hidden className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-card ${stage.state === "passed" || stage.state === "succeeded" ? "bg-[var(--color-success,#16a34a)]" : stage.state === "running" ? "animate-pulse bg-[var(--color-attention,#d97706)]" : stage.state === "failed" || stage.state === "blocked" ? "bg-destructive" : "bg-muted-foreground/40"}`} />
                          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span className="font-medium">{stage.title ?? stageName(stage.id)}</span>
                            <span className="text-xs text-muted-foreground">{stageState(stage.state)}</span>
                            {stage.model ? <span className="text-xs text-muted-foreground">{shortModel(stage.model)}</span> : null}
                            {stage.updatedAt ? <span className="text-xs text-muted-foreground">{ago(stage.updatedAt, locale)}</span> : null}
                          </div>
                          {stage.reason ? <div className="mt-0.5 break-words text-xs text-muted-foreground">{reasonText(stage.reason)}</div> : null}
                        </li>
                      ))}
                    </ol>
                    {card.kind === "workflow" ? <WorkflowRunSteps runId={runId} locale={locale} /> : null}
                  </TaskSection>
                ) : null}
                {card.attempts.length > 1 ? (
                  <TaskSection title={t("boardAttempts")}>
                    <div className="space-y-1">
                      {card.attempts.map((attempt) => (
                        <div key={attempt.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                          <span className="tabular-nums text-muted-foreground">#{attempt.no}</span>
                          <span>{attemptState(attempt.state)}</span>
                          <span className="text-xs text-muted-foreground">{ago(attempt.updatedAt, locale)}</span>
                          {attempt.reason ? <span className="w-full break-words text-xs text-muted-foreground">{attempt.reason}</span> : null}
                        </div>
                      ))}
                    </div>
                  </TaskSection>
                ) : null}
                {card.attempts.length ? (
                  <TaskSection title={t("boardDiff")}>
                    <TaskDiff attemptId={([...card.attempts].reverse().find((attempt) => attempt.state === "accepted") ?? card.attempts[card.attempts.length - 1]!).id} />
                  </TaskSection>
                ) : null}
                {card.contract && (card.contract.ownsPaths.length || card.contract.expectedOutputs.length || card.contract.checks.length) ? (
                  <TaskSection title={t("boardFiles")}>
                    <Disclosure compact testId="task-files" summary={`${card.contract.ownsPaths.length + card.contract.expectedOutputs.length} · ${card.contract.checks.length}`}>
                      <div className="space-y-3 text-xs">
                        {[[t("boardOwns"), card.contract.ownsPaths], [t("boardOutputs"), card.contract.expectedOutputs], [t("boardChecks"), card.contract.checks]].map(([title, rows]) =>
                          (rows as string[]).length ? (
                            <div key={title as string}>
                              <div className="mb-1 font-semibold text-muted-foreground">{title as string}</div>
                              <ul className="space-y-0.5 font-mono">
                                {(rows as string[]).map((row) => <WorkFileLine key={row} runId={runId} path={row} />)}
                              </ul>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </Disclosure>
                  </TaskSection>
                ) : null}
                {card.plan ? (
                  <TaskSection title={t("boardPlan")}>
                    <Disclosure compact testId="task-plan" summary={card.plan.split("\n").find((line) => line.trim())?.slice(0, 80) ?? ""}>
                      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs">{card.plan}</pre>
                    </Disclosure>
                  </TaskSection>
                ) : null}
                {card.kind !== "workflow" && card.stages.length ? (
                  <RunStages runId={runId} count={card.stages.length} />
                ) : null}
              </div>

              <div className="min-w-0 space-y-6">
                {card.kind === "task" && cardTaskId ? (
                  <AcceptanceCard
                    runId={runId}
                    taskId={cardTaskId}
                    refreshKey={card}
                    finished={finished(card.state)}
                    fallback={card.contract ? { objective: card.contract.objective, acceptance: card.contract.acceptance } : null}
                    onStop={canStop ? openCancelDialog : null}
                    className=""
                  />
                ) : null}
                <TaskSection title={t("boardThreads")} extra={card.threads && countLiveThreads(card.threads) ? fill("boardWorkingNow", { n: countLiveThreads(card.threads) }) : undefined}>
                  {card.threads ? <ThreadRow node={card.threads} depth={0} /> : <p className="text-sm text-muted-foreground">{t("boardNoThreads")}</p>}
                </TaskSection>
                <aside className="rounded-lg border border-border bg-card p-3.5" data-testid="task-rail">
                  <RailRow label={t("boardStatus")}>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusIcon column={derived.column} phase={derived.phase} />
                      {card.kind === "workflow" ? runState(card.state) : t(`phase_${derived.phase}` as I18nKey)}
                    </span>
                  </RailRow>
                  <RailRow label={t("boardKind")}><KindChip kind={card.taskKind} /></RailRow>
                  {card.area ? <RailRow label={t("boardArea")}>{areaLabel(card.area)}</RailRow> : null}
                  <RailRow label={t("boardProject")}>{resolvedProjectName}</RailRow>
                  {card.pmThreadId ? (
                    <RailRow label={t("boardChat")}>
                      <button type="button" className="text-left underline decoration-input underline-offset-2 hover:decoration-current" onClick={() => navigate.toThread(card.pmThreadId!)}>
                        {item?.pmThreadTitle ?? t("boardOpenChat")}
                      </button>
                    </RailRow>
                  ) : null}
                  {card.attempts.length ? <RailRow label={t("boardAttempts")}>{card.attempts.length}</RailRow> : null}
                  {updatedMs ? <RailRow label={t("boardUpdated")}>{ago(updatedMs, locale)}</RailRow> : null}
                  {card.techTitle ? <RailRow label={t("boardTechTitle")}><span className="text-xs text-muted-foreground">{card.techTitle}</span></RailRow> : null}
                  <RailRow label="ID"><span className="break-all font-mono text-xs text-muted-foreground">{card.id}</span></RailRow>
                </aside>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(next) => { if (!next) setCancelOpen(false); }}
        title={t("consoleTaskConfirmCancelTitle")}
        tone="danger"
        confirmLabel={t("consoleTaskConfirmCancelAction")}
        cancelLabel={t("consoleTaskKeepRunning")}
        onConfirm={handleCancelConfirm}
        body={
          <div className="space-y-3">
            <p>{t("consoleTaskConfirmCancelBody")}</p>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("consoleTaskCancelNoteLabel")}</span>
              <Input
                value={cancelNote}
                onChange={(event) => setCancelNote(event.target.value)}
                placeholder={t("boardCancelNote")}
                data-testid="board-cancel-note"
                autoFocus
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
