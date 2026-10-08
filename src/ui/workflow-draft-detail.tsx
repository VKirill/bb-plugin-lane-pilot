import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey, type Locale } from "../../i18n";
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
import {
  connectOps, edgesOf, endName, insertAfterOps, isRaw, newNode, nodeById, problemMaps, setMetaOps, viewEdgeIndexes, END_KEY, START_KEY, type NodeType, type Raw,
} from "./workflow-edit-model";
import { say } from "./workflow-edit-fields";
import { AddNodeMenu, EdgeForm, NodeForm, TestResults, VersionsList, WorkflowForm } from "./workflow-edit-panels";
import { useCatalog, useDraftEditing } from "./workflow-edit-state";
import { ModelsPanel, issueText, providerMap, useModelCatalog, useStepExecutors } from "./workflow-models";
import { useLatestRun, type NodeDataProps } from "./workflow-node-data";
import { useDrill } from "./workflow-drill";
import { choiceOps, clearModelOps, type ModelChoice } from "./workflow-model-ops";

const bilingual = (value: unknown, locale: Locale): string | null => {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") { const row = value as { en?: unknown; ru?: unknown }; const text = row[locale] ?? row.en ?? row.ru; return typeof text === "string" && text ? text : null; }
  return null;
};

/** What the panel under the graph shows: a step, an edge (named by its ends and which of them it is, so it survives a re-read), or the workflow itself. */
type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string; ordinal: number } | { kind: "workflow" } | null;
const NARROW = 560;
/** Wide enough for the panel of a step to sit beside the graph. */
const SIDE_WIDTH = 900;

/**
 * A workflow the architect is building, and the owner's editor for it. It redraws when the server says the draft was patched (no
 * reload) and outlines what that patch changed. «Edit» turns the graph into a canvas: «+» after a step, drag from a port to join
 * two, a panel for the selected step, edge or the workflow; every change is a patch the validator checks, shown on the card or
 * edge it names. The selection is kept by id across the architect's patches.
 */
export function WorkflowDraftDetail({ draftId, projectId, locale, onBack, renderNodePanel, startEditing = false }: {
  draftId: string; projectId: string | null; locale: Locale; onBack: () => void; renderNodePanel?: NodePanelRenderer; startEditing?: boolean;
}) {
  const rpc = useRpc();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useObservedWidth(rootRef);
  const [draft, setDraft] = useState<DraftDoc | null | "missing">(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState(startEditing);
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

  useEffect(() => { seen.current = { view: null, version: null, text: "" }; setDraft(null); setSelection(null); setChanges({ nodes: new Set(), edges: new Set() }); void read(); }, [read]);

  // A patch is a signal; the slow poll only repairs a missed one.
  const readRef = useRef(read);
  readRef.current = read;
  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["workflow-draft"], (signal) => { if (!signal?.draftId || signal.draftId === draftId) void readRef.current(); });
  useEffect(() => { const timer = setInterval(() => void readRef.current(), pollMs); return () => clearInterval(timer); }, [pollMs]);

  const view = useMemo(() => (draft && draft !== "missing" ? draftView(draft.workflow) : null), [draft]);
  const narrow = width > 0 && width < NARROW;
  const direction = narrow ? "DOWN" : "RIGHT";
  const openChat = (threadId: string) => {
    if (!navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: t("wfArchitectPanelTitle"), params: { threadId } })) navigate.toThread(threadId);
  };

  if (draft === "missing") return <div ref={rootRef} className="space-y-3"><Button type="button" size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-xs" onClick={onBack} data-testid="wf-back">‹ {t("wfBack")}</Button><p className="text-sm text-muted-foreground" data-testid="wf-draft-missing">{t("wfDraftGone")}</p></div>;
  if (!draft || !view) return <div ref={rootRef}><p className="text-sm text-muted-foreground" role="status">{t("wfLoading")}</p></div>;

  return (
    <div ref={rootRef} className="min-w-0 space-y-4" data-testid="workflow-draft-detail">
      <DraftScreen doc={draft} view={view} locale={locale} projectId={projectId} changes={changes} selection={selection} setSelection={setSelection} editing={editing} setEditing={setEditing}
        narrow={narrow} wide={width >= 720} room={width >= SIDE_WIDTH} direction={direction} onBack={onBack} openChat={openChat} read={read} renderNodePanel={renderNodePanel} />
    </div>
  );
}

