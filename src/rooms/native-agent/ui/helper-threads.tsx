import { HELPER_PANEL_ACTION } from "../../contracts/agent-picker";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { ThreadChat, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useLpRealtime, useLpRpcQuery, useOpenThreadPanel } from "../../ui-shell/ui";
import type { rpcContract } from "../../contracts";
import { canonicalRoleId, roleName, t, type I18nKey } from "@lane-pilot/i18n";
import { ConfirmDialog, Icon, type IconName } from "@lane-pilot/ui-kit";
import { TaskGraphView, type TaskGraphData } from "./task-graph-view";

export type HelperThread = {
  id: string;
  title: string;
  status: string;
  role: string;
  detail: string | null;
  phase?: string | null;
};

export type HelperThreadsResult = {
  threads: HelperThread[];
  queued: string[];
  /** The open run's unfinished tasks and what each waits for; absent from an older server. */
  graph?: TaskGraphData;
};

const ROLES: Record<string, { icon: IconName; label: I18nKey }> = {
  writer: { icon: "Code", label: "helperRole_writer" },
  "emergency-writer": { icon: "Code", label: "helperRole_emergencyWriter" as I18nKey },
  specialist: { icon: "UserRoundPlus", label: "helperRole_specialist" },
  "browser-qa": { icon: "Target", label: "helperRole_browserQa" },
  "errand": { icon: "Send", label: "helperRole_errand" },
  "api-recon": { icon: "Search", label: "helperRole_apiRecon" as I18nKey },
  "plan-critic": { icon: "ListTodo", label: "helperRole_planCritic" },
  "code-critic": { icon: "Bug", label: "helperRole_codeCritic" },
  "specialist-reviewer": { icon: "CircleCheck", label: "helperRole_specialistReview" },
  "docs-maintainer": { icon: "Folder", label: "helperRole_docs" },
  "memory-maintainer": { icon: "Archive", label: "helperRole_memory" },
  "project-life-maintainer": { icon: "Workflow", label: "helperRole_projectLife" },
  "pm-reader": { icon: "Search", label: "helperRole_reader" },
  scout: { icon: "Search", label: "helperRole_scout" },
  analyst: { icon: "Search", label: "helperRole_analyst" },
  planner: { icon: "ListTodo", label: "helperRole_planner" },
  auditor: { icon: "CircleCheck", label: "helperRole_auditor" },
  debugger: { icon: "Bug", label: "helperRole_debugger" },
};

/** The words for a thread role: the fixed label of the common ones, else the name from the one map (a lead, a repairer, a specialist employee), else «Helper». */
function roleText(role: string): string {
  const fixed = ROLES[role];
  if (fixed) return t(fixed.label);
  return canonicalRoleId(role) ? roleName(role) : t("helperRole_other");
}

function roleOf(row: HelperThread) {
  return ROLES[row.role] ?? { icon: "Bot" as IconName, label: "helperRole_other" as I18nKey };
}

export function helperHint(row: HelperThread): string {
  const role = roleText(row.role);
  const base = `${row.detail ? `${role} · ${row.detail}` : role}: ${row.title}`;
  return row.phase ? `${base} (${row.phase})` : base;
}

/**
 * The PM chat's helpers that are still working and queued tasks. The server signals each change (a helper thread
 * started, finished or failed, a task queued); the slow poll only catches a signal that never arrived.
 */
export function useHelperThreads(threadId: string | null): HelperThreadsResult {
  const projectId = useBbContext().projectId;
  const readNow = useRef<() => void>(() => undefined);
  // A signal names the PM chat it concerns; another chat's helpers are not this badge's business.
  const pollMs = useLpRealtime(projectId, ["helpers"], (signal) => { if (!signal?.threadId || signal.threadId === threadId) readNow.current(); });
  const query = useLpRpcQuery("list_helper_threads", threadId ? { threadId } : null, { pollMs, enabled: !!threadId });
  readNow.current = () => { void query.refetch(); };
  const result = query.data as { threads?: HelperThread[]; queued?: string[]; graph?: TaskGraphData } | undefined;
  return { threads: result?.threads ?? [], queued: result?.queued ?? [], ...(result?.graph ? { graph: result.graph } : {}) };
}

