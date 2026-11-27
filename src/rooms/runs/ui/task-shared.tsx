import type { ReactNode } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";

/** The acceptance card the task page shows, implemented inside src/rooms/runs and handed in from the page shell. */
export type AcceptanceCardView = (props: {
  runId: string;
  taskId: string;
  refreshKey: unknown;
  finished: boolean;
  fallback: { objective: string | null; acceptance: string[] } | null;
  /** «Stop» on the card (SMA sc_acceptance): cancel the running attempt; null on a finished task, which has nothing to stop. */
  onStop?: (() => void) | null;
  className?: string;
}) => ReactNode;

export type TaskBoardData = z.infer<(typeof rpcContract)["task_board"]["output"]>;
export type TaskBoardItem = TaskBoardData["items"][number];
export type TaskCardData = NonNullable<z.infer<(typeof rpcContract)["task_card"]["output"]>>;
export type BoardColumn = TaskBoardItem["column"];

const KIND_COLOR: Record<NonNullable<TaskBoardItem["taskKind"]>, string> = {
  feature: "#8b5cf6",
  fix: "#ef4444",
  check: "#0ea5e9",
  docs: "#64748b",
  refactor: "#f59e0b",
  research: "#10b981",
  chore: "#94a3b8",
};

export const chip = "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-[11px] leading-5 text-muted-foreground";

export const fill = (key: I18nKey, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));

// t() answers undefined for a key the locale does not have, so a miss must fall back on empty too, not only on the key itself.
export const stageName = (id: string) => {
  const key = `stage_${id.replace(/-/g, "_")}` as I18nKey;
  const text = t(key);
  return !text || text === key ? id : text;
};

export const stageState = (state: string) => {
  const key = `stage_state_${state}` as I18nKey;
  const text = t(key);
  return !text || text === key ? state : text;
};

export const attemptState = (state: string) => {
  const key = `attempt_${state}` as I18nKey;
  const text = t(key);
  return !text || text === key ? state : text;
};

// A workflow run's own status reads through the wfRunStatus_* keys directly — the runs room must not import the workflow room's UI for its label map.
export const runState = (state: string) => {
  const key = `wfRunStatus_${state}` as I18nKey;
  const text = t(key);
  return !text || text === key ? state : text;
};

/** Reasons Lane Pilot writes as codes read as words; anything else (a check's output, a writer's question) stays as written. */
export const reasonText = (reason: string | null) =>
  reason === "disabled_by_project_setting" ? t("reason_disabled_by_setting") : reason;

export const roleName = (role: string) =>
  role === "PM"
    ? t("role_pm")
    : role === "sub-agent"
      ? t("role_subagent")
      : role.startsWith("writer#")
        ? fill("role_writer", { n: role.slice(7) })
        : stageName(role);

/** `ck-24-ui-pages-orders.2` reads as `ck-24.2`, like a tracker key; the full id is in the tooltip. */
export function shortTaskId(id: string): string {
  const redo = /(\.\d+)+$/.exec(id)?.[0] ?? "";
  const base = id.slice(0, id.length - redo.length);
  const keyed = /^([a-z]{1,6}-\d{1,4})(?:-|$)/i.exec(base);
  return `${keyed ? keyed[1] : base.length > 18 ? `${base.slice(0, 16)}…` : base}${redo}`;
}

export const areaLabel = (area: string) => area.replace(/^(feature|page|area):/, "");

export function ago(ms: number | null, locale: string, now = Date.now()): string {
  if (!ms || ms < 1e11) return "";
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return t("boardJustNow");
  if (minutes < 60) return fill("boardMinAgo", { n: minutes });
  if (minutes < 24 * 60) return fill("boardHourAgo", { n: Math.round(minutes / 60) });
  return new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export const shortModel = (model: string | null) =>
  model ? model.replace(/^claude-/, "").replace(/^(gpt|gemini|grok)-/, "$1 ").replace(/\[.*\]$/, "") : null;

/** The BB Tasks status rings: an empty ring waits, a half ring works, a three-quarter ring is checked, a filled check is done. */
export function StatusIcon({
  column,
  phase,
  className = "",
}: {
  column: BoardColumn;
  phase?: TaskBoardItem["phase"];
  className?: string;
}) {
  const tone =
    column === "running"
      ? "text-[var(--color-attention,#d97706)]"
      : column === "checking"
        ? "text-[var(--color-timeline-accent,#7c3aed)]"
        : column === "blocked"
          ? "text-destructive"
          : column === "done"
            ? phase === "canceled"
              ? "text-muted-foreground"
              : "text-[var(--color-success,#16a34a)]"
            : "text-muted-foreground";
  const ring = <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" />;
  return (
    <svg viewBox="0 0 14 14" aria-hidden data-status-icon={column} className={`size-3.5 shrink-0 ${tone} ${className}`}>
      {column === "queued" ? (
        <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={phase === "waiting" ? "1.8 2" : undefined} />
      ) : null}
      {column === "running" ? <>{ring}<path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" /></> : null}
      {column === "checking" ? <>{ring}<path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 2.4 7 Z" fill="currentColor" /></> : null}
      {column === "blocked" ? <>{ring}<path d="M7 4 v3.6 M7 9.6 v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></> : null}
      {column === "done" && phase !== "canceled" ? (
        <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.4 7.2 l1.8 1.8 3.4-3.8" stroke="var(--background,#fff)" strokeWidth="1.5" fill="none" strokeLinecap="round" /></>
      ) : null}
      {column === "done" && phase === "canceled" ? (
        <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M5 5 l4 4 M9 5 l-4 4" stroke="var(--background,#fff)" strokeWidth="1.4" strokeLinecap="round" /></>
      ) : null}
    </svg>
  );
}

export function KindChip({ kind }: { kind: TaskBoardItem["taskKind"] }) {
  if (!kind) return <span className={chip}>{t("boardChain")}</span>;
  return (
    <span className={chip} data-kind={kind}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: KIND_COLOR[kind] }} />
      {t(`kind_${kind}` as I18nKey)}
    </span>
  );
}
