import { useState, type FormEvent } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { StageSteps, StageStrip, type Strip } from "../../work-graph/ui";
import { WorkflowRunSteps } from "./workflow-run-steps";
import { StatusIcon, shortTaskId } from "./task-board";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { useThreadRowStatus } from "./thread-row-status";

type Item = {
  key: string; runId: string; taskId: string | null; title: string; column: "queued" | "running" | "checking" | "blocked" | "done"; phase: string;
  stage: string | null; model: string | null; since: number | null; threadId: string | null; updatedAt: number; detail: string | null; projectId?: string | null;
  kind?: "task" | "workflow" | "phase" | "batch"; state?: string;
};
type Live = { role: "pm" | "writer" | "helper"; pmThreadId: string | null; items: Item[]; strips: Record<string, Strip>;
  session: { runId: string; state: string; kind: string } | null } | null;

const POLL_MS = 8_000;
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const label = (prefix: string, id: string | null) => { if (!id) return null; const key = `${prefix}${id.replace(/-/g, "_")}` as I18nKey; const text = t(key); return text === key ? id : text; };
// A workflow run's own status reads through the wfRunStatus_* keys — same rule as the board (task-board.tsx).
const runState = (state: string) => { const key = `wfRunStatus_${state}` as I18nKey; const text = t(key); return !text || text === key ? state : text; };
const model = (id: string | null) => (id ? id.split("/").at(-1)!.replace(/^claude-/, "").replace(/\[.*\]$/, "") : null);
function minutes(since: number | null, locale: string): string | null {
  if (!since) return null;
  const m = Math.max(0, Math.round((Date.now() - since) / 60_000));
  if (m < 60) return locale.startsWith("ru") ? `${m} мин` : `${m} min`;
  const h = Math.floor(m / 60);
  return locale.startsWith("ru") ? `${h} ч ${m % 60} мин` : `${h}h ${m % 60}m`;
}

