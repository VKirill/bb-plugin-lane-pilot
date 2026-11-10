import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { BacklogBoard, TodoMeta } from "../logic";

type Board = BacklogBoard & { error?: string; readAt?: string };

/**
 * The project's backlog as the scanner reads it (SMA m_sw_backlog): the four lanes of `backlogBoard` — ready to issue in queue order,
 * waiting for an estimate, too big to take on, and blocked. «Выдать» on a ready row is the same owner word the owner list's button sends.
 */
export function BacklogBoardPanel({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const reload = () => void rpc.call("backlog_board", { projectId }).then((result) => setBoard(result as Board)).catch(() => undefined);
  useEffect(reload, [rpc, projectId]);
  if (!board) return null;

  const issue = (todoId: string) => void rpc.call("backlog_issue", { projectId, todoId }).then(reload).catch(() => undefined);
  const lane = (items: TodoMeta[], testId: string, action?: (item: TodoMeta) => React.ReactNode) =>
    items.map((item) => (
      <div key={item.id} className="flex min-w-0 items-center justify-between gap-2" data-testid={`${testId}-${item.id}`}>
        <span className="min-w-0 truncate text-sm" title={item.id}>{item.title}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>{item.priority}{item.estimate !== null ? ` · ${item.estimate}` : ""}</span>
          {action?.(item)}
        </span>
      </div>
    ));
  const issueButton = (item: TodoMeta) => (
    <button type="button" className="rounded-md border border-border px-2 py-0.5 hover:bg-[var(--lp-well)]" data-testid={`backlog-issue-${item.id}`}
      onClick={() => issue(item.id)}>{t("backlogIssue")}</button>
  );

  const lanes: Array<{ key: keyof BacklogBoard; label: string; action?: typeof issueButton }> = [
    { key: "issuable", label: t("backlogIssuable"), action: issueButton },
    { key: "needsEstimate", label: t("backlogEstimate") },
    { key: "decompose", label: t("backlogDecompose") },
    { key: "blocked", label: t("backlogBlocked") },
  ];
  const empty = lanes.every((l) => board[l.key].length === 0);
  return (
    <Surface testId="backlog-board">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("backlogTitle")}</h2></SurfaceHeader>
      <SurfaceBody className="space-y-3">
        {board.error ? <p className="text-sm text-muted-foreground">{board.error}</p> : null}
        {empty && !board.error ? <p className="text-sm text-muted-foreground">{t("backlogEmpty")}</p> : null}
        {lanes.map((l) => board[l.key].length ? (
          <div key={l.key} className="min-w-0" data-testid={`backlog-lane-${l.key}`}>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">{l.label} ({board[l.key].length})</div>
            <div className="space-y-1">{lane(board[l.key], `backlog-${l.key}`, l.action)}</div>
          </div>
        ) : null)}
      </SurfaceBody>
    </Surface>
  );
}
