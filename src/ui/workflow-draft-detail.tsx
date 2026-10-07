import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import { LP_ALL_PROJECTS } from "../realtime-channel";
import { draftChanges, draftView } from "../workflow/draft-view";
import type { ViewNode, WorkflowView } from "../workflow/view-core";
import { HELPER_PANEL_ACTION } from "./helper-threads";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";
import { useLpRealtime } from "./use-lp-realtime";
import { useObservedWidth } from "./panel-layout";
import { getDraft, type DraftDoc } from "./workflow-drafts";
import { NodePanel, WorkflowGraph, type NodePanelContext, type NodePanelRenderer } from "./workflow-detail";
import { nodeTitle } from "./workflow-titles";

const bilingual = (value: unknown, locale: Locale): string | null => {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") { const row = value as { en?: unknown; ru?: unknown }; const text = row[locale] ?? row.en ?? row.ru; return typeof text === "string" && text ? text : null; }
  return null;
};

/**
 * A workflow the architect is building. It redraws when the server says the draft was patched (no reload), and outlines the
 * nodes and edges that patch changed until the next one. Selecting a node opens the same panel slot the editor (W6) fills.
 */
export function WorkflowDraftDetail({ draftId, projectId, locale, onBack, renderNodePanel }: {
  draftId: string; projectId: string | null; locale: Locale; onBack: () => void; renderNodePanel?: NodePanelRenderer;
}) {
  const rpc = useRpc();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useObservedWidth(rootRef);
  const [draft, setDraft] = useState<DraftDoc | null | "missing">(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ nodes: Set<string>; edges: Set<string> }>({ nodes: new Set(), edges: new Set() });
  const seen = useRef<{ view: WorkflowView | null; version: number | null; text: string }>({ view: null, version: null, text: "" });

  const read = useCallback(async () => {
    const doc = await getDraft(rpc, draftId);
    if (!doc) { setDraft((current) => (current ? current : "missing")); return; }
    const view = draftView(doc.workflow);
    const text = JSON.stringify(view);
    // The same content is not a patch: a signal for another draft, or a poll, leaves the outline where it is.
    if (text !== seen.current.text) {
      setChanges(draftChanges(seen.current.view, view));
      seen.current = { view, version: doc.version, text };
    }
    setDraft(doc);
  }, [rpc, draftId]);

  useEffect(() => { seen.current = { view: null, version: null, text: "" }; setDraft(null); setSelected(null); setChanges({ nodes: new Set(), edges: new Set() }); void read(); }, [read]);

  // A patch is a signal; the slow poll only repairs a missed one.
  const readRef = useRef(read);
  readRef.current = read;
  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["workflow-draft"], (signal) => { if (!signal?.draftId || signal.draftId === draftId) void readRef.current(); });
  useEffect(() => { const timer = setInterval(() => void readRef.current(), pollMs); return () => clearInterval(timer); }, [pollMs]);

  const view = useMemo(() => (draft && draft !== "missing" ? draftView(draft.workflow) : null), [draft]);
  const direction = width > 0 && width < 560 ? "DOWN" : "RIGHT";
  const openChat = (threadId: string) => {
    if (!navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: t("wfArchitectPanelTitle"), params: { threadId } })) navigate.toThread(threadId);
  };

  if (draft === "missing") return <div ref={rootRef} className="space-y-3"><Button type="button" size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-xs" onClick={onBack} data-testid="wf-back">‹ {t("wfBack")}</Button><p className="text-sm text-muted-foreground" data-testid="wf-draft-missing">{t("wfDraftGone")}</p></div>;
  if (!draft || !view) return <div ref={rootRef}><p className="text-sm text-muted-foreground" role="status">{t("wfLoading")}</p></div>;

  const workflow = (draft.workflow && typeof draft.workflow === "object" ? draft.workflow : {}) as { name?: unknown; description?: unknown; id?: unknown };
  const title = bilingual(workflow.name, locale) ?? t("wfDraftUnnamed");
  const description = bilingual(workflow.description, locale);
  const selectedNode: ViewNode | null = selected ? view.nodes.find((node) => node.id === selected) ?? null : null;
  const changed = changes.nodes.size + changes.edges.size;
  return (
    <div ref={rootRef} className="min-w-0 space-y-4" data-testid="workflow-draft-detail">
      <div className="lp-strip space-y-1.5">
        <Button type="button" size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-xs text-muted-foreground" onClick={onBack} data-testid="wf-back">‹ {t("wfBack")}</Button>
        <h2 className="break-words text-xl font-medium">{title}</h2>
        {description ? <p className="break-words text-xs text-muted-foreground">{description}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="lp-pill-info rounded-full px-2 py-0.5 text-[11px] font-medium"><span className="lp-wf-pulse mr-1" aria-hidden />{t("wfDraftBadge")}</span>
          {draft.version !== null ? <span className="font-mono text-[11px] text-muted-foreground" data-testid="wf-draft-version">{t("wfDraftVersion").replace("{n}", String(draft.version))}</span> : null}
          {typeof workflow.id === "string" ? <span className="font-mono text-[11px] text-muted-foreground">{workflow.id}</span> : null}
          {draft.threadId ? <Button type="button" size="sm" variant="outline" className="lp-raised ml-auto h-7 px-2 text-xs" onClick={() => openChat(draft.threadId!)}>{t("wfDraftOpenChat")}</Button> : null}
        </div>
      </div>
      <Surface testId="wf-draft-graph-panel">
        <SurfaceHeader className="flex-wrap justify-between">
          <h3 className="text-sm font-medium">{t("wfGraphHeading")}</h3>
          <span className="text-xs text-muted-foreground" data-testid="wf-draft-changes" aria-live="polite">
            {changed ? t("wfDraftChanged").replace("{nodes}", String(changes.nodes.size)).replace("{edges}", String(changes.edges.size)) : t("wfDraftNoChange")}
          </span>
        </SurfaceHeader>
        <SurfaceBody className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("wfDraftLive")}</p>
          {view.nodes.length ? (
            <Suspense fallback={<p className="py-10 text-center text-xs text-muted-foreground" role="status">{t("wfGraphLoading")}</p>}>
              <WorkflowGraph graph={view} locale={locale} changedNodes={changes.nodes} changedEdges={changes.edges} selected={selected}
                onSelect={(key) => setSelected(key)} direction={direction} height={direction === "DOWN" ? 420 : 460} />
            </Suspense>
          ) : <p className="py-6 text-center text-xs text-muted-foreground" data-testid="wf-draft-empty">{t("wfDraftEmpty")}</p>}
        </SurfaceBody>
      </Surface>
      {selectedNode ? (() => {
        const context: NodePanelContext = { node: selectedNode, nodeKey: selectedNode.id, locale, run: null, definitionOnly: false, readOnly: true, onOpenThread: openChat, onClose: () => setSelected(null) };
        return renderNodePanel ? renderNodePanel(context) : <NodePanel {...context} draft />;
      })() : null}
    </div>
  );
}
