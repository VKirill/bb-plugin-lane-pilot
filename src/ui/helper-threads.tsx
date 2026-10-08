import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ThreadChat, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useLpRealtime } from "./use-lp-realtime";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Icon, type IconName } from "@lane-pilot/ui-kit";

export const HELPER_PANEL_ACTION = "lane-helper-thread";

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
};

const ROLES: Record<string, { icon: IconName; label: I18nKey }> = {
  writer: { icon: "Code", label: "helperRole_writer" },
  "emergency-writer": { icon: "Code", label: "helperRole_writer" },
  specialist: { icon: "UserRoundPlus", label: "helperRole_specialist" },
  "browser-qa": { icon: "Target", label: "helperRole_browserQa" },
  "errand": { icon: "Send", label: "helperRole_errand" },
  "council-seat": { icon: "MessageSquare", label: "helperRole_council" },
  "plan-critic": { icon: "ListTodo", label: "helperRole_planCritic" },
  "code-critic": { icon: "Bug", label: "helperRole_codeCritic" },
  "specialist-reviewer": { icon: "CircleCheck", label: "helperRole_specialistReview" },
  "docs-maintainer": { icon: "Folder", label: "helperRole_docs" },
  "memory-maintainer": { icon: "Archive", label: "helperRole_memory" },
  "project-life-maintainer": { icon: "Workflow", label: "helperRole_projectLife" },
  "pm-reader": { icon: "Search", label: "helperRole_reader" },
  analyst: { icon: "Search", label: "helperRole_analyst" },
  planner: { icon: "ListTodo", label: "helperRole_planner" },
  auditor: { icon: "CircleCheck", label: "helperRole_auditor" },
  debugger: { icon: "Bug", label: "helperRole_debugger" },
};

function roleOf(row: HelperThread) {
  return ROLES[row.role] ?? { icon: "Bot" as IconName, label: "helperRole_other" as I18nKey };
}

export function helperHint(row: HelperThread): string {
  const role = t(roleOf(row).label);
  const base = `${row.detail ? `${role} · ${row.detail}` : role}: ${row.title}`;
  return row.phase ? `${base} (${row.phase})` : base;
}

/**
 * The PM chat's helpers that are still working and queued tasks. The server signals each change (a helper thread
 * started, finished or failed, a task queued); the slow poll only catches a signal that never arrived.
 */
export function useHelperThreads(threadId: string | null): HelperThreadsResult {
  const rpc = useRpc<typeof rpcContract>();
  const projectId = useBbContext().projectId;
  const [data, setData] = useState<HelperThreadsResult>({ threads: [], queued: [] });
  const readNow = useRef<() => void>(() => undefined);
  // A signal names the PM chat it concerns; another chat's helpers are not this badge's business.
  const pollMs = useLpRealtime(projectId, ["helpers"], (signal) => { if (!signal?.threadId || signal.threadId === threadId) readNow.current(); });
  useEffect(() => {
    if (!threadId) { setData({ threads: [], queued: [] }); return; }
    let alive = true;
    let inflight = false;
    let again = false;
    const read = () => {
      if (inflight) { again = true; return; }
      inflight = true;
      void rpc.call("list_helper_threads", { threadId }).then((result) => {
        if (alive) setData({ threads: result.threads, queued: result.queued ?? [] });
      }).catch(() => undefined).finally(() => {
        inflight = false;
        if (alive && again) { again = false; read(); }
      });
    };
    readNow.current = read;
    read();
    const timer = setInterval(read, pollMs);
    return () => { alive = false; clearInterval(timer); readNow.current = () => undefined; };
  }, [rpc, threadId, pollMs]);
  return data;
}

/** Opens a helper in the right-hand thread panel; where the surface has none (a phone), goes to the thread. */
export function useOpenHelper() {
  const navigate = useBbNavigate();
  return (row: HelperThread) => {
    const opened = navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: row.title.slice(0, 40), params: { threadId: row.id } });
    if (!opened) navigate.toThread(row.id);
  };
}

