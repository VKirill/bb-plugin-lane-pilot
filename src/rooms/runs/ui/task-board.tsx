import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, Disclosure, Icon, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "@lane-pilot/ui-kit";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { AcceptanceCard } from "../../acceptance/ui";
type Board = z.infer<(typeof rpcContract)["task_board"]["output"]>;
type Card = NonNullable<z.infer<(typeof rpcContract)["task_card"]["output"]>>;
type Item = Board["items"][number];
type Thread = NonNullable<Card["threads"]>;
type Column = Item["column"];
type GroupBy = "goal" | "chat" | "area" | "project" | "none";

/**
 * The «Tasks» screen, built after the BB Tasks plugin the owner liked (its board, list and task page; retired 2026-10-12): every
 * Lane Pilot task and chain of one project or of all, as a board of fixed columns that scrolls sideways or as a list grouped by
 * goal, chat, area or project. A task opens on its own page: goal chip, title, description and acceptance, progress by stage,
 * the threads that worked on it (PM, writers, critics and specialists, their sub-agents) and a properties rail.
 */
const COLUMNS: Array<{ id: Column; label: I18nKey }> = [
  { id: "queued", label: "boardColQueued" }, { id: "running", label: "boardColRunning" }, { id: "checking", label: "boardColChecking" },
  { id: "blocked", label: "boardColBlocked" }, { id: "done", label: "boardColDone" },
];
const POLL_MS = 8_000;
const KIND_COLOR: Record<NonNullable<Item["taskKind"]>, string> = {
  feature: "#8b5cf6", fix: "#ef4444", check: "#0ea5e9", docs: "#64748b", refactor: "#f59e0b", research: "#10b981", chore: "#94a3b8",
};
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const stageName = (id: string) => { const key = `stage_${id.replace(/-/g, "_")}` as I18nKey; const text = t(key); return text === key ? id : text; };
const stageState = (state: string) => { const key = `stage_state_${state}` as I18nKey; const text = t(key); return text === key ? state : text; };
const attemptState = (state: string) => { const key = `attempt_${state}` as I18nKey; const text = t(key); return text === key ? state : text; };
/** Reasons Lane Pilot writes as codes read as words; anything else (a check's output, a writer's question) stays as written. */
const reasonText = (reason: string | null) => reason === "disabled_by_project_setting" ? t("reason_disabled_by_setting") : reason;
const roleName = (role: string) => role === "PM" ? t("role_pm") : role === "sub-agent" ? t("role_subagent")
  : role.startsWith("writer#") ? fill("role_writer", { n: role.slice(7) }) : stageName(role);
