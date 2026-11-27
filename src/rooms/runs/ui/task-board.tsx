import { useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Icon, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, useMediaQuery } from "@lane-pilot/ui-kit";
import { StageModelStats, StageStrip, useStageStrips } from "../../work-graph/ui";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { TaskPage } from "./task-page";
import {
  KindChip,
  StatusIcon,
  ago,
  areaLabel,
  chip,
  fill,
  shortModel,
  shortTaskId,
  stageName,
  type AcceptanceCardView,
  type BoardColumn,
  type TaskBoardItem,
} from "./task-shared";

export { StatusIcon, shortTaskId, type AcceptanceCardView } from "./task-shared";
export { TaskPage } from "./task-page";

type Item = TaskBoardItem;
type Column = BoardColumn;
type GroupBy = "goal" | "chat" | "area" | "project" | "none";

/**
 * The «Tasks» screen, built after the BB Tasks plugin the owner liked (its board, list and task page; retired 2026-10-12): every
 * Lane Pilot task and chain of one project or of all, as a board of fixed columns that scrolls sideways or as a list grouped by
 * goal, chat, area or project. A task opens on its own page: goal chip, title, description and acceptance, progress by stage,
 * the threads that worked on it (PM, writers, critics and specialists, their sub-agents) and a properties rail.
 */
const COLUMNS: Array<{ id: Column; label: I18nKey }> = [
  { id: "queued", label: "boardColQueued" },
  { id: "running", label: "boardColRunning" },
  { id: "checking", label: "boardColChecking" },
  { id: "blocked", label: "boardColBlocked" },
  { id: "done", label: "boardColDone" },
];
const POLL_MS = 8_000;