/**
 * The working helpers beside the agent badge: one square each with the role icon and a pulse/status dot, the task on hover
 * (the owner wants icons only); click opens its chat. Past three, the rest fold into a «+N» that opens the list.
 * Queued tasks appear as an extra «в очереди N» chip.
 */
export function HelperChips({ threads, queued, frame }: { threads: HelperThread[]; queued?: string[]; frame?: CSSProperties }) {
  const open = useOpenHelper();
  const navigate = useBbNavigate();
  const queuedCount = queued?.length ?? 0;
  if (!threads.length && !queuedCount) return null;
  const shown = threads.slice(0, 3);
  const rest = threads.length - shown.length;
  return (
    <span className="pointer-events-auto flex items-center gap-1" data-testid="helper-chips">
      {shown.map((row) => {
        const isVerifying = row.phase === "проверка" || row.phase === "приёмка" || row.phase === "ждёт слияния";
        return (
          <button
            key={row.id}
            type="button"
            title={helperHint(row)}
            aria-label={`${helperHint(row)}. ${t("helperOpen")}`}
            data-testid={`helper-chip-${row.id}`}
            onClick={() => open(row)}
            className="relative inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ ...frame, borderRadius: "0.375rem" }}
          >
            <Icon name={roleOf(row).icon} className="size-3" />
            {isVerifying ? (
              <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-success" data-testid="verifying-dot" aria-hidden />
            ) : (
              <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-primary" data-testid="active-dot" aria-hidden />
            )}
          </button>
        );
      })}
      {rest > 0 ? (
        <button type="button" data-testid="helper-chips-more" aria-label={t("helperMore").replace("{n}", String(rest))}
          onClick={() => navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: t("helperPanelTitle"), params: {} })}
          className="inline-flex h-5 cursor-pointer items-center px-1.5 text-xs leading-none text-muted-foreground hover:text-foreground"
          style={{ ...frame, borderRadius: "0.375rem" }}>+{rest}</button>
      ) : null}
      {queuedCount > 0 ? (
        <button
          type="button"
          data-testid="helper-chip-queue"
          title={`Задачи в очереди: ${queued?.join(", ")}`}
          aria-label={`В очереди: ${queuedCount}`}
          onClick={() => navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: t("helperPanelTitle"), params: {} })}
          className="inline-flex h-5 cursor-pointer items-center gap-1 px-1.5 text-xs leading-none text-muted-foreground hover:text-foreground"
          style={{ ...frame, borderRadius: "0.375rem" }}
        >
          <Icon name="Clock" className="size-3" />
          <span>в очереди {queuedCount}</span>
        </button>
      ) : null}
    </span>
  );
}

/** The side-panel tab: the helper's chat, or the list of working helpers when opened from the launcher. */
export function HelperThreadPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const target = params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
    ? (params as { threadId: string }).threadId : null;
  const { threads: helpers, queued } = useHelperThreads(target ? null : threadId);
  const open = useOpenHelper();
  if (target) return <ThreadChat threadId={target} variant="compact" />;
  return (
    <div className="space-y-1 p-3" data-bb-plugin="lane-pilot" data-testid="helper-panel-list">
      {queued.length > 0 ? (
        <div className="mb-2 rounded border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-2 text-xs text-muted-foreground" data-testid="helper-panel-queue">
          <div className="font-semibold text-foreground">В очереди: {queued.length}</div>
          <div className="mt-1">{queued.join(", ")}</div>
        </div>
      ) : null}
      {!helpers.length && !queued.length ? <p className="text-sm text-muted-foreground">{t("helperPanelEmpty")}</p> : helpers.map((row) => (
        <button key={row.id} type="button" onClick={() => open(row)} className="lp-nav-item flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-state-hover">
          <Icon name={roleOf(row).icon} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{helperHint(row)}</span>
        </button>
      ))}
    </div>
  );
}