function Row({ item, strip, locale, open, onToggle }: { item: Item; strip: Strip | undefined; locale: string; open: boolean; onToggle: () => void }) {
  const navigate = useBbNavigate();
  const now = item.column !== "done";
  const status = item.kind === "workflow" && item.state ? runState(item.state) : label("phase_", item.phase);
  const line = [status, now ? label("stage_", item.stage) : null, now ? model(item.model) : null, now ? minutes(item.since, locale) : null].filter(Boolean).join(" · ");
  return (
    <div className="border-b border-border/60 py-1.5 last:border-b-0" data-testid={`live-task-${item.key}`}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon column={item.column} phase={item.state === "canceled" ? "canceled" : undefined} />
        <button type="button" onClick={onToggle} aria-expanded={open} title={item.taskId ?? ""} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">{item.title}</button>
        {item.threadId && now ? <button type="button" title={t("graphOpenThread")} aria-label={t("graphOpenThread")} className="shrink-0 rounded px-1 text-xs leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => navigate.toThread(item.threadId!)}>↗</button> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-xs text-muted-foreground">
        {strip ? <StageStrip cells={strip.cells} testId={`live-strip-${item.key}`} /> : null}
        <span className="tabular-nums">{item.taskId ? shortTaskId(item.taskId) : null}</span>
        <span className="min-w-0 truncate">{line}</span>
      </div>
      {now && item.column === "blocked" && item.detail ? <div className="break-words pl-6 text-xs text-destructive/90">{item.detail}</div> : null}
      {open && item.taskId ? <div className="pl-6"><StageSteps runId={item.runId} taskId={item.taskId} locale={locale} projectId={item.projectId} /></div> : null}
      {open && item.kind === "workflow" ? <div className="pl-6"><WorkflowRunSteps runId={item.runId} locale={locale} /></div> : null}
    </div>
  );
}

/**
 * What Lane Pilot does for this chat, in the thread's info panel: a PM chat's tasks now at work (stage, model, how long, step by step on a
 * click) and those of the week; a writer or helper thread, the task it works on. Nothing at all in a thread Lane Pilot has no part in.
 */
export function ThreadLive({ threadId, locale }: { threadId: string; locale: string }) {
  const navigate = useBbNavigate();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const live = (useLpRpcQuery("thread_live", { threadId }, { pollMs: POLL_MS }).data ?? null) as Live;
  useThreadRowStatus(threadId, live?.items ?? null);
  if (!live || (!live.items.length && !live.session)) return null;
  const active = live.items.filter((item) => item.column !== "done");
  const done = live.items.filter((item) => item.column === "done");
  // The summary counts Lane Pilot tasks only — an engine workflow's "succeeded" is not an accepted business outcome.
  const tasks = live.items.filter((item) => item.kind !== "workflow");
  const activeTasks = tasks.filter((item) => item.column !== "done");
  const accepted = tasks.filter((item) => item.column === "done" && item.phase === "accepted").length;
  const toggle = (key: string) => setOpen((state) => ({ ...state, [key]: !state[key] }));
  const row = (item: Item) => (
    <Row key={item.key} item={item} strip={item.taskId ? live.strips[`${item.runId}:${item.taskId}`] : undefined} locale={locale}
      open={open[item.key] ?? (live.role !== "pm" || (active.length === 1 && item === active[0]))} onToggle={() => toggle(item.key)} />
  );
  return (
    <section className="min-w-0 space-y-1 pt-3" data-testid="thread-live">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("liveTitle")}</h3>
        {live.role === "pm" && tasks.length ? <span className="shrink-0 text-xs text-muted-foreground">{fill("liveSummary", { work: activeTasks.length, done: accepted, all: tasks.length })}</span> : null}
      </div>
      {live.role !== "pm" ? <p className="text-xs text-muted-foreground">{t("liveWriterOf")}</p> : null}
      {live.session ? (
        <button type="button" data-testid="live-session" title={live.session.runId}
          onClick={() => navigate.toPluginPanel("lane-pilot")}
          className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-state-hover">
          <span className="shrink-0">{t("liveSessionOpen")}</span>
          <span className="min-w-0 truncate text-muted-foreground">{live.session.runId}</span>
        </button>
      ) : null}
      {active.length ? (<div>{live.role === "pm" ? <p className="pt-1 text-xs font-medium text-muted-foreground">{t("liveNow")}</p> : null}{active.map(row)}</div>) : null}
      {done.length ? (<div>{live.role === "pm" ? <p className="pt-1 text-xs font-medium text-muted-foreground">{t("liveWeek")}</p> : null}{done.slice(0, 12).map(row)}</div>) : null}
    </section>
  );
}

export const THREAD_LIVE_TAB_ID = "lane-pilot-live";

/** Fixed thread tab: live Lane Pilot task tree for the chat plus a lightweight follow-up box via SDK threads.send. */
export function ThreadLivePanel({ threadId, locale }: { threadId: string; locale: string }) {
  const sdk = useSdk();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      setText("");
      setStatus({ kind: "ok", text: t("threadLiveSent") });
    } catch (cause) {
      setStatus({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-3 p-3" data-testid="thread-live-panel">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ThreadLive threadId={threadId} locale={locale} />
      </div>
      <form className="space-y-2 border-t border-border pt-3" data-testid="thread-live-followup" onSubmit={(e) => void onSubmit(e)}>
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("threadLivePlaceholder")}
          data-testid="thread-live-followup-input"
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-xs">
            {status ? (
              <span className={status.kind === "error" ? "text-destructive" : "text-muted-foreground"} data-testid="thread-live-followup-status">
                {status.text}
              </span>
            ) : null}
          </div>
          <Button type="submit" size="sm" disabled={busy || !text.trim()} data-testid="thread-live-followup-send">
            {busy ? t("threadLiveSending") : t("threadLiveSend")}
          </Button>
        </div>
      </form>
    </div>
  );
}