/** Opens a helper in the right-hand thread panel; where the surface has none (a phone), goes to the thread. */
export function useOpenHelper() {
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();
  return (row: HelperThread) => {
    const opened = openPanel({ actionId: HELPER_PANEL_ACTION, title: row.title.slice(0, 40), params: { threadId: row.id } });
    if (!opened) navigate.toThread(row.id);
  };
}

/**
 * The working helpers beside the agent badge: one pill each with the role in words and a pulse/status dot, the task on hover;
 * click opens its chat. Past three, the rest fold into a «+N» that opens the list.
 * Queued tasks appear as an extra «в очереди N» chip.
 */
export function HelperChips({ threads, queued, frame }: { threads: HelperThread[]; queued?: string[]; frame?: CSSProperties }) {
  const open = useOpenHelper();
  const openPanel = useOpenThreadPanel();
  const queuedCount = queued?.length ?? 0;
  if (!threads.length && !queuedCount) return null;
  const shown = threads.slice(0, 3);
  const rest = threads.length - shown.length;
  return (
    <span className="pointer-events-auto flex min-w-0 items-center gap-1" data-testid="helper-chips">
      {shown.map((row) => {
        const isVerifying = row.phase === "проверка" || row.phase === "приёмка" || row.phase === "ждёт слияния";
        // The chips are portaled into BB's prompt box, outside this plugin's CSS, so only BB's own Tailwind classes apply there;
        // every measure that matters is inline. A pill with the working role in words and a status dot, like the prototype.
        return (
          <button
            key={row.id}
            type="button"
            title={helperHint(row)}
            aria-label={`${helperHint(row)}. ${t("helperOpen")}`}
            data-testid={`helper-chip-${row.id}`}
            onClick={() => open(row)}
            className="inline-flex cursor-pointer items-center transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{
              gap: "0.375rem",
              minWidth: 0,
              padding: "0.25rem 0.625rem",
              backgroundColor: "var(--muted, #F6F6F3)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border, #E7E6E1)",
              color: "var(--muted-foreground, #4B4F58)",
              fontSize: "11.5px",
              fontWeight: 500,
              lineHeight: 1,
              whiteSpace: "nowrap",
              ...frame,
              borderRadius: "999px",
            }}
          >
            <span
              className={isVerifying ? "" : "animate-pulse"}
              data-testid={isVerifying ? "verifying-dot" : "active-dot"}
              style={{ width: "6px", height: "6px", flexShrink: 0, borderRadius: "999px", backgroundColor: isVerifying ? "var(--success, #2F9E66)" : "var(--timeline-accent, #3B5BDB)" }}
              aria-hidden
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{roleText(row.role)}</span>
          </button>
        );
      })}
      {rest > 0 ? (
        <button type="button" data-testid="helper-chips-more" aria-label={t("helperMore").replace("{n}", String(rest))}
          onClick={() => openPanel({ actionId: HELPER_PANEL_ACTION, title: t("helperPanelTitle"), params: {} })}
          className="inline-flex cursor-pointer items-center text-xs leading-none text-muted-foreground hover:text-foreground"
          style={{
            padding: "0.25rem 0.625rem",
            backgroundColor: "var(--muted, #F6F6F3)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border, #E7E6E1)",
            color: "var(--muted-foreground, #4B4F58)",
            ...frame,
            borderRadius: "999px",
          }}>+{rest}</button>
      ) : null}
      {queuedCount > 0 ? (
        <button
          type="button"
          data-testid="helper-chip-queue"
          title={t("helperQueueTitle").replace("{list}", queued?.join(", ") ?? "")}
          aria-label={t("helperQueueAria").replace("{count}", String(queuedCount))}
          onClick={() => openPanel({ actionId: HELPER_PANEL_ACTION, title: t("helperPanelTitle"), params: {} })}
          className="inline-flex cursor-pointer items-center gap-1 text-xs leading-none text-muted-foreground hover:text-foreground"
          style={{
            padding: "0.25rem 0.625rem",
            backgroundColor: "var(--muted, #F6F6F3)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border, #E7E6E1)",
            color: "var(--muted-foreground, #4B4F58)",
            fontSize: "11.5px",
            fontWeight: 500,
            ...frame,
            borderRadius: "999px",
          }}
        >
          <Icon name="Clock" className="size-3" />
          <span>{t("helperQueueChip").replace("{count}", String(queuedCount))}</span>
        </button>
      ) : null}
    </span>
  );
}

