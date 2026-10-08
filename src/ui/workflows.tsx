import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ThreadChat, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../contracts";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "./use-lp-realtime";
import { WorkflowDetail, type NodePanelRenderer } from "./workflow-detail";
import { WorkflowDraftDetail } from "./workflow-draft-detail";
import { listDrafts, startArchitect, type DraftRow } from "./workflow-drafts";

type Listing = z.infer<(typeof rpcContract)["workflow_list"]["output"]>;
type Row = Listing["workflows"][number];

const STATUSES = ["draft", "tested", "published", "deprecated"] as const;
const SCOPES = ["builtin", "global", "project"] as const;
const ANY = "any";
const STATUS_PILL: Record<Row["status"], string> = { draft: "lp-pill-muted", tested: "lp-pill-info", published: "lp-pill-success", deprecated: "lp-pill-warning" };

const shortTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The search matches what an owner types: name in either language, id, tags, description. */
export function matches(row: Row, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.id, row.name.en, row.name.ru, row.description.en, row.description.ru, ...row.tags].some((text) => text.toLowerCase().includes(needle));
}

function Stats({ stats }: { stats: Row["stats"] }) {
  if (!stats.runs) return <span>{t("wfNoRuns")}</span>;
  return (
    <>
      <span>{stats.runs === 1 ? t("wfRunCountOne") : t("wfRunCount").replace("{n}", String(stats.runs))}</span>
      {stats.successRate !== null ? <span>{t("wfSuccessRate").replace("{pct}", String(Math.round(stats.successRate * 100)))}</span> : null}
      {stats.active ? <span className="font-medium text-timeline-accent">{t("wfActiveRuns").replace("{n}", String(stats.active))}</span> : null}
      {stats.lastRunAt ? <span>{t("wfLastRun").replace("{time}", shortTime(stats.lastRunAt))}</span> : null}
    </>
  );
}

/**
 * The Workflows tab: the library (search, status, where it comes from, how it has run) and one workflow opened as a graph.
 * With a project it lists that project's view of the library (built-in, global and the project's own files); without
 * one, the hub's. The list re-reads on the server's `workflow` signal, so run counts and the active marker stay current.
 */
