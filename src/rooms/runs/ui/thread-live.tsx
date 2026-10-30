import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import type { rpcContract } from "../../contracts";
import { StageSteps, StageStrip, type Strip } from "../../work-graph/ui";
import { StatusIcon, shortTaskId } from "./task-board";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { useThreadRowStatus } from "./thread-row-status";

type Item = {
  key: string; runId: string; taskId: string | null; title: string; column: "queued" | "running" | "checking" | "blocked" | "done"; phase: string;
  stage: string | null; model: string | null; since: number | null; threadId: string | null; updatedAt: number; detail: string | null;
};
type Live = { role: "pm" | "writer" | "helper"; pmThreadId: string | null; items: Item[]; strips: Record<string, Strip> } | null;

const POLL_MS = 8_000;
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const label = (prefix: string, id: string | null) => { if (!id) return null; const key = `${prefix}${id.replace(/-/g, "_")}` as I18nKey; const text = t(key); return text === key ? id : text; };
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
  const line = [label("phase_", item.phase), now ? label("stage_", item.stage) : null, now ? model(item.model) : null, now ? minutes(item.since, locale) : null].filter(Boolean).join(" · ");
  return (
    <div className="border-b border-border/60 py-1.5 last:border-b-0" data-testid={`live-task-${item.key}`}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon column={item.column} />
        <button type="button" onClick={onToggle} aria-expanded={open} title={item.taskId ?? ""} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">{item.title}</button>
        {item.threadId && now ? <button type="button" title={t("graphOpenThread")} aria-label={t("graphOpenThread")} className="shrink-0 rounded px-1 text-xs leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => navigate.toThread(item.threadId!)}>↗</button> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-xs text-muted-foreground">
        {strip ? <StageStrip cells={strip.cells} testId={`live-strip-${item.key}`} /> : null}
        <span className="tabular-nums">{item.taskId ? shortTaskId(item.taskId) : null}</span>
        <span className="min-w-0 truncate">{line}</span>
      </div>
      {now && item.column === "blocked" && item.detail ? <div className="break-words pl-6 text-xs text-destructive/90">{item.detail}</div> : null}
      {open && item.taskId ? <div className="pl-6"><StageSteps runId={item.runId} taskId={item.taskId} locale={locale} /></div> : null}
    </div>
  );
}

/**
 * What Lane Pilot does for this chat, in the thread's info panel: a PM chat's tasks now at work (stage, model, how long, step by step on a
 * click) and those of the week; a writer or helper thread, the task it works on. Nothing at all in a thread Lane Pilot has no part in.
 */
export function ThreadLive({ threadId, locale }: { threadId: string; locale: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const live = (useLpRpcQuery("thread_live", { threadId }, { pollMs: POLL_MS }).data ?? null) as Live;
  useThreadRowStatus(threadId, live?.items ?? null);
  if (!live || !live.items.length) return null;
  const active = live.items.filter((item) => item.column !== "done");
  const done = live.items.filter((item) => item.column === "done");
  const accepted = done.filter((item) => item.phase === "accepted").length;
  const toggle = (key: string) => setOpen((state) => ({ ...state, [key]: !state[key] }));
  const row = (item: Item) => (
    <Row key={item.key} item={item} strip={item.taskId ? live.strips[`${item.runId}:${item.taskId}`] : undefined} locale={locale}
      open={open[item.key] ?? (live.role !== "pm" || (active.length === 1 && item === active[0]))} onToggle={() => toggle(item.key)} />
  );
  return (
    <section className="min-w-0 space-y-1 pt-3" data-testid="thread-live">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("liveTitle")}</h3>
        {live.role === "pm" ? <span className="shrink-0 text-xs text-muted-foreground">{fill("liveSummary", { work: active.length, done: accepted, all: live.items.length })}</span> : null}
      </div>
      {live.role !== "pm" ? <p className="text-xs text-muted-foreground">{t("liveWriterOf")}</p> : null}
      {active.length ? (<div>{live.role === "pm" ? <p className="pt-1 text-xs font-medium text-muted-foreground">{t("liveNow")}</p> : null}{active.map(row)}</div>) : null}
      {done.length ? (<div>{live.role === "pm" ? <p className="pt-1 text-xs font-medium text-muted-foreground">{t("liveWeek")}</p> : null}{done.slice(0, 12).map(row)}</div>) : null}
    </section>
  );
}