/** Reusable helpers list with TaskGraphView and ConfirmDialog cancellation (used in HelperThreadPanel and ChatPanel). */
export function HelperThreadsList({ threadId, className = "p-3" }: { threadId: string; className?: string }) {
  const { threads: helpers, queued, graph } = useHelperThreads(threadId);
  const open = useOpenHelper();
  const rpc = useRpc<typeof rpcContract>();
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  // With the run's task graph the queue reads as steps (what runs side by side, what waits for what); the flat list is the fallback.
  const showGraph = Boolean(graph?.nodes.length);

  const handleConfirmCancel = async () => {
    if (!pendingCancelId) return;
    const result = await rpc.call("cancel_attempt", { attemptId: pendingCancelId, code: "owner_cancel" });
    if (!result.ok) {
      throw new Error(result.reason ?? t("consoleTaskActionFailed"));
    }
  };

  return (
    <div className={`space-y-1 ${className}`.trim()} data-bb-plugin="lane-pilot" data-testid="helper-panel-list">
      {showGraph ? (
        <TaskGraphView
          graph={graph!}
          onOpen={(node) => node.threadId && open({ id: node.threadId, title: node.id, status: "active", role: "writer", detail: null })}
          onRetry={(attemptId) => void rpc.call("retry_attempt", { attemptId }).catch(() => undefined)}
          onCancel={(attemptId) => setPendingCancelId(attemptId)}
        />
      ) : null}
      {!showGraph && queued.length > 0 ? (
        <div className="mb-2 rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-2.5 text-xs text-muted-foreground" data-testid="helper-panel-queue">
          <div className="font-semibold text-foreground">{t("helperQueuePanel").replace("{count}", String(queued.length))}</div>
          <div className="mt-1">{queued.join(", ")}</div>
        </div>
      ) : null}
      {!helpers.length && !queued.length ? <p className="text-sm text-muted-foreground">{t("helperPanelEmpty")}</p> : helpers.map((row) => (
        <button key={row.id} type="button" onClick={() => open(row)} className="lp-nav-item flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-state-hover">
          <Icon name={roleOf(row).icon} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{helperHint(row)}</span>
        </button>
      ))}
      <ConfirmDialog
        open={pendingCancelId !== null}
        title={t("consoleTaskConfirmCancelTitle")}
        body={t("consoleTaskConfirmCancelBody")}
        confirmLabel={t("consoleTaskConfirmCancelAction")}
        cancelLabel={t("consoleTaskKeepRunning")}
        tone="danger"
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingCancelId(null);
        }}
        onConfirm={handleConfirmCancel}
      />
    </div>
  );
}

/** The side-panel tab: the helper's chat, or the list of working helpers when opened from the launcher. */
export function HelperThreadPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const target = params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
    ? (params as { threadId: string }).threadId : null;
  if (target) return <ThreadChat threadId={target} variant="compact" />;
  return <HelperThreadsList threadId={threadId} />;
}

/** threadId → the helper's short role label, for the thread-list row badge (`experimental_threadRowMetadata`'s useData). */
export function useHelperThreadIndex(threadIds: readonly string[]): Map<string, string> {
  const ids = useMemo(() => [...threadIds].sort(), [threadIds.join("\0")]);
  const query = useLpRpcQuery("helper_thread_labels", { threadIds: ids }, { pollMs: 30_000, enabled: ids.length > 0 });
  return useMemo(() => {
    const index = new Map<string, string>();
    for (const [id, role] of Object.entries((query.data as { labels?: Record<string, string> } | undefined)?.labels ?? {})) {
      index.set(id, roleText(role));
    }
    return index;
  }, [query.data]);
}