export function WorkflowsScreen({ locale, projectId, architectProjectId = projectId, renderNodePanel }: {
  locale: Locale; projectId: string | null;
  /** The project the architect is started in; the library of a project starts it there, the global one in the project the page has open. */
  architectProjectId?: string | null;
  /** W6: the editor's property form for the selected node, in the graph views' panel slot. */
  renderNodePanel?: NodePanelRenderer;
}) {
  const rpc = useRpc<typeof rpcContract>();
  // The architect's chat sits beside the library or graph (owner, 2026-10-07): the chain it builds stays in view.
  const [architectThread, setArchitectThread] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  // A draft opened from a workflow's «Edit» goes straight to the editor; one opened from the list is first shown as it is.
  const [editFirst, setEditFirst] = useState(false);
  const [architect, setArchitect] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>(ANY);
  const [scope, setScope] = useState<string>(ANY);
  const [openId, setOpenId] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const [result, found] = await Promise.all([rpc.call("workflow_list", projectId ? { projectId } : {}), listDrafts(rpc, projectId ?? architectProjectId)]);
      if (mine !== generation.current) return;
      setListing(result);
      setDrafts(found);
      setError(null);
    } catch (cause) { if (mine === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [projectId, architectProjectId, rpc]);
  useEffect(() => { setListing(null); setDrafts([]); setOpenId(null); setOpenDraft(null); void load(); }, [load]);

  // The detail view has its own subscription; this one keeps the library's counts and «running» marks fresh.
  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["workflow", "workflow-draft"], (signal) => {
    // A draft the open architect chat just created or patched opens on the left, so the owner watches it being built.
    if (signal?.kind === "workflow-draft" && signal.draftId && architectThread && signal.threadId === architectThread && openDraft !== signal.draftId) {
      setOpenId(null); setEditFirst(false); setOpenDraft(signal.draftId); return;
    }
    if (!openId && !openDraft) void load();
  });
  const hasActive = listing?.workflows.some((row) => row.stats.active > 0) ?? false;
  useEffect(() => {
    if ((!hasActive && !drafts.length) || openId || openDraft) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [hasActive, drafts.length, openId, openDraft, pollMs, load]);

  const buildWithArchitect = async () => {
    if (!architectProjectId) return;
    setArchitect({ busy: true, error: null });
    try {
      const threadId = await startArchitect(rpc, architectProjectId);
      setArchitectThread(threadId);
      setArchitect({ busy: false, error: null });
      void load();
    } catch (cause) { setArchitect({ busy: false, error: cause instanceof Error ? cause.message : String(cause) }); }
  };

  const shown = useMemo(() => (listing?.workflows ?? []).filter((row) =>
    matches(row, query) && (status === ANY || row.status === status) && (scope === ANY || row.scope === scope)), [listing, query, status, scope]);

  const withArchitect = (content: ReactNode) => !architectThread ? content : (
    <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start" data-testid="wf-architect-split">
      <div className="min-w-0 flex-1">{content}</div>
      <aside className="lp-card flex h-[70vh] min-h-[420px] w-full shrink-0 flex-col overflow-hidden xl:sticky xl:top-2 xl:h-[calc(100vh-7rem)] xl:w-[26rem]" data-testid="wf-architect-chat">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="truncate text-sm font-medium">{t("wfArchitectPanelTitle")}</span>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="wf-architect-close" onClick={() => setArchitectThread(null)}>{t("wfArchitectClose")}</Button>
        </div>
        <div className="min-h-0 flex-1"><ThreadChat threadId={architectThread} variant="compact" /></div>
      </aside>
    </div>
  );

  if (openDraft) return withArchitect(<WorkflowDraftDetail draftId={openDraft} projectId={projectId} locale={locale} renderNodePanel={renderNodePanel} startEditing={editFirst} onBack={() => { setOpenDraft(null); setEditFirst(false); void load(); }} />);
  if (openId) {
    return withArchitect(<WorkflowDetail id={openId} projectId={projectId} locale={locale} renderNodePanel={renderNodePanel} editProjectId={architectProjectId} onEditDraft={(draftId) => { setOpenId(null); setEditFirst(true); setOpenDraft(draftId); }}
      onBack={() => { setOpenId(null); void load(); }} />);
  }

  const notice = listing?.project === "unavailable" ? t("wfProjectUnavailable") : listing?.project === "no_machine" ? t("wfProjectNoMachine") : null;
  return withArchitect(
    <div className="min-w-0 space-y-4" data-testid="workflows">
      <div className="lp-strip flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-medium">{t("wfTitle")}</h1>
          <p className="max-w-xl text-xs text-muted-foreground">{projectId ? t("wfHelpProject") : t("wfHelp")}</p>
        </div>
        {architectProjectId ? (
          <Button type="button" size="sm" className="lp-accent h-8 shrink-0 px-3 text-sm" disabled={architect.busy} data-testid="wf-architect-start" onClick={() => void buildWithArchitect()}>
            {architect.busy ? t("wfArchitectStarting") : t("wfArchitectBuild")}
          </Button>
        ) : null}
        {architect.error ? <p className="w-full break-words text-xs text-destructive" role="alert" data-testid="wf-architect-error">{t("wfArchitectError").replace("{error}", architect.error)}</p> : null}
      </div>
      {drafts.length ? (
        <Surface testId="workflow-drafts">
          <SurfaceHeader className="flex-wrap">
            <h2 className="text-sm font-medium">{t("wfDraftsHeading")}</h2>
          </SurfaceHeader>
          <SurfaceBody>
            <p className="text-xs text-muted-foreground">{t("wfDraftsHint")}</p>
            <ul className="divide-y divide-border/60">
              {drafts.map((row) => (
                <li key={row.draftId}>
                  <button type="button" className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`wf-draft-${row.draftId}`} onClick={() => { setEditFirst(false); setOpenDraft(row.draftId); }}>
                    <span className="min-w-0 break-words text-sm font-medium">{row.name ? row.name[locale] : t("wfDraftUnnamed")}</span>
                    <span className="lp-pill-info rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid={`wf-draft-badge-${row.draftId}`}><span className="lp-wf-pulse mr-1" aria-hidden />{t("wfDraftBadge")}</span>
                    {row.version !== null ? <span className="font-mono text-xs text-muted-foreground">{t("wfDraftVersion").replace("{n}", String(row.version))}</span> : null}
                    {row.updatedAt ? <span className="text-xs text-muted-foreground">{t("wfDraftUpdated").replace("{time}", shortTime(row.updatedAt))}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </SurfaceBody>
        </Surface>
      ) : null}
      <Surface testId="workflow-library">
        <SurfaceHeader className="flex-wrap">
          <h2 className="text-sm font-medium">{t("wfTitle")}</h2>
          {listing ? <span className="text-xs text-muted-foreground" data-testid="wf-count">{shown.length}/{listing.workflows.length}</span> : null}
        </SurfaceHeader>
        <SurfaceBody>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("wfSearch")} placeholder={t("wfSearchPlaceholder")}
              className={`${CONTROL_H} min-w-0 flex-1 basis-48`} data-testid="wf-search" />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label={t("wfFilterStatus")} className={`${CONTROL_H} w-full min-w-0 sm:w-40`} data-testid="wf-filter-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t("wfStatusAll")}</SelectItem>
                {STATUSES.map((value) => <SelectItem key={value} value={value}>{t(`wfStatus_${value}` as I18nKey)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger aria-label={t("wfFilterScope")} className={`${CONTROL_H} w-full min-w-0 sm:w-40`} data-testid="wf-filter-scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t("wfScopeAll")}</SelectItem>
                {SCOPES.filter((value) => value !== "project" || projectId).map((value) => <SelectItem key={value} value={value}>{t(`wfScope_${value}` as I18nKey)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {notice ? <p className="text-xs text-warning-text" role="status" data-testid="wf-project-notice">{notice}</p> : null}
          {listing?.problems.length ? (
            <details className="text-xs" data-testid="wf-problems">
              <summary className="cursor-pointer text-warning-text">{t("wfProblems").replace("{n}", String(listing.problems.length))}</summary>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {listing.problems.map((problem) => (
                  <li key={`${problem.origin}:${problem.source}`} className="break-words">
                    <span className="font-mono">{t("wfProblemWhere").replace("{origin}", t(`wfScope_${problem.origin}` as I18nKey)).replace("{source}", problem.source)}</span>
                    <br />{problem.messages.slice(0, 3).join("; ")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {error && !listing ? <p role="alert" className="text-sm text-destructive" data-testid="wf-error">{t("wfLoadError")}: {error}</p> : null}
          {!listing && !error ? <p className="text-xs text-muted-foreground" role="status">{t("wfLoading")}</p> : null}
          {listing && !shown.length ? (
            <div className="space-y-0.5 py-3 text-center" data-testid="wf-empty">
              <p className="text-sm">{listing.workflows.length ? t("wfEmpty") : t("wfNone")}</p>
              <p className="text-xs text-muted-foreground">{listing.workflows.length ? t("wfEmptyHint") : t("wfNoneHint")}</p>
            </div>
          ) : null}
          {shown.length ? (
            <ul className="divide-y divide-border/60" data-testid="wf-list">
              {shown.map((row) => (
                <li key={row.id}>
                  <button type="button" className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-2 py-2.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`wf-row-${row.id}`} aria-label={t("wfOpen").replace("{name}", row.name[locale])} onClick={() => setOpenId(row.id)}>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 break-words text-sm font-medium">{row.name[locale]}</span>
                      <span className={`${STATUS_PILL[row.status]} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={`wf-status-${row.id}`}>{t(`wfStatus_${row.status}` as I18nKey)}</span>
                      <span className="lp-pill-neutral rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid={`wf-scope-${row.id}`}>{t(`wfScope_${row.scope}` as I18nKey)}</span>
                      {row.internal ? <span className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px] font-medium">{t("wfInternal")}</span> : null}
                    </span>
                    <span className="line-clamp-2 break-words text-xs text-muted-foreground">{row.description[locale]}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid={`wf-stats-${row.id}`}>
                      <span className="font-mono">{row.id} · {t("wfVersion").replace("{n}", String(row.version))}</span>
                      <span>{t("wfSteps").replace("{n}", String(row.nodes))}</span>
                      <Stats stats={row.stats} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </SurfaceBody>
      </Surface>
    </div>
  );
}