/** The one line that says where the work is: a live dot with the stage and model while an agent works, what it waits for, why it stopped. */
function PhaseLine({ item, locale }: { item: Item; locale: string }) {
  const live = item.phase === "writing" || item.phase === "checking" || item.phase === "planning" || (item.phase === "chain" && item.column === "running");
  const what = item.phase === "waiting" && item.waitingFor.length
    ? fill("boardWaitsFor", { ids: item.waitingFor.map(shortTaskId).join(", ") })
    : item.stage && item.phase !== "writing"
      ? stageName(item.stage)
      : t(`phase_${item.phase}` as I18nKey);
  const extra = [shortModel(item.model), item.since ? ago(item.since, locale) : null].filter(Boolean).join(" · ");
  return (
    <span className={`flex min-w-0 items-center gap-1 ${live ? "font-medium text-[var(--color-success,#16a34a)]" : item.column === "blocked" ? "text-destructive" : "text-muted-foreground"}`}>
      {live ? <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-success,#16a34a)]" /> : null}
      <span className="truncate">{what}{extra ? ` · ${extra}` : ""}</span>
    </span>
  );
}

function TaskCardTile({
  item,
  showProject,
  projectName,
  locale,
  onOpen,
}: {
  item: Item;
  showProject: boolean;
  projectName: string | null;
  locale: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={item.kind === "batch" && !item.pmThreadId}
      data-testid={`board-card-${item.key}`}
      title={item.techTitle ?? item.taskId ?? item.title}
      className="block w-full shrink-0 cursor-pointer rounded-lg border border-border bg-card px-2.5 py-2 text-left shadow-2xs hover:border-input disabled:cursor-default"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{item.taskId ? shortTaskId(item.taskId) : t("boardChain")}</span>
        <PhaseLine item={item} locale={locale} />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{item.title}</div>
      {item.held ? <div className="mt-1 text-xs font-medium text-destructive">{t("boardHeld")}</div> : null}
      {item.gates?.some((gate) => !gate.ok) ? (
        <div
          className="mt-1 line-clamp-1 text-xs text-destructive"
          title={item.gates.filter((gate) => !gate.ok).flatMap((gate) => gate.why).join("; ")}
        >
          {fill("boardGates", { names: item.gates.filter((gate) => !gate.ok).map((gate) => t(`boardGate_${gate.name}` as I18nKey)).join(", ") })}
        </div>
      ) : null}
      {item.column === "blocked" && item.detail ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div> : null}
      {item.kind === "phase" && item.detail && item.column !== "blocked" ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {item.kind === "phase" ? <span className={chip}>{t("boardKindPhase")}</span> : item.kind === "batch" ? <span className={chip}>{t("boardKindBatch")}</span> : <KindChip kind={item.taskKind} />}
        {item.wave ? <span className={chip}>{fill("boardWave", { n: item.wave.n, m: item.wave.m })}</span> : null}
        {item.area ? <span className={chip}>{areaLabel(item.area)}</span> : null}
        {showProject && projectName ? <span className={chip}>{projectName}</span> : null}
        {item.attemptNo > 1 ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground" title={fill("boardAttemptsN", { n: item.attemptNo })}>
            <Icon name="RefreshCw" className="size-3" />{item.attemptNo}
          </span>
        ) : null}
        {item.column === "done" ? <span className="ml-auto text-[11px] text-muted-foreground">{ago(item.updatedAt, locale)}</span> : null}
      </div>
    </button>
  );
}

function groupOf(item: Item, by: GroupBy, projectName: (id: string | null) => string): { key: string; title: string } {
  if (by === "goal") {
    return item.objective
      ? { key: `goal:${item.runId}`, title: item.objective }
      : item.pmThreadTitle
        ? { key: `chat:${item.pmThreadId}`, title: item.pmThreadTitle }
        : { key: "none", title: t("boardNoGroup") };
  }
  if (by === "chat") {
    return { key: `chat:${item.pmThreadId ?? "-"}`, title: item.pmThreadTitle ?? (item.kind === "workflow" ? t("boardKindFlows") : t("boardNoGroup")) };
  }
  if (by === "area") return item.area ? { key: `area:${item.area}`, title: areaLabel(item.area) } : { key: "none", title: t("boardNoGroup") };
  if (by === "project") return { key: `project:${item.projectId ?? "-"}`, title: projectName(item.projectId) };
  return { key: "all", title: "" };
}

export function TaskBoard({
  projects = [],
  serviceProjectIds = [],
  initialProjectId = null,
  lockedProjectId = null,
  locale,
  AcceptanceCard,
  onOpen,
}: {
  projects?: ReadonlyArray<{ id: string; name: string }>;
  serviceProjectIds?: readonly string[];
  initialProjectId?: string | null;
  /** The project's own tab: the board of this project only, without the project switch and the title the tab already carries. */
  lockedProjectId?: string | null;
  locale: string;
  AcceptanceCard: AcceptanceCardView;
  /** When set, clicking a task or workflow card delegates navigation to the caller instead of opening local state. */
  onOpen?: (item: Item) => void;
}) {
  const navigate = useBbNavigate();
  const locked = lockedProjectId != null;
  // On a phone the fixed columns hide all but one: the board opens as the list and stacks at full width (SMA m_wnr_tasks).
  const narrow = useMediaQuery("(max-width: 639px)");
  const [projectId, setProjectId] = useState<string>(lockedProjectId ?? initialProjectId ?? "all");
  const [kind, setKind] = useState<"all" | "task" | "workflow" | "phase">("all");
  const [view, setView] = useState<"board" | "list" | "stats">(narrow ? "list" : "board");
  const [groupBy, setGroupBy] = useState<GroupBy>("goal");
  const [doneHours, setDoneHours] = useState(24);
  const [drills, setDrills] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Item | null>(null);
  const board = useLpRpcQuery("task_board", { ...(projectId === "all" ? {} : { projectId }), doneHours }, { pollMs: POLL_MS });
  const items = (board.data as { items?: Item[] } | undefined)?.items ?? null;
  const offline = board.error != null;
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const service = useMemo(() => new Set(serviceProjectIds), [serviceProjectIds]);
  const projectName = (id: string | null) => (id ? names.get(id) ?? id : "—");
  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      (drills || projectId !== "all" || !item.projectId || !service.has(item.projectId)) &&
      (!needle || [item.title, item.techTitle ?? "", item.taskId ?? "", item.area ?? ""].some((value) => value.toLowerCase().includes(needle))),
  );

  if (open) {
    return (
      <TaskPage
        runId={open.runId}
        taskId={open.taskId}
        item={open}
        locale={locale}
        projectName={projectName(open.projectId)}
        projects={projects}
        onBack={() => setOpen(null)}
        AcceptanceCard={AcceptanceCard}
      />
    );
  }
  const showProject = projectId === "all";
  const openItem = (item: Item) => {
    if (item.kind === "phase") { navigate.toPluginPanel("lane-pilot"); return; }
    if (item.kind === "batch") { if (item.pmThreadId) navigate.toThread(item.pmThreadId); return; }
    if (onOpen) { onOpen(item); return; }
    setOpen(item);
  };
  const tile = (item: Item) => (
    <TaskCardTile key={item.key} item={item} showProject={showProject} projectName={projectName(item.projectId)} locale={locale} onOpen={() => openItem(item)} />
  );
  return (
    <div className="space-y-3" data-testid="task-board">
      <div className="flex flex-wrap items-end justify-between gap-2">
        {locked ? (
          <span className="text-sm text-muted-foreground" data-testid="board-count">{shown.length}</span>
        ) : (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t("navTasks")} <span className="text-sm font-normal text-muted-foreground">{shown.length}</span></h2>
            <p className="text-sm text-muted-foreground">{t("boardHelp")}</p>
          </div>
        )}
        <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" data-testid="board-view">
          {(["board", "list", "stats"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              data-testid={`board-view-${id}`}
              className={`rounded px-2.5 py-1 text-xs ${view === id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t(id === "board" ? "boardViewBoard" : id === "list" ? "boardViewList" : "graphViewStats")}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {locked ? null : (
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-8 w-full sm:w-48" data-testid="board-project"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("boardAllProjects")}</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={kind} onValueChange={(next) => setKind(next as typeof kind)}>
          <SelectTrigger className="h-8 w-full sm:w-40" data-testid="board-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("boardAllKinds")}</SelectItem>
            <SelectItem value="task">{t("boardKindTasks")}</SelectItem>
            <SelectItem value="workflow">{t("boardKindFlows")}</SelectItem>
            <SelectItem value="phase">{t("boardKindPhases")}</SelectItem>
          </SelectContent>
        </Select>
        {view === "list" ? (
          <Select value={groupBy} onValueChange={(next) => setGroupBy(next as GroupBy)}>
            <SelectTrigger className="h-8 w-full sm:w-36" data-testid="board-group"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="goal">{t("boardGroupGoal")}</SelectItem>
              <SelectItem value="chat">{t("boardGroupChat")}</SelectItem>
              <SelectItem value="area">{t("boardGroupArea")}</SelectItem>
              <SelectItem value="project">{t("boardGroupProject")}</SelectItem>
              <SelectItem value="none">{t("boardGroupNone")}</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Select value={String(doneHours)} onValueChange={(next) => setDoneHours(Number(next))}>
          <SelectTrigger className="h-8 w-full sm:w-52" data-testid="board-done"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="24">{t("boardDone24")}</SelectItem>
            <SelectItem value="168">{t("boardDone7")}</SelectItem>
          </SelectContent>
        </Select>
        <Input className="h-8 w-full sm:w-52" placeholder={t("boardSearch")} value={query} onChange={(event) => setQuery(event.target.value)} data-testid="board-search" />
        {showProject ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={drills} onCheckedChange={setDrills} data-testid="board-drills" />{t("boardShowDrills")}
          </label>
        ) : null}
      </div>
      {offline && view !== "stats" ? <p role="status" data-testid="board-offline" className="text-sm text-muted-foreground">{t(items === null ? "boardLoadFailed" : "boardStale")}</p> : null}
      {view === "stats" ? (
        <StageModelStats locale={locale} projectId={projectId === "all" ? undefined : projectId} excludeProjectIds={drills ? [] : serviceProjectIds} />
      ) : items === null ? (
        offline ? null : <p className="text-sm text-muted-foreground">{t("boardLoading")}</p>
      ) : view === "board" ? (
        <div className={narrow ? "flex flex-col gap-3" : "-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-3"} data-testid="board-columns" data-narrow={narrow || undefined}>
          {COLUMNS.map((column) => {
            const cards = shown.filter((item) => item.column === column.id);
            return (
              <section key={column.id} className={narrow ? "flex w-full flex-col" : "flex w-[264px] shrink-0 flex-col"} data-testid={`board-col-${column.id}`}>
                <div className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold">
                  <StatusIcon column={column.id} />
                  <span>{t(column.label)}</span>
                  <span className="font-normal text-muted-foreground">{cards.length}</span>
                </div>
                <div className="flex min-h-16 flex-col gap-2 rounded-lg bg-[var(--lp-well,transparent)] p-1">
                  {cards.length ? cards.map(tile) : <p className="px-1.5 py-2 text-xs text-muted-foreground">{t("boardEmptyColumn")}</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <TaskList items={shown} groupBy={groupBy} projectName={projectName} showProject={showProject} locale={locale} onOpen={openItem} />
      )}
    </div>
  );
}

const ORDER: Record<Column, number> = { running: 0, checking: 1, blocked: 2, queued: 3, done: 4 };

function TaskList({
  items,
  groupBy,
  projectName,
  showProject,
  locale,
  onOpen,
}: {
  items: Item[];
  groupBy: GroupBy;
  projectName: (id: string | null) => string;
  showProject: boolean;
  locale: string;
  onOpen: (item: Item) => void;
}) {
  const groups = new Map<string, { title: string; items: Item[] }>();
  for (const item of items) {
    const group = groupOf(item, groupBy, projectName);
    groups.set(group.key, { title: group.title, items: [...(groups.get(group.key)?.items ?? []), item] });
  }
  const ordered = [...groups].sort(([, a], [, b]) => Math.min(...a.items.map((item) => ORDER[item.column])) - Math.min(...b.items.map((item) => ORDER[item.column])));
  const strips = useStageStrips(items.flatMap((item) => (item.kind === "task" && item.taskId ? [{ runId: item.runId, taskId: item.taskId }] : [])));
  return (
    <div className="@container overflow-hidden rounded-lg border border-border bg-card" data-testid="board-list">
      {ordered.map(([key, group]) => {
        const done = group.items.filter((item) => item.column === "done").length;
        const stuck = group.items.filter((item) => item.column === "blocked").length;
        return (
          <section key={key} data-testid={`board-group-${key}`}>
            {groupBy !== "none" ? (
              <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{group.title}</span>
                <span className="shrink-0 text-muted-foreground">{fill("boardGroupSummary", { n: group.items.length, done, stuck })}</span>
              </div>
            ) : null}
            {[...group.items].sort((a, b) => ORDER[a.column] - ORDER[b.column] || b.updatedAt - a.updatedAt).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpen(item)}
                data-testid={`board-row-${item.key}`}
                title={item.techTitle ?? item.taskId ?? ""}
                className="flex min-h-[34px] w-full items-center gap-2 border-b border-border/60 px-3.5 py-1 text-left text-sm last:border-b-0 hover:bg-state-hover"
              >
                <StatusIcon column={item.column} phase={item.phase} />
                <span className="w-16 shrink-0 truncate text-xs tabular-nums text-muted-foreground">{item.taskId ? shortTaskId(item.taskId) : t("boardChain")}</span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.taskId && strips[`${item.runId}:${item.taskId}`] ? (
                  <span className="hidden shrink-0 @lg:inline-flex"><StageStrip cells={strips[`${item.runId}:${item.taskId}`]!.cells} testId={`board-strip-${item.key}`} /></span>
                ) : null}
                <span className="hidden max-w-[40%] shrink-0 items-center gap-1.5 text-xs @xl:flex"><PhaseLine item={item} locale={locale} /></span>
                <span className="hidden shrink-0 @lg:inline-flex"><KindChip kind={item.taskKind} /></span>
                {showProject ? <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @2xl:inline">{projectName(item.projectId)}</span> : null}
                <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{ago(item.updatedAt, locale)}</span>
              </button>
            ))}
          </section>
        );
      })}
      {!items.length ? <p className="p-4 text-sm text-muted-foreground">{t("boardEmptyColumn")}</p> : null}
    </div>
  );
}
