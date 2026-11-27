import { useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { CARD_STAGE_ORDER } from "@lane-pilot/contracts";
import { t } from "@lane-pilot/i18n";
import { Disclosure, Icon } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { roleName, stageName, type TaskCardData } from "./task-shared";

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

function stagePillTone(state: string): { cls: string; mark: string } {
  if (state === "passed" || state === "succeeded") {
    return {
      cls: "border-[var(--color-success,#16a34a)]/30 bg-[var(--color-success,#16a34a)]/10 text-[var(--color-success,#16a34a)]",
      mark: "✓",
    };
  }
  if (state === "running") {
    return { cls: "border-primary/30 bg-primary/10 text-primary", mark: "●" };
  }
  if (state === "failed" || state === "blocked") {
    return { cls: "border-destructive/30 bg-destructive/10 text-destructive", mark: "✗" };
  }
  return { cls: "border-border bg-muted/30 text-muted-foreground", mark: "○" };
}

/** Top horizontal stage rail summarizing pipeline or workflow stages. */
export function StageRail({ card }: { card: TaskCardData }) {
  const entries = buildStageRail(card);
  if (entries.length === 0) return null;
  return (
    <div
      className="mt-4 flex flex-wrap gap-1.5"
      role="list"
      aria-label={t("consoleTaskStageRailAria")}
      data-testid="task-stage-rail"
    >
      {entries.map((entry) => {
        const { cls, mark } = stagePillTone(entry.state);
        return (
          <div
            key={entry.id}
            role="listitem"
            data-stage={entry.id}
            data-state={entry.state}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${cls}`}
          >
            <span aria-hidden className={entry.state === "running" ? "animate-pulse" : undefined}>{mark}</span>
            <span>{entry.label}</span>
          </div>
        );
      })}
    </div>
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
        <div
          className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-2 shadow-2xs"
          style={{ marginLeft: depth * 16 }}
          data-testid={`board-thread-${node.id}`}
        >
          <span className={`flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium ${live ? "text-[var(--color-success,#16a34a)]" : "text-muted-foreground"}`}>
            <span aria-hidden className={`size-1.5 rounded-full ${live ? "animate-pulse bg-[var(--color-success,#16a34a)]" : "bg-muted-foreground/50"}`} />
            <span className="truncate">{node.status ?? "—"}</span>
          </span>
          {/* basis-56: below ~224px of room the button wraps to the status row instead of squeezing the title into a 1-2 letter column (390px phones). */}
          <div className="min-w-0 flex-1 basis-56">
            <div className="break-words text-sm font-medium" title={node.title ?? node.id}>{node.title ?? node.id}</div>
            <div className="truncate text-xs text-muted-foreground">{roleName(node.role)}</div>
          </div>
          <button
            type="button"
            onClick={() => navigate.toThread(node.id)}
            className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
          >
            {t("boardOpenThread")}<Icon name="ArrowUpRight" className="size-3" />
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
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className="mt-0.5 min-w-0 break-words text-sm">{children}</div>
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
    <Disclosure compact testId="task-diff" summary={attemptId.slice(0, 12)} onToggle={load}>
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
