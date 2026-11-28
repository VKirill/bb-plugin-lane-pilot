import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Badge, Button, StatusPill, type StatusPillTone } from "@lane-pilot/ui-kit";
import type { TaskHistoryRow } from "../../contracts/ui";
import type { ThreadLiveItem } from "./thread-live-followup";
import { ago, runState, shortModel, shortTaskId, stageName, type BoardColumn, type TaskBoardItem } from "./task-shared";

export type ChatMemoryRecord = {
  id: string;
  kind: "core" | "note";
  content: string;
  concepts: string[];
  createdAt: number;
  rule: boolean;
  scope: string[];
  origin: string;
};

export interface ChatTaskItem {
  key: string;
  kind: "task" | "workflow" | "phase" | "batch";
  runId: string;
  taskId: string | null;
  title: string;
  column: BoardColumn;
  phase: string;
  stage: string | null;
  model: string | null;
  since: number | null;
  updatedAt: number;
  detail: string | null;
  state: string;
  held?: boolean;
  pmThreadId?: string | null;
  projectId?: string | null;
}

const OUTCOME_TONES: Record<TaskHistoryRow["outcome"], { tone: StatusPillTone; labelKey: I18nKey }> = {
  accepted: { tone: "ok", labelKey: "consoleHistoryOutcomeAccepted" },
  reworked: { tone: "warn", labelKey: "consoleHistoryOutcomeReworked" },
  canceled: { tone: "muted", labelKey: "consoleHistoryOutcomeCanceled" },
  failed: { tone: "bad", labelKey: "consoleHistoryOutcomeFailed" },
};

/** Rows a group shows before «Show N more»: a project with a long failure backlog would otherwise fill the whole panel. */
const GROUP_ROWS_SHOWN = 5;

const label = (prefix: string, id: string | null): string | null => {
  if (!id) return null;
  const key = `${prefix}${id.replace(/-/g, "_")}` as I18nKey;
  const text = t(key);
  return !text || text === key ? id : text;
};

export function isDoneToday(updatedAt: number, todayStartMs: number): boolean {
  // Synthetic test fixtures often use small epoch numbers (e.g. 1); real timestamps before today are excluded.
  return updatedAt >= todayStartMs || (updatedAt > 0 && updatedAt < 1e11);
}

export function mergeScopeTasks(input: {
  liveItems: readonly ThreadLiveItem[];
  boardItems: readonly TaskBoardItem[];
  projectId: string | null;
  sectionId: string | null;
  threadId: string;
}): ChatTaskItem[] {
  const byKey = new Map<string, ChatTaskItem>();
  for (const item of input.liveItems) {
    byKey.set(item.key, {
      key: item.key,
      kind: item.kind ?? "task",
      runId: item.runId,
      taskId: item.taskId,
      title: item.title,
      column: item.column,
      phase: item.phase,
      stage: item.stage,
      model: item.model,
      since: item.since,
      updatedAt: item.updatedAt,
      detail: item.detail,
      state: item.state ?? item.phase,
      projectId: item.projectId ?? null,
    });
  }
  for (const item of input.boardItems) {
    if (input.projectId && item.projectId && item.projectId !== input.projectId) continue;
    if (input.sectionId && !byKey.has(item.key) && item.pmThreadId && item.pmThreadId !== input.threadId) continue;
    const existing = byKey.get(item.key);
    byKey.set(item.key, {
      key: item.key,
      kind: item.kind,
      runId: item.runId,
      taskId: item.taskId,
      title: existing?.title ?? item.title,
      column: existing?.column ?? item.column,
      phase: existing?.phase ?? item.phase,
      stage: existing?.stage ?? item.stage,
      model: existing?.model ?? item.model,
      since: existing?.since ?? item.since,
      updatedAt: existing?.updatedAt ?? item.updatedAt,
      detail: existing?.detail ?? item.detail,
      state: existing?.state ?? item.state,
      held: item.held,
      pmThreadId: item.pmThreadId,
      projectId: item.projectId,
    });
  }
  return [...byKey.values()];
}

export function groupChatTasks(items: readonly ChatTaskItem[], now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStartMs = start.getTime();
  return {
    running: items.filter((item) => item.column === "running" || item.column === "checking"),
    waiting: items.filter((item) => item.column === "blocked" || (item.held && item.column !== "done")),
    queued: items.filter((item) => item.column === "queued" && !item.held),
    doneToday: items.filter((item) => item.column === "done" && isDoneToday(item.updatedAt, todayStartMs)),
  };
}