function DraftScreen({ doc, view, locale, projectId, changes, selection, setSelection, editing, setEditing, narrow, wide, room, direction, onBack, openChat, read, renderNodePanel }: {
  doc: DraftDoc; view: WorkflowView; locale: Locale; projectId: string | null; changes: { nodes: Set<string>; edges: Set<string> }; selection: Selection; setSelection: (next: Selection) => void;
  editing: boolean; setEditing: (next: boolean) => void; narrow: boolean; wide: boolean; room: boolean; direction: "RIGHT" | "DOWN"; onBack: () => void; openChat: (threadId: string) => void; read: () => Promise<unknown>; renderNodePanel?: NodePanelRenderer;
}) {
  const edit = useDraftEditing(doc, read);
  // A draft belongs to the project it was made in, whichever library (global or a project's) the screen shows.
  const catalog = useCatalog(doc.projectId ?? projectId, doc.draftId, editing);
  const modelCatalog = useModelCatalog(projectId);
  const stepModels = useStepExecutors({ draftId: doc.draftId, projectId: doc.projectId ?? projectId, revision: doc.version });
  const [adding, setAdding] = useState<{ after: string | null } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // «Open» on a subworkflow card goes to the workflow it calls, read-only; the trail leads back to the draft.
  const drill = useDrill({ projectId: doc.projectId ?? projectId, parentSnapshot: null });
  const drilled = drill.trail.length ? drill.trail[drill.trail.length - 1]! : null;
  const drilledModels = useStepExecutors({ ...(drilled ? { workflowId: drilled.workflowId } : {}), projectId: doc.projectId ?? projectId, revision: drilled ? drilled.workflowId : null });
  const definition = (isRaw(doc.workflow) ? doc.workflow : {}) as Raw;
  const workflow = definition as { name?: unknown; description?: unknown; id?: unknown };
  const title = bilingual(workflow.name, locale) ?? t("wfDraftUnnamed");
  const description = bilingual(workflow.description, locale);
  const changed = changes.nodes.size + changes.edges.size;
  // The runs of the workflow this draft edits (a draft of a new workflow has none): the data tabs of the panel read the latest.
  const latest = useLatestRun(typeof workflow.id === "string" && workflow.id ? workflow.id : null, doc.projectId ?? projectId, String(doc.version ?? ""));

  const rawEdges = useMemo(() => viewEdgeIndexes(definition, view), [definition, view]);
  const problems = useMemo(() => problemMaps(doc.check?.problems ?? [], definition, rawEdges), [doc.check, definition, rawEdges]);

  // The edge on the panel, found again by its ends after every read.
  const edgeKeyOf = (sel: Extract<Selection, { kind: "edge" }>): { key: string; raw: number } | null => {
    let seenOf = 0;
    for (let index = 0; index < view.edges.length; index += 1) {
      const edge = view.edges[index]!;
      if (edge.from !== sel.from || edge.to !== sel.to) continue;
      if (seenOf === sel.ordinal) return { key: `e${index}`, raw: rawEdges[index] ?? -1 };
      seenOf += 1;
    }
    return null;
  };
  const selectedEdge = selection?.kind === "edge" ? edgeKeyOf(selection) : null;
  const selectedNode = selection?.kind === "node" ? nodeById(definition, selection.id) : null;
  // What was selected is gone (the architect removed it): the panel closes instead of showing a stale form.
  useEffect(() => {
    if (!selection) return;
    if ((selection.kind === "node" && !selectedNode) || (selection.kind === "edge" && !selectedEdge)) setSelection(null);
  }, [selection, selectedNode, selectedEdge, setSelection]);

  const onSelect = (key: string | null) => {
    if (!key || key === START_KEY || key === END_KEY) { setSelection(null); return; }
    setSelection({ kind: "node", id: key });
    setAdding(null);
  };
  const onSelectEdge = (key: string | null) => {
    if (!key) return;
    const index = Number(key.slice(1));
    const edge = view.edges[index];
    if (!edge) return;
    const ordinal = view.edges.slice(0, index).filter((other) => other.from === edge.from && other.to === edge.to).length;
    setSelection({ kind: "edge", from: edge.from, to: edge.to, ordinal });
    setAdding(null);
  };

  const add = async (type: NodeType) => {
    const after = adding?.after ?? null;
    const node = newNode(definition, type, { after: after ? endName(after) : null });
    setAdding(null);
    const result = await edit.apply(insertAfterOps(definition, after, node));
    if (result.ok) { setSelection({ kind: "node", id: String(node.id) }); setFocusKey(String(node.id)); }
  };
  const connect = async (from: string, to: string) => {
    const made = connectOps(definition, from, to);
    if ("error" in made) { edit.setFailure(made.error); return; }
    const ordinal = edgesOf(definition).filter((edge) => endName(String(edge.from)) === endName(from) && endName(String(edge.to)) === endName(to)).length;
    const result = await edit.apply(made.ops);
    if (result.ok) setSelection({ kind: "edge", from, to, ordinal });
  };

  /** A step dragged on the canvas: the places of all steps go into the file's `ui.positions` (the ends under their file names). */
  const place = async (positions: Record<string, { x: number; y: number }>) => {
    const named = Object.fromEntries(Object.entries(positions).map(([key, at]) => [key === START_KEY ? "start" : key === END_KEY ? "end" : key, at]));
    await edit.apply(setMetaOps({ ui: { positions: named } }));
  };
  const arrange = async () => { await edit.apply(setMetaOps({ ui: null })); };

  /** A model picked in the table is a patch of the draft like any other edit; one the catalog does not offer is refused before it is sent. */
  const chooseModel = async (nodeId: string, choice: ModelChoice | null): Promise<string | null> => {
    const made = choice ? (modelCatalog ? choiceOps(definition, modelCatalog, nodeId, choice) : { ok: false as const, code: "model_unknown" as const, detail: "" }) : { ok: true as const, ops: clearModelOps(definition, nodeId) ?? [] };
    if (!made.ok) return issueText(made.code);
    if (!made.ops.length) return issueText("no_node");
    const result = await edit.apply(made.ops);
    return result.ok ? null : result.refused ?? "-";
  };

  const tests = doc.tests;
  const testsFresh = Boolean(tests && tests.version === doc.version);
  const canPublish = editing && Boolean(doc.check?.valid) && testsFresh && tests!.green && !edit.busy && !edit.publishing;
  const publishWhy = !doc.check?.valid ? t("wfEditPublishInvalid") : !testsFresh ? t("wfEditPublishUntested") : !tests!.green ? t("wfEditPublishRed") : "";
  const errors = doc.check?.errors ?? 0;

  const panelNarrow = narrow;
  const dataFor = (nodeId: string): NodeDataProps | null => {
    const node = view.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    const states = latest?.states;
    return { node, incoming: view.edges.filter((edge) => edge.to === nodeId), run: states?.get(nodeId) ?? null, from: latest ? { runId: latest.runId, at: latest.at } : null, definitionOnly: !latest, onOpenThread: openChat };
  };
  const panel = (() => {
    if (!editing) {
      if (!selectedNode) return null;
      const node: ViewNode | undefined = view.nodes.find((candidate) => candidate.id === selectedNode.id);
      if (!node) return null;
      const context: NodePanelContext = { node, nodeKey: node.id, locale, run: latest?.states.get(node.id) ?? null, definitionOnly: !latest, readOnly: true, onOpenThread: openChat, onClose: () => setSelection(null),
        incoming: view.edges.filter((edge) => edge.to === node.id), from: latest ? { runId: latest.runId, at: latest.at } : null, narrow: panelNarrow };
      return renderNodePanel ? renderNodePanel(context) : <NodePanel {...context} draft />;
    }
    if (selection?.kind === "node" && selectedNode) return <NodeForm node={selectedNode} definition={definition} catalog={catalog} edit={edit} narrow={panelNarrow} executor={stepModels.byNode.get(selection.id) ?? null} data={dataFor(selection.id)} onClose={() => setSelection(null)} onConnect={(to) => void connect(selection.id, to === "end" ? END_KEY : to)} />;
    if (selection?.kind === "edge" && selectedEdge && selectedEdge.raw >= 0) return <EdgeForm edge={{ from: selection.from, to: selection.to }} rawIndex={selectedEdge.raw} definition={definition} edit={edit} narrow={panelNarrow} onClose={() => setSelection(null)} />;
    if (selection?.kind === "workflow") return <WorkflowForm definition={definition} catalog={catalog} edit={edit} narrow={panelNarrow} onClose={() => setSelection(null)} />;
    return null;
  })();
  const sideBySide = Boolean((panel || (editing && adding)) && !drilled && room);
  const shown = drilled ? drilled.graph : view;

  return (
    <>
      <div className="lp-strip space-y-1.5">
        <Button type="button" size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-xs text-muted-foreground" onClick={onBack} data-testid="wf-back">‹ {t("wfBack")}</Button>
        <h2 className="break-words text-xl font-medium">{title}</h2>
        {description ? <p className="break-words text-xs text-muted-foreground">{description}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="lp-pill-info rounded-full px-2 py-0.5 text-[11px] font-medium"><span className="lp-wf-pulse mr-1" aria-hidden />{t("wfDraftBadge")}</span>
          {doc.version !== null ? <span className="font-mono text-[11px] text-muted-foreground" data-testid="wf-draft-version">{t("wfDraftVersion").replace("{n}", String(doc.version))}</span> : null}
          {typeof workflow.id === "string" ? <span className="font-mono text-[11px] text-muted-foreground">{workflow.id}</span> : null}
          {doc.status === "published" ? <span className="lp-pill-success rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid="wf-draft-published">{t("wfStatus_published")}</span> : null}
          <span className="ml-auto flex items-center gap-1.5">
            {doc.threadId ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" onClick={() => openChat(doc.threadId!)}>{t("wfDraftOpenChat")}</Button> : null}
            <Button type="button" size="sm" variant={editing ? "default" : "outline"} className={editing ? "lp-accent h-7 px-3 text-xs" : "lp-raised h-7 px-3 text-xs"} aria-pressed={editing} data-testid="wf-edit-toggle"
              onClick={() => { setEditing(!editing); setAdding(null); setSelection(null); }}>{editing ? t("wfEditDone") : t("wfEdit")}</Button>
          </span>
        </div>
      </div>

      <div className="lp-wf-split" data-side={sideBySide ? "1" : "0"} data-testid="wf-split">
      <Surface testId="wf-draft-graph-panel">
        <SurfaceHeader className="flex-wrap justify-between gap-2">
          <h3 className="text-sm font-medium">{t("wfGraphHeading")}</h3>
          {editing ? (
            <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={t("wfEditToolbar")} data-testid="wf-edit-toolbar">
              <Button type="button" size="sm" className="lp-accent h-7 px-2.5 text-xs" data-testid="wf-edit-add" onClick={() => { setAdding({ after: selection?.kind === "node" && selectedNode?.type !== "note" ? selection.id : null }); setSelection(selection?.kind === "node" ? selection : null); }}>+ {t("wfEditAddStep")}</Button>
              <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" disabled={!edit.canUndo || edit.busy} aria-label={t("wfEditUndo")} data-testid="wf-edit-undo" onClick={() => void edit.undo()}>↶</Button>
              <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" disabled={!edit.canRedo || edit.busy} aria-label={t("wfEditRedo")} data-testid="wf-edit-redo" onClick={() => void edit.redo()}>↷</Button>
              <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-pressed={selection?.kind === "workflow"} data-testid="wf-edit-settings" onClick={() => { setAdding(null); setSelection(selection?.kind === "workflow" ? null : { kind: "workflow" }); }}>{t("wfEditSettings")}</Button>
              <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" disabled={edit.testing || edit.busy || errors > 0} data-testid="wf-edit-test" onClick={() => void edit.test()}>{edit.testing ? t("wfEditTesting") : t("wfEditTest")}</Button>
              <Button type="button" size="sm" className="lp-accent h-7 px-2.5 text-xs" disabled={!canPublish} aria-describedby="wf-publish-why" data-testid="wf-edit-publish" onClick={() => void edit.publish()}>{edit.publishing ? t("wfEditPublishing") : t("wfEditPublish")}</Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid="wf-draft-changes" aria-live="polite">
              {changed ? t("wfDraftChanged").replace("{nodes}", String(changes.nodes.size)).replace("{edges}", String(changes.edges.size)) : t("wfDraftNoChange")}
            </span>
          )}
        </SurfaceHeader>
        <SurfaceBody className="space-y-2">
          {editing ? (
            <div className="space-y-1" aria-live="polite">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="wf-edit-status">
                <span>{edit.busy ? t("wfEditSaving") : t("wfEditSaved").replace("{n}", String(doc.version ?? 1))}</span>
                {doc.check ? <span className={errors ? "text-destructive-text" : ""} data-testid="wf-edit-problem-count">{errors ? t("wfEditErrorsCount").replace("{n}", String(errors)) : t("wfEditNoErrors")}{doc.check.warnings ? ` · ${t("wfEditWarningsCount").replace("{n}", String(doc.check.warnings))}` : ""}</span> : null}
                {changed ? <span>{t("wfDraftChanged").replace("{nodes}", String(changes.nodes.size)).replace("{edges}", String(changes.edges.size))}</span> : null}
              </p>
              {edit.failure ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="wf-edit-failure">{say(edit.failure)}</p> : null}
              <p id="wf-publish-why" className="text-xs text-muted-foreground" data-testid="wf-publish-why">{canPublish ? t("wfEditPublishReady") : publishWhy}</p>
            </div>
          ) : <p className="text-xs text-muted-foreground">{t("wfDraftLive")}</p>}
          {drill.opening ? <p className="text-xs text-muted-foreground" role="status">{t("wfCrumbsLoading").replace("{id}", drill.opening)}</p> : null}
          {drill.missing ? <p className="text-xs text-destructive-text" role="alert">{t("wfCrumbsMissing").replace("{id}", drill.missing)}</p> : null}
          {view.nodes.length || editing ? (
            <Suspense fallback={<p className="py-10 text-center text-xs text-muted-foreground" role="status">{t("wfGraphLoading")}</p>}>
              <WorkflowGraph key={drilled ? `${drilled.key}:${drilled.workflowId}` : "draft"} graph={shown} locale={locale} {...(drilled ? {} : { changedNodes: changes.nodes, changedEdges: changes.edges })} selected={!drilled && selection?.kind === "node" ? selection.id : null}
                {...(drilled ? {} : { onSelect })} direction={direction} height={direction === "DOWN" ? 440 : 560}
                onOpen={(key, node) => { setSelection(null); void drill.open(key, node, locale); }} trail={[{ label: title }, ...drill.trail.map((step) => ({ label: step.label }))]} onTrail={(index) => { setSelection(null); drill.goTo(index); }}
                models={drilled ? { executors: drilledModels.byNode, providers: providerMap(modelCatalog), catalog: modelCatalog, access: "readonly" as const }
                  : { executors: stepModels.byNode, providers: providerMap(modelCatalog), catalog: modelCatalog, access: "draft" as const, onChoose: chooseModel }}
                {...(editing && !drilled ? { onAddAfter: (key: string) => { setSelection({ kind: "node", id: key }); setAdding({ after: key }); }, onAddFirst: () => { setSelection(null); setAdding({ after: null }); }, onConnect: (from: string, to: string) => void connect(from, to),
                  onMove: (positions: Record<string, { x: number; y: number }>) => void place(positions), onArrange: () => void arrange(),
                  selectedEdge: selectedEdge?.key ?? null, onSelectEdge, problems: problems.graph, focusKey, refit: "first" as const } : {})} />
            </Suspense>
          ) : <p className="py-6 text-center text-xs text-muted-foreground" data-testid="wf-draft-empty">{t("wfDraftEmpty")}</p>}
          {editing && !view.nodes.length ? <p className="text-center text-xs text-muted-foreground" data-testid="wf-draft-empty-edit">{t("wfEditEmptyHint")}</p> : null}
        </SurfaceBody>
      </Surface>

      {sideBySide ? (
        <div className="lp-wf-side" data-testid="wf-side">
          {editing && adding ? <AddNodeMenu after={adding.after} onPick={(type) => void add(type)} onClose={() => setAdding(null)} /> : null}
          {panel}
        </div>
      ) : null}
      </div>

      {!sideBySide && editing && adding ? <AddNodeMenu after={adding.after} onPick={(type) => void add(type)} onClose={() => setAdding(null)} /> : null}
      {!sideBySide ? panel : null}

      {view.nodes.length ? <ModelsPanel graph={view} locale={locale} executors={stepModels.list} loaded={stepModels.loaded} catalog={modelCatalog} wide={wide} busy={edit.busy} access="draft" onChoose={chooseModel} /> : null}

      {editing ? (
        <>
          {problems.general.length || (doc.check?.problems.length ?? 0) ? (
            <Surface testId="wf-problems-panel">
              <SurfaceHeader><h3 className="text-sm font-medium">{t("wfEditProblems")}</h3></SurfaceHeader>
              <SurfaceBody>
                <ul className="space-y-1.5">
                  {(doc.check?.problems ?? []).slice(0, 40).map((problem, index) => (
                    <li key={`${problem.code}:${index}`} className="flex min-w-0 items-start gap-2 text-xs" data-testid="wf-problem-row" data-level={problem.level}>
                      <span className={`${problem.level === "error" ? "lp-pill-danger" : "lp-pill-warning"} shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium`}>{problem.level === "error" ? t("wfEditProblemError") : t("wfEditProblemWarning")}</span>
                      <span className="min-w-0 break-words">{problem.message}</span>
                      {problem.node && nodeById(definition, problem.node.replace(/:(child|fan)$/, "")) ? <button type="button" className="shrink-0 text-xs underline" onClick={() => setSelection({ kind: "node", id: problem.node!.replace(/:(child|fan)$/, "") })}>{t("wfEditGoTo")}</button> : null}
                    </li>
                  ))}
                </ul>
              </SurfaceBody>
            </Surface>
          ) : null}
          <Surface testId="wf-tests-panel">
            <SurfaceHeader className="flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{t("wfEditTests")}</h3>
              {edit.published ? <span className={`${edit.published.published ? "lp-pill-success" : "lp-pill-danger"} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid="wf-publish-result">{edit.published.published ? t("wfEditPublished") : t("wfEditPublishRefused").replace("{reason}", edit.published.reason ?? "")}</span> : null}
            </SurfaceHeader>
            <SurfaceBody>
              {edit.published?.published ? <p className="break-all text-xs text-muted-foreground" data-testid="wf-publish-path">{t("wfEditPublishedAt").replace("{path}", edit.published.path ?? "")}{edit.published.warning ? ` · ${edit.published.warning}` : ""}</p> : null}
              {edit.published && !edit.published.published && edit.published.next ? <p className="break-words text-xs text-muted-foreground">{edit.published.next}</p> : null}
              <TestResults doc={doc} testRun={edit.testRun} />
            </SurfaceBody>
          </Surface>
          <Surface testId="wf-versions-panel">
            <SurfaceHeader><h3 className="text-sm font-medium">{t("wfEditVersions")}</h3></SurfaceHeader>
            <SurfaceBody><VersionsList doc={doc} edit={edit} /></SurfaceBody>
          </Surface>
        </>
      ) : null}
    </>
  );
}

export type { I18nKey };
