import { useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { CARD_STAGE_ORDER } from "@lane-pilot/contracts";
import { t } from "@lane-pilot/i18n";
import { Disclosure, Icon, StatusPill, Surface, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { ago, attemptState, fill, reasonText, roleName, shortModel, stageName, stageState, type TaskCardData } from "./task-shared";

type Thread = NonNullable<TaskCardData["threads"]>;
type StageRailEntry = { id: string; label: string; state: string };

const LIVE_THREAD = new Set(["active", "running", "starting"]);
const CORE_TASK_RAIL_STAGES = new Set<string>([
  "plan-critique",
  "writer-agent",
  "verification",
  "code-critique",
  "plan-fact",
  "acceptance-receipt",
]);

function buildStageRail(card: TaskCardData): StageRailEntry[] {
  if (card.kind === "workflow") {
    return card.stages.map((stage) => ({
      id: stage.id,
      label: stage.title ?? stageName(stage.id),
      state: stage.state,
    }));
  }
  const byId = new Map(card.stages.map((stage) => [stage.id, stage]));
  const ids = new Set<string>([...CORE_TASK_RAIL_STAGES, ...byId.keys()]);
  const ordered = CARD_STAGE_ORDER.filter((id) => ids.has(id));
  const extra = [...ids].filter((id) => !(CARD_STAGE_ORDER as readonly string[]).includes(id));
  return [...ordered, ...extra].map((id) => {
    const found = byId.get(id);
    return { id, label: found?.title ?? stageName(id), state: found?.state ?? "pending" };
  });
}

type StageTone = "ok" | "accent" | "bad" | "muted";

function stageTone(state: string): { tone: StageTone; mark: string } {
  if (state === "passed" || state === "succeeded") return { tone: "ok", mark: "✓" };
  if (state === "running") return { tone: "accent", mark: "●" };
  if (state === "failed" || state === "blocked") return { tone: "bad", mark: "✗" };
  return { tone: "muted", mark: "○" };
}

/** Top horizontal stage rail summarizing pipeline or workflow stages. */
export function StageRail({ card }: { card: TaskCardData }) {
  const entries = buildStageRail(card);
  if (entries.length === 0) return null;
  return (
    <div className="lp-wm-rail" role="list" aria-label={t("consoleTaskStageRailAria")} data-testid="task-stage-rail">
      {entries.map((entry) => {
        const { tone, mark } = stageTone(entry.state);
        return (
          <div key={entry.id} role="listitem" data-stage={entry.id} data-state={entry.state} data-tone={tone} className="lp-wm-rail-pill">
            <span aria-hidden className={entry.state === "running" ? "animate-pulse" : undefined}>{mark}</span>
            <span className="min-w-0">{entry.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One row per stage, then one per attempt when the task was tried more than once: who did it, when it last moved and how it ended. */
export function StageTable({ card, locale }: { card: TaskCardData; locale: string }) {
  const rows = [
    ...card.stages.map((stage, index) => ({
      key: `${stage.id}:${index}`,
      title: stage.title ?? stageName(stage.id),
      who: shortModel(stage.model),
      at: stage.updatedAt,
      state: stage.state,
      label: stageState(stage.state),
      note: reasonText(stage.reason),
    })),
    ...(card.attempts.length > 1
      ? card.attempts.map((attempt) => ({
          key: `attempt:${attempt.id}`,
          title: fill("consoleTaskAttemptN", { n: attempt.no }),
          who: null,
          at: attempt.updatedAt,
          state: attempt.state,
          label: attemptState(attempt.state),
          note: reasonText(attempt.reason),
        }))
      : []),
  ];
  if (rows.length === 0) return null;
  return (
    <Surface testId="task-card-stages" className="overflow-hidden">
      <Table className="lp-wm-table">
        <TableHeader>
          <TableRow>
            <TableHead>{t("consoleTaskColStage")}</TableHead>
            <TableHead>{t("consoleTaskColWho")}</TableHead>
            <TableHead className="lp-wm-col-when">{t("boardUpdated")}</TableHead>
            <TableHead>{t("consoleHistoryColOutcome")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="lp-wm-cell-strong first-letter:uppercase">{row.title}</TableCell>
              <TableCell>{row.who ?? ""}</TableCell>
              <TableCell className="lp-wm-col-when whitespace-nowrap">{row.at ? ago(row.at, locale) : ""}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusPill tone={stageTone(row.state).tone}>{row.label}</StatusPill>
                  {row.note ? <span className="min-w-0 break-words text-[11.5px] text-[var(--lp-muted)]">{row.note}</span> : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Surface>
  );
}

/** Summary row of a disclosure card: the title on the left, what is inside in muted text on the right. */
export function DiscSummary({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="lp-wm-disc-title">{title}</span>
      {meta ? <span className="lp-wm-disc-meta">{meta}</span> : null}
    </span>
  );
}

export function TaskSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        {title}
        {extra ? <span className="font-normal">{extra}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function ThreadRow({ node, depth }: { node: Thread; depth: number }) {
  const navigate = useBbNavigate();
  const live = LIVE_THREAD.has(node.status ?? "");
  return (
    <>
      {node.id ? (
        <div className="lp-wm-thread" style={{ paddingLeft: depth * 14 }} data-testid={`board-thread-${node.id}`}>
          <div className="min-w-0">
            <div className="break-words text-[12.5px] font-medium text-[var(--lp-ink)]" title={node.title ?? node.id}>{node.title ?? node.id}</div>
            <div className="truncate text-[11px] text-[var(--lp-muted)]">{roleName(node.role)}</div>
          </div>
          <button
            type="button"
            onClick={() => navigate.toThread(node.id)}
            aria-label={`${t("boardOpenThread")}: ${node.title ?? node.id}`}
            className="lp-wm-thread-open"
            data-live={live || undefined}
          >
            <span>{node.status ?? "—"}</span>
            <Icon name="ArrowUpRight" className="size-3" />
          </button>
        </div>
      ) : null}
      {(node.children as Thread[]).map((child) => (
        <ThreadRow key={`${child.role}:${child.id}`} node={child} depth={node.id ? depth + 1 : depth} />
      ))}
    </>
  );
}

export function countLiveThreads(node: Thread): number {
  return (LIVE_THREAD.has(node.status ?? "") && node.id ? 1 : 0) + (node.children as Thread[]).reduce((sum, child) => sum + countLiveThreads(child), 0);
}

export function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <div className="text-[11px] font-semibold text-[var(--lp-muted)]">{label}</div>
      <div className="mt-0.5 min-w-0 break-words text-[12.5px] text-[var(--lp-ink)]">{children}</div>
    </div>
  );
}

/** «Что изменилось»: the patch of the attempt's merge, loaded only when the section opens (SMA d_diff). */
export function TaskDiff({ attemptId }: { attemptId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{ patch: string; truncated: boolean } | { reason: string } | "loading" | null>(null);
  const load = (open: boolean) => {
    if (!open || result !== null) return;
    setResult("loading");
    void rpc.call("task_diff", { ref: attemptId }).then((answer) => setResult(answer as never)).catch(() => setResult({ reason: "?" }));
  };
  return (
    <Disclosure compact testId="task-diff" summary={<DiscSummary title={t("boardDiff")} meta={attemptId.slice(0, 12)} />} onToggle={load}>
      {result === null || result === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("boardLoading")}</p>
      ) : "reason" in result ? (
        <p className="text-xs text-muted-foreground">{result.reason}</p>
      ) : (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{result.patch}</pre>
      )}
    </Disclosure>
  );
}

/** One contract path in «Файлы»: a button that opens the bounded file text under it (SMA d_artifact). */
export function WorkFileLine({ runId, path }: { runId: string; path: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState<null | { status: "loading" } | { status: "ready"; text: string; more: boolean } | { status: "failed"; why: string }>(null);
  const glob = /[*?[]/.test(path);
  const toggle = () => {
    if (open !== null) { setOpen(null); return; }
    setOpen({ status: "loading" });
    void rpc.call("work_file_read", { runId, relativePath: path, offset: 0 })
      .then((file) => setOpen({ status: "ready", text: file.content, more: file.truncated }))
      .catch((cause) => setOpen({ status: "failed", why: cause instanceof Error ? cause.message : String(cause) }));
  };
  return (
    <li className="break-all">
      {glob ? <span>{path}</span> : (
        <button type="button" onClick={toggle} data-testid={`work-file-${path}`} className="text-left underline decoration-input underline-offset-2 hover:decoration-current">{path}</button>
      )}
      {open?.status === "ready" ? <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--lp-well,transparent)] p-2">{open.text}{open.more ? "\n…" : ""}</pre> : null}
      {open?.status === "loading" ? <div className="text-muted-foreground">{t("boardLoading")}</div> : null}
      {open?.status === "failed" ? <div className="text-destructive">{open.why}</div> : null}
    </li>
  );
}