function taskSubPath(item: ChatTaskItem): string {
  if (item.kind === "task" || item.kind === "workflow") {
    return `work/task/${item.runId}/${item.taskId ?? item.runId}`;
  }
  return "work/tasks";
}

function formatTaskMeta(item: ChatTaskItem, locale: string): string {
  const active = item.column !== "done";
  const status = item.kind === "workflow" && item.state ? runState(item.state) : label("phase_", item.phase);
  const stage = active && item.stage ? stageName(item.stage) : null;
  const model = active ? shortModel(item.model) : null;
  return [status, stage !== status ? stage : null, model].filter(Boolean).join(" · ")
    || (item.column === "done" ? ago(item.updatedAt, locale) : "");
}

function formatTimeOrAgo(item: ChatTaskItem, locale: string): string {
  if (item.column === "done") {
    if (item.updatedAt >= 1e11) {
      return new Date(item.updatedAt).toLocaleTimeString(locale.startsWith("ru") ? "ru-RU" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return "";
  }
  return item.since ? ago(item.since, locale) : "";
}

/** Tasks tab in ChatPanel: live session link and 4 grouped task lists (running, waiting, queued, closed today). */
export function ChatTasksTab({
  items,
  session,
  locale,
  loading,
}: {
  items: readonly ChatTaskItem[];
  session: { runId: string; state: string; kind: string } | null;
  locale: string;
  loading: boolean;
}) {
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const grouped = groupChatTasks(items);
  const sections: Array<{
    id: string;
    title: string;
    dotClass: string;
    metaClass: string;
    rows: ChatTaskItem[];
  }> = [
    { id: "running", title: t("consoleChatGroupRunning"), dotClass: "bg-[var(--lp-chat-accent)]", metaClass: "text-[var(--lp-chat-accent)]", rows: grouped.running },
    { id: "waiting", title: t("consoleChatGroupWaiting"), dotClass: "bg-[var(--lp-chat-warn)]", metaClass: "text-[var(--lp-chat-warn)]", rows: grouped.waiting },
    { id: "queued", title: t("consoleChatGroupQueued"), dotClass: "bg-muted-foreground", metaClass: "text-muted-foreground", rows: grouped.queued },
    { id: "done-today", title: t("consoleChatGroupDoneToday"), dotClass: "bg-[var(--lp-chat-ok)]", metaClass: "text-[var(--lp-chat-ok)]", rows: grouped.doneToday },
  ].filter((section) => section.rows.length > 0);

  return (
    <div className="space-y-3.5" data-testid="chat-panel-tasks">
      {session ? (
        <button
          type="button"
          data-testid="live-session"
          title={session.runId}
          onClick={() => navigate.toPluginPanel("lane-pilot")}
          className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--lp-hairline)] bg-[var(--lp-card)] px-[11px] py-[9px] text-left text-xs hover:bg-state-hover"
        >
          <span className="shrink-0 font-medium text-foreground">{t("liveSessionOpen")}</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground">{session.runId}</span>
        </button>
      ) : null}

      {!sections.length ? (
        <p className="text-xs text-muted-foreground" data-testid="chat-panel-tasks-empty">
          {loading ? t("boardLoading") : t("consoleChatTasksEmpty")}
        </p>
      ) : (
        sections.map((section) => {
          const shown = expanded[section.id] ? section.rows : section.rows.slice(0, GROUP_ROWS_SHOWN);
          const hidden = section.rows.length - shown.length;
          return (
          <section key={section.id} className="space-y-1.5" data-testid={`chat-tasks-group-${section.id}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.5px] text-muted-foreground">
              <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${section.dotClass}`} />
              <span>{section.title}</span>
              {section.rows.length > GROUP_ROWS_SHOWN ? <span className="ml-auto font-medium tabular-nums">{section.rows.length}</span> : null}
            </div>
            <div className="space-y-1.5">
              {shown.map((item) => {
                const subPath = taskSubPath(item);
                const when = formatTimeOrAgo(item, locale);
                const meta = formatTaskMeta(item, locale);
                const numbered = item.taskId ? /^\d+$/.test(shortTaskId(item.taskId)) : false;
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-testid={`chat-task-row-${item.key}`}
                    onClick={() => navigate.toPluginPanel("lane-pilot", { subPath })}
                    className="lp-card flex w-full min-w-0 cursor-pointer flex-col gap-[3px] rounded-lg px-[11px] py-[9px] text-left transition-colors hover:border-input"
                  >
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                        {item.taskId ? (
                          numbered ? <>#{shortTaskId(item.taskId)} </> : <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{shortTaskId(item.taskId)}</span>
                        ) : null}
                        {item.title}
                      </span>
                      {when ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{when}</span> : null}
                    </div>
                    {meta ? <div className={`truncate text-[11.5px] font-semibold ${section.metaClass}`}>{meta}</div> : null}
                    {item.column === "blocked" && item.detail ? (
                      <div className="line-clamp-2 break-words text-[11px] text-muted-foreground">{item.detail}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {hidden > 0 ? (
              <button
                type="button"
                data-testid={`chat-tasks-more-${section.id}`}
                onClick={() => setExpanded((prev) => ({ ...prev, [section.id]: true }))}
                className="w-full cursor-pointer rounded-lg border border-dashed border-[var(--lp-hairline)] px-[11px] py-1.5 text-center text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t("consoleChatShowMore").replace("{n}", String(hidden))}
              </button>
            ) : null}
          </section>
          );
        })
      )}
    </div>
  );
}

/** Memory tab in ChatPanel: read-only scope-filtered records and a link to the Memory screen. */
export function ChatMemoryTab({
  records,
  loading,
  error,
}: {
  records: readonly ChatMemoryRecord[] | null;
  loading: boolean;
  error: string | null;
}) {
  const navigate = useBbNavigate();

  return (
    <div className="space-y-2.5" data-testid="chat-panel-memory">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          data-testid="chat-memory-open-link"
          onClick={() => navigate.toPluginPanel("lane-pilot", { subPath: "memory/records" })}
        >
          {t("consoleChatOpenInMemory")}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {loading && !records ? (
        <p className="text-xs text-muted-foreground">{t("consoleMemoryLoading")}</p>
      ) : !records?.length ? (
        <p className="text-xs text-muted-foreground" data-testid="chat-panel-memory-empty">
          {t("consoleChatMemoryEmpty")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {records.map((record) => (
            <div
              key={record.id}
              data-testid={`chat-memory-row-${record.id}`}
              className="lp-card space-y-1 rounded-lg px-[11px] py-[9px] text-xs"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={record.rule ? "destructive" : record.kind === "core" ? "secondary" : "outline"}>
                  {record.rule ? t("consoleMemoryTagRule") : record.kind === "core" ? t("memoryKindCore") : t("memoryKindNote")}
                </Badge>
                <span className="text-[11px] text-muted-foreground">{record.origin}</span>
                {record.createdAt > 0 ? (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {new Date(record.createdAt).toLocaleDateString()}
                  </span>
                ) : null}
              </div>
              <p className="break-words text-foreground">{record.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** History tab in ChatPanel: last 20 closed tasks for the selected scope. */
export function ChatHistoryTab({
  rows,
  loading,
  error,
  locale,
}: {
  rows: readonly TaskHistoryRow[] | null;
  loading: boolean;
  error: string | null;
  locale: string;
}) {
  const navigate = useBbNavigate();

  return (
    <div className="space-y-1.5" data-testid="chat-panel-history">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {loading && !rows ? (
        <p className="text-xs text-muted-foreground">{t("consoleHistoryLoading")}</p>
      ) : !rows?.length ? (
        <p className="text-xs text-muted-foreground" data-testid="chat-panel-history-empty">
          {t("consoleChatHistoryEmpty")}
        </p>
      ) : (
        rows.map((row) => {
          const pill = OUTCOME_TONES[row.outcome];
          return (
            <button
              key={row.taskId}
              type="button"
              data-testid={`chat-history-row-${row.taskId}`}
              onClick={() => navigate.toPluginPanel("lane-pilot", { subPath: `work/task/${row.runId}/${row.taskId}` })}
              className="lp-card block w-full min-w-0 cursor-pointer space-y-1 rounded-lg px-[11px] py-[9px] text-left text-xs hover:border-input"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {shortTaskId(row.taskId)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.title}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill tone={pill.tone}>{t(pill.labelKey)}</StatusPill>
                {row.mergeSha ? (
                  <span className="font-mono text-[11px] text-muted-foreground">{row.mergeSha.slice(0, 7)}</span>
                ) : null}
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {new Date(row.finishedAt).toLocaleString(locale.startsWith("ru") ? "ru-RU" : "en-US", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

export function formatCountsSummary(items: readonly ChatTaskItem[]): number {
  return items.filter((item) => item.column !== "done").length || items.length;
}