/** `ck-24-ui-pages-orders.2` reads as `ck-24.2`, like a tracker key; the full id is in the tooltip. */
export function shortTaskId(id: string): string {
  const redo = /(\.\d+)+$/.exec(id)?.[0] ?? "";
  const base = id.slice(0, id.length - redo.length);
  const keyed = /^([a-z]{1,6}-\d{1,4})(?:-|$)/i.exec(base);
  return `${keyed ? keyed[1] : base.length > 18 ? `${base.slice(0, 16)}…` : base}${redo}`;
}
const areaLabel = (area: string) => area.replace(/^(feature|page|area):/, "");
function ago(ms: number | null, locale: string, now = Date.now()): string {
  if (!ms || ms < 1e11) return "";
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return t("boardJustNow");
  if (minutes < 60) return fill("boardMinAgo", { n: minutes });
  if (minutes < 24 * 60) return fill("boardHourAgo", { n: Math.round(minutes / 60) });
  return new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const shortModel = (model: string | null) => (model ? model.replace(/^claude-/, "").replace(/^(gpt|gemini|grok)-/, "$1 ").replace(/\[.*\]$/, "") : null);

/** The BB Tasks status rings: an empty ring waits, a half ring works, a three-quarter ring is checked, a filled check is done. */
export function StatusIcon({ column, phase, className = "" }: { column: Column; phase?: Item["phase"]; className?: string }) {
  const tone = column === "running" ? "text-[var(--color-attention,#d97706)]" : column === "checking" ? "text-[var(--color-timeline-accent,#7c3aed)]"
    : column === "blocked" ? "text-destructive" : column === "done" ? (phase === "canceled" ? "text-muted-foreground" : "text-[var(--color-success,#16a34a)]") : "text-muted-foreground";
  const ring = <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" />;
  return (
    <svg viewBox="0 0 14 14" aria-hidden data-status-icon={column} className={`size-3.5 shrink-0 ${tone} ${className}`}>
      {column === "queued" ? <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={phase === "waiting" ? "1.8 2" : undefined} /> : null}
      {column === "running" ? <>{ring}<path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" /></> : null}
      {column === "checking" ? <>{ring}<path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 2.4 7 Z" fill="currentColor" /></> : null}
      {column === "blocked" ? <>{ring}<path d="M7 4 v3.6 M7 9.6 v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></> : null}
      {column === "done" && phase !== "canceled" ? <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.4 7.2 l1.8 1.8 3.4-3.8" stroke="var(--background,#fff)" strokeWidth="1.5" fill="none" strokeLinecap="round" /></> : null}
      {column === "done" && phase === "canceled" ? <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M5 5 l4 4 M9 5 l-4 4" stroke="var(--background,#fff)" strokeWidth="1.4" strokeLinecap="round" /></> : null}
    </svg>
  );
}

const chip = "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-[11px] leading-5 text-muted-foreground";
function KindChip({ kind }: { kind: Item["taskKind"] }) {
  if (!kind) return <span className={chip}>{t("boardChain")}</span>;
  return <span className={chip} data-kind={kind}><span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: KIND_COLOR[kind] }} />{t(`kind_${kind}` as I18nKey)}</span>;
}

/** The one line that says where the work is: a live dot with the stage and model while an agent works, what it waits for, why it stopped. */
function PhaseLine({ item, locale }: { item: Item; locale: string }) {
  const live = item.phase === "writing" || item.phase === "checking" || item.phase === "planning" || (item.phase === "chain" && item.column === "running");
  const what = item.phase === "waiting" && item.waitingFor.length ? fill("boardWaitsFor", { ids: item.waitingFor.map(shortTaskId).join(", ") })
    : item.stage && item.phase !== "writing" ? stageName(item.stage) : t(`phase_${item.phase}` as I18nKey);
  const extra = [shortModel(item.model), item.since ? ago(item.since, locale) : null].filter(Boolean).join(" · ");
  return (
    <span className={`flex min-w-0 items-center gap-1 ${live ? "font-medium text-[var(--color-success,#16a34a)]" : item.column === "blocked" ? "text-destructive" : "text-muted-foreground"}`}>
      {live ? <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-success,#16a34a)]" /> : null}
      <span className="truncate">{what}{extra ? ` · ${extra}` : ""}</span>
    </span>
  );
}

function TaskCardTile({ item, showProject, projectName, locale, onOpen }: { item: Item; showProject: boolean; projectName: string | null; locale: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} data-testid={`board-card-${item.key}`} title={item.techTitle ?? item.taskId ?? item.title}
      className="block w-full shrink-0 cursor-pointer rounded-lg border border-border bg-card px-2.5 py-2 text-left shadow-2xs hover:border-input">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{item.taskId ? shortTaskId(item.taskId) : t("boardChain")}</span>
        <PhaseLine item={item} locale={locale} />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{item.title}</div>
      {item.column === "blocked" && item.detail ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <KindChip kind={item.taskKind} />
        {item.area ? <span className={chip}>{areaLabel(item.area)}</span> : null}
        {showProject && projectName ? <span className={chip}>{projectName}</span> : null}
        {item.attemptNo > 1 ? <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground" title={fill("boardAttemptsN", { n: item.attemptNo })}><Icon name="RefreshCw" className="size-3" />{item.attemptNo}</span> : null}
        {item.column === "done" ? <span className="ml-auto text-[11px] text-muted-foreground">{ago(item.updatedAt, locale)}</span> : null}
      </div>
    </button>
  );
}

function groupOf(item: Item, by: GroupBy, projectName: (id: string | null) => string): { key: string; title: string } {
  if (by === "goal") return item.objective ? { key: `goal:${item.runId}`, title: item.objective } : item.pmThreadTitle ? { key: `chat:${item.pmThreadId}`, title: item.pmThreadTitle } : { key: "none", title: t("boardNoGroup") };
  if (by === "chat") return { key: `chat:${item.pmThreadId ?? "-"}`, title: item.pmThreadTitle ?? (item.kind === "workflow" ? t("boardKindFlows") : t("boardNoGroup")) };
  if (by === "area") return item.area ? { key: `area:${item.area}`, title: areaLabel(item.area) } : { key: "none", title: t("boardNoGroup") };
  if (by === "project") return { key: `project:${item.projectId ?? "-"}`, title: projectName(item.projectId) };
  return { key: "all", title: "" };
}

export function TaskBoard({ projects = [], serviceProjectIds = [], initialProjectId = null, locale }: {
  projects?: ReadonlyArray<{ id: string; name: string }>; serviceProjectIds?: readonly string[]; initialProjectId?: string | null; locale: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "all");
  const [kind, setKind] = useState<"all" | "task" | "workflow">("all");
  const [view, setView] = useState<"board" | "list">("board");
  const [groupBy, setGroupBy] = useState<GroupBy>("goal");
  const [doneHours, setDoneHours] = useState(24);
  const [drills, setDrills] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void rpc.call("task_board", { ...(projectId === "all" ? {} : { projectId }), doneHours })
      .then((result) => { if (alive) setItems(result.items); }).catch(() => undefined);
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [rpc, projectId, doneHours]);
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const service = useMemo(() => new Set(serviceProjectIds), [serviceProjectIds]);
  const projectName = (id: string | null) => (id ? names.get(id) ?? id : "—");
  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter((item) => (kind === "all" || item.kind === kind)
    && (drills || projectId !== "all" || !item.projectId || !service.has(item.projectId))
    && (!needle || [item.title, item.techTitle ?? "", item.taskId ?? "", item.area ?? ""].some((value) => value.toLowerCase().includes(needle))));

  if (open) return <TaskPage item={open} locale={locale} projectName={projectName(open.projectId)} onBack={() => setOpen(null)} />;
  const showProject = projectId === "all";
  const tile = (item: Item) => <TaskCardTile key={item.key} item={item} showProject={showProject} projectName={projectName(item.projectId)} locale={locale} onOpen={() => setOpen(item)} />;
  return (
    <div className="space-y-3" data-testid="task-board">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t("navTasks")} <span className="text-sm font-normal text-muted-foreground">{shown.length}</span></h2>
          <p className="text-sm text-muted-foreground">{t("boardHelp")}</p>
        </div>
        <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" data-testid="board-view">
          {(["board", "list"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} data-testid={`board-view-${id}`}
              className={`rounded px-2.5 py-1 text-xs ${view === id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {t(id === "board" ? "boardViewBoard" : "boardViewList")}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-8 w-full sm:w-48" data-testid="board-project"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("boardAllProjects")}</SelectItem>
            {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(next) => setKind(next as typeof kind)}>
          <SelectTrigger className="h-8 w-full sm:w-40" data-testid="board-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("boardAllKinds")}</SelectItem>
            <SelectItem value="task">{t("boardKindTasks")}</SelectItem>
            <SelectItem value="workflow">{t("boardKindFlows")}</SelectItem>
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
      {items === null ? <p className="text-sm text-muted-foreground">{t("boardLoading")}</p> : view === "board" ? (
        <div className="-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-3" data-testid="board-columns">
          {COLUMNS.map((column) => {
            const cards = shown.filter((item) => item.column === column.id);
            return (
              <section key={column.id} className="flex w-[264px] shrink-0 flex-col" data-testid={`board-col-${column.id}`}>
                <div className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold">
                  <StatusIcon column={column.id} />
                  <span>{t(column.label)}</span>
                  <span className="font-normal text-muted-foreground">{cards.length}</span>
                </div>
                <div className="flex min-h-16 flex-col gap-2 rounded-lg bg-[var(--lp-well,transparent)] p-1">
                  {cards.length ? cards.slice(0, 120).map(tile) : <p className="px-1.5 py-2 text-xs text-muted-foreground">{t("boardEmptyColumn")}</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <TaskList items={shown} groupBy={groupBy} projectName={projectName} showProject={showProject} locale={locale} onOpen={setOpen} />
      )}
    </div>
  );
}

const ORDER: Record<Column, number> = { running: 0, checking: 1, blocked: 2, queued: 3, done: 4 };

function TaskList({ items, groupBy, projectName, showProject, locale, onOpen }: {
  items: Item[]; groupBy: GroupBy; projectName: (id: string | null) => string; showProject: boolean; locale: string; onOpen: (item: Item) => void;
}) {
  const groups = new Map<string, { title: string; items: Item[] }>();
  for (const item of items) {
    const group = groupOf(item, groupBy, projectName);
    groups.set(group.key, { title: group.title, items: [...(groups.get(group.key)?.items ?? []), item] });
  }
  const ordered = [...groups].sort(([, a], [, b]) => Math.min(...a.items.map((item) => ORDER[item.column])) - Math.min(...b.items.map((item) => ORDER[item.column])));
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
              <button key={item.key} type="button" onClick={() => onOpen(item)} data-testid={`board-row-${item.key}`} title={item.techTitle ?? item.taskId ?? ""}
                className="flex min-h-[34px] w-full items-center gap-2 border-b border-border/60 px-3.5 py-1 text-left text-sm last:border-b-0 hover:bg-state-hover">
                <StatusIcon column={item.column} phase={item.phase} />
                <span className="w-16 shrink-0 truncate text-xs tabular-nums text-muted-foreground">{item.taskId ? shortTaskId(item.taskId) : t("boardChain")}</span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
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

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">{title}{extra ? <span className="font-normal">{extra}</span> : null}</div>
      {children}
    </section>
  );
}

const LIVE_THREAD = new Set(["active", "running", "starting"]);
function ThreadRow({ node, depth }: { node: Thread; depth: number }) {
  const navigate = useBbNavigate();
  const live = LIVE_THREAD.has(node.status ?? "");
  return (
    <>
      {node.id ? (
        <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs" style={{ marginLeft: depth * 16 }} data-testid={`board-thread-${node.id}`}>
          <span className={`flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium ${live ? "text-[var(--color-success,#16a34a)]" : "text-muted-foreground"}`}>
            <span aria-hidden className={`size-1.5 rounded-full ${live ? "animate-pulse bg-[var(--color-success,#16a34a)]" : "bg-muted-foreground/50"}`} />
            <span className="truncate">{node.status ?? "—"}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{node.title ?? node.id}</div>
            <div className="truncate text-xs text-muted-foreground">{roleName(node.role)}</div>
          </div>
          <button type="button" onClick={() => navigate.toThread(node.id)}
            className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current">
            {t("boardOpenThread")}<Icon name="ArrowUpRight" className="size-3" />
          </button>
        </div>
      ) : null}
      {(node.children as Thread[]).map((child) => <ThreadRow key={`${child.role}:${child.id}`} node={child} depth={node.id ? depth + 1 : depth} />)}
    </>
  );
}

function countLive(node: Thread): number {
  return (LIVE_THREAD.has(node.status ?? "") && node.id ? 1 : 0) + (node.children as Thread[]).reduce((sum, child) => sum + countLive(child), 0);
}

function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="py-1"><div className="text-[11px] font-semibold text-muted-foreground">{label}</div><div className="mt-0.5 min-w-0 break-words text-sm">{children}</div></div>;
}

function TaskPage({ item, locale, projectName, onBack }: { item: Item; locale: string; projectName: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [card, setCard] = useState<Card | null | "gone">(null);
  const read = () => void rpc.call("task_card", { runId: item.runId, taskId: item.taskId }).then((result) => setCard(result ?? "gone")).catch(() => setCard("gone"));
  useEffect(read, [rpc, item.runId, item.taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (method: "cancel_attempt" | "retry_attempt") => item.attemptId && void rpc.call(method, { attemptId: item.attemptId }).then(read);
  const finished = (state: string) => state === "accepted" || state === "succeeded";
  const rail = (className: string) => card && card !== "gone" ? (
    <aside className={className} data-testid="task-rail">
      <RailRow label={t("boardStatus")}><span className="inline-flex items-center gap-1.5"><StatusIcon column={item.column} phase={item.phase} />{t(`phase_${item.phase}` as I18nKey)}</span></RailRow>
      <RailRow label={t("boardKind")}><KindChip kind={card.taskKind} /></RailRow>
      {card.area ? <RailRow label={t("boardArea")}>{areaLabel(card.area)}</RailRow> : null}
      <RailRow label={t("boardProject")}>{projectName}</RailRow>
      {card.pmThreadId ? <RailRow label={t("boardChat")}><button type="button" className="text-left underline decoration-input underline-offset-2 hover:decoration-current" onClick={() => navigate.toThread(card.pmThreadId!)}>{item.pmThreadTitle ?? t("boardOpenChat")}</button></RailRow> : null}
      {card.attempts.length ? <RailRow label={t("boardAttempts")}>{card.attempts.length}</RailRow> : null}
      <RailRow label={t("boardUpdated")}>{ago(item.updatedAt, locale)}</RailRow>
      {card.techTitle ? <RailRow label={t("boardTechTitle")}><span className="text-xs text-muted-foreground">{card.techTitle}</span></RailRow> : null}
      <RailRow label="ID"><span className="break-all font-mono text-xs text-muted-foreground">{card.id}</span></RailRow>
    </aside>
  ) : null;
  return (
    <div className="space-y-3" data-testid="task-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" onClick={onBack} data-testid="board-back" className="text-muted-foreground hover:text-foreground">{t("navTasks")}</button>
        <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" />
        <span className="font-medium tabular-nums">{item.taskId ? shortTaskId(item.taskId) : t("boardChain")}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          {item.kind === "task" && ["queued", "running", "checking"].includes(item.column) ? <Button size="sm" variant="outline" onClick={() => act("cancel_attempt")}>{t("cancel")}</Button> : null}
          {item.kind === "task" && item.column === "blocked" ? <Button size="sm" variant="outline" onClick={() => act("retry_attempt")}>{t("retry")}</Button> : null}
          <Button size="sm" variant="outline" onClick={onBack}>{t("boardBack")}</Button>
        </span>
      </div>
      {card === null ? <p className="text-sm text-muted-foreground">{t("boardLoading")}</p> : card === "gone" ? <p className="text-sm text-muted-foreground">{t("boardGone")}</p> : (
        <div className="@container rounded-lg bg-[var(--lp-well,transparent)] p-2">
          <div className="flex items-stretch rounded-lg border border-border bg-card shadow-2xs">
            <div className="mx-auto w-full min-w-0 max-w-[55rem] flex-1 px-5 pb-10 pt-6 @3xl:px-10 @3xl:pt-9">
              {card.objective ? (
                <div className="mb-4">
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs">
                    {t("boardGoal")}<span className="min-w-0 truncate font-medium text-foreground">{card.objective}</span>
                  </span>
                </div>
              ) : null}
              <h1 className="mb-2 text-2xl font-semibold leading-tight">{card.title}</h1>
              {rail("mb-4 grid grid-cols-2 gap-x-4 rounded-md border border-border p-3 @[45rem]:hidden")}
              {card.reason && !finished(card.state) ? <p className="mt-3 whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{card.reason}</p> : null}
              {card.kind === "task" && item.taskId ? (
                <AcceptanceCard runId={item.runId} taskId={item.taskId} refreshKey={card} finished={finished(card.state)}
                  fallback={card.contract ? { objective: card.contract.objective, acceptance: card.contract.acceptance } : null} />
              ) : null}
              {card.contract?.dependsOn.length ? (
                <Section title={t("boardDepends")}>
                  <div className="flex flex-wrap gap-1.5">{card.contract.dependsOn.map((id) => <span key={id} className={chip} title={id}>{shortTaskId(id)}</span>)}</div>
                </Section>
              ) : null}
              {card.stages.length ? (
                <Section title={card.kind === "workflow" ? t("boardSteps") : t("boardProgress")}>
                  <ol className="relative space-y-0 border-l border-border pl-4" data-testid="task-card-stages">
                    {card.stages.map((stage, index) => (
                      <li key={`${stage.id}:${index}`} className="relative pb-2.5">
                        <span aria-hidden className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-card ${stage.state === "passed" || stage.state === "succeeded" ? "bg-[var(--color-success,#16a34a)]" : stage.state === "running" ? "animate-pulse bg-[var(--color-attention,#d97706)]" : stage.state === "failed" || stage.state === "blocked" ? "bg-destructive" : "bg-muted-foreground/40"}`} />
                        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                          <span className="font-medium">{stageName(stage.id)}</span>
                          <span className="text-xs text-muted-foreground">{stageState(stage.state)}</span>
                          {stage.model ? <span className="text-xs text-muted-foreground">{shortModel(stage.model)}</span> : null}
                          {stage.updatedAt ? <span className="text-xs text-muted-foreground">{ago(stage.updatedAt, locale)}</span> : null}
                        </div>
                        {stage.reason ? <div className="mt-0.5 break-words text-xs text-muted-foreground">{reasonText(stage.reason)}</div> : null}
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}
              {card.attempts.length > 1 ? (
                <Section title={t("boardAttempts")}>
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
                </Section>
              ) : null}
              <Section title={t("boardThreads")} extra={card.threads && countLive(card.threads) ? fill("boardWorkingNow", { n: countLive(card.threads) }) : undefined}>
                {card.threads ? <ThreadRow node={card.threads} depth={0} /> : <p className="text-sm text-muted-foreground">{t("boardNoThreads")}</p>}
              </Section>
              {card.contract && (card.contract.ownsPaths.length || card.contract.expectedOutputs.length || card.contract.checks.length) ? (
                <Section title={t("boardFiles")}>
                  <Disclosure compact testId="task-files" summary={`${card.contract.ownsPaths.length + card.contract.expectedOutputs.length} · ${card.contract.checks.length}`}>
                    <div className="space-y-3 text-xs">
                      {[[t("boardOwns"), card.contract.ownsPaths], [t("boardOutputs"), card.contract.expectedOutputs], [t("boardChecks"), card.contract.checks]].map(([title, rows]) => (rows as string[]).length ? (
                        <div key={title as string}><div className="mb-1 font-semibold text-muted-foreground">{title as string}</div>
                          <ul className="space-y-0.5 font-mono">{(rows as string[]).map((row) => <li key={row} className="break-all">{row}</li>)}</ul></div>
                      ) : null)}
                    </div>
                  </Disclosure>
                </Section>
              ) : null}
              {card.plan ? (
                <Section title={t("boardPlan")}>
                  <Disclosure compact testId="task-plan" summary={card.plan.split("\n").find((line) => line.trim())?.slice(0, 80) ?? ""}>
                    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs">{card.plan}</pre>
                  </Disclosure>
                </Section>
              ) : null}
            </div>
            {rail("hidden w-56 shrink-0 border-l border-border py-8 pl-4 pr-5 @[45rem]:block")}
          </div>
        </div>
      )}
    </div>
  );
}
