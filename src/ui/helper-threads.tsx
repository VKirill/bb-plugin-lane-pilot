import { useEffect, useState, type CSSProperties } from "react";
import { ThreadChat, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Icon, type IconName } from "../../components/ui/icon";

export const HELPER_PANEL_ACTION = "lane-helper-thread";
const POLL_MS = 4_000;

export type HelperThread = { id: string; title: string; status: string; role: string; detail: string | null };

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
};

function roleOf(row: HelperThread) {
  return ROLES[row.role] ?? { icon: "Bot" as IconName, label: "helperRole_other" as I18nKey };
}

export function helperHint(row: HelperThread): string {
  const role = t(roleOf(row).label);
  return `${row.detail ? `${role} · ${row.detail}` : role}: ${row.title}`;
}

/** The PM chat's helpers that are still working, re-read every few seconds. */
export function useHelperThreads(threadId: string | null): HelperThread[] {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<HelperThread[]>([]);
  useEffect(() => {
    if (!threadId) { setRows([]); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("list_helper_threads", { threadId }).then((result) => {
      if (alive) setRows(result.threads);
    }).catch(() => undefined).finally(() => { if (alive) timer = setTimeout(read, POLL_MS); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [rpc, threadId]);
  return rows;
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
 * The working helpers beside the agent badge: role icon, a pulse, and the task's name, so a running writer reads as
 * one at a glance (a bare 20 px square went unnoticed, 2026-10-04); click opens its chat. Past three, the rest fold
 * into a «+N» that opens the list.
 */
export function HelperChips({ threads, frame }: { threads: HelperThread[]; frame?: CSSProperties }) {
  const open = useOpenHelper();
  const navigate = useBbNavigate();
  if (!threads.length) return null;
  const shown = threads.slice(0, 3);
  const rest = threads.length - shown.length;
  return (
    <span className="pointer-events-auto flex items-center gap-1" data-testid="helper-chips">
      {shown.map((row) => (
        <button
          key={row.id}
          type="button"
          title={helperHint(row)}
          aria-label={`${helperHint(row)}. ${t("helperOpen")}`}
          data-testid={`helper-chip-${row.id}`}
          onClick={() => open(row)}
          className="relative inline-flex h-5 cursor-pointer items-center gap-1 px-1.5 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ ...frame, borderRadius: "0.375rem", maxWidth: "11rem", whiteSpace: "nowrap" }}
        >
          <Icon name={roleOf(row).icon} className="size-3 shrink-0" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{row.title}</span>
          <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
        </button>
      ))}
      {rest > 0 ? (
        <button type="button" data-testid="helper-chips-more" aria-label={t("helperMore").replace("{n}", String(rest))}
          onClick={() => navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: t("helperPanelTitle"), params: {} })}
          className="inline-flex h-5 cursor-pointer items-center px-1.5 text-xs leading-none text-muted-foreground hover:text-foreground"
          style={{ ...frame, borderRadius: "0.375rem" }}>+{rest}</button>
      ) : null}
    </span>
  );
}

/** The side-panel tab: the helper's chat, or the list of working helpers when opened from the launcher. */
export function HelperThreadPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const target = params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
    ? (params as { threadId: string }).threadId : null;
  const helpers = useHelperThreads(target ? null : threadId);
  const open = useOpenHelper();
  if (target) return <ThreadChat threadId={target} variant="compact" />;
  return (
    <div className="space-y-1 p-3" data-bb-plugin="lane-pilot" data-testid="helper-panel-list">
      {!helpers.length ? <p className="text-sm text-muted-foreground">{t("helperPanelEmpty")}</p> : helpers.map((row) => (
        <button key={row.id} type="button" onClick={() => open(row)} className="lp-nav-item flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-state-hover">
          <Icon name={roleOf(row).icon} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{helperHint(row)}</span>
        </button>
      ))}
    </div>
  );
}
