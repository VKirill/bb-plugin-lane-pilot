import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../contracts";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { LP_ALL_PROJECTS } from "../realtime-channel";
import type { ViewNode, WorkflowView } from "../workflow/view";
import { HELPER_PANEL_ACTION } from "./helper-threads";
import { useLpRealtime } from "./use-lp-realtime";
import { useObservedWidth } from "./panel-layout";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";
import { nodeTitle } from "./workflow-titles";
import { pickRun, runView, stepStatus, type NodeRun, type RunSnapshot, type RunStep } from "./workflow-run";
import { ModelsPanel, providerMap, useModelCatalog, useStepExecutors, issueText } from "./workflow-models";
import { choiceRefusal, clearModelOps, choiceOps, type ModelChoice } from "./workflow-model-ops";
import { getDraft } from "./workflow-drafts";
import type { Expansions } from "./workflow-layout";

/** Loaded when a graph is first shown: xyflow and elkjs are most of a megabyte. */
export const WorkflowGraph = lazy(() => import("./workflow-graph"));

type Detail = NonNullable<z.infer<(typeof rpcContract)["workflow_get"]["output"]>["workflow"]>;
type RunRow = Detail["runs"][number];
type Field = Detail["inputs"][number];

export const RUN_STATUS_KEY: Record<string, I18nKey> = {
  running: "wfRunStatus_running", waiting: "wfRunStatus_waiting", succeeded: "wfRunStatus_succeeded", failed: "wfRunStatus_failed",
  blocked: "wfRunStatus_blocked", interrupted: "wfRunStatus_interrupted", canceled: "wfRunStatus_canceled",
};
export const runPill = (status: string) => status === "succeeded" ? "lp-pill-success" : status === "running" || status === "waiting" ? "lp-pill-info" : status === "canceled" ? "lp-pill-muted" : "lp-pill-danger";
const STEP_PILL: Record<string, string> = { pending: "lp-pill-muted", running: "lp-pill-info", waiting: "lp-pill-neutral", done: "lp-pill-success", failed: "lp-pill-danger", skipped: "lp-pill-muted" };
const NODE_KEY: Record<string, I18nKey> = { pending: "wfNode_pending", running: "wfNode_running", waiting: "wfNode_waiting", done: "wfNode_done", failed: "wfNode_failed", skipped: "wfNode_skipped" };

const DEFINITION = "__definition__";
const dotClass = (status: string) => status === "succeeded" ? "bg-[var(--lp-success)]" : status === "running" || status === "waiting" ? "bg-[var(--lp-info)]" : status === "canceled" ? "bg-[var(--muted-foreground)]" : "bg-[var(--destructive)]";
const StatusDot = ({ status }: { status: string }) => <span className={`${dotClass(status)} ${isActive(status) ? "lp-wf-pulse" : ""} inline-block size-2 shrink-0 rounded-full`} data-status={status} aria-hidden />;

const when = (at: number | null) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");
const isActive = (status: string) => status === "running" || status === "waiting";

function FieldList({ fields }: { fields: Field[] }) {
  if (!fields.length) return <p className="text-xs text-muted-foreground">{t("wfNoFields")}</p>;
  return (
    <ul className="space-y-0.5 text-xs">
      {fields.map((field) => (
        <li key={field.name} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" title={field.note}>
          <span className="font-mono">{field.name}</span>
          <span className="text-muted-foreground">{field.values ? field.values.join(" | ") : field.type}{field.required ? "" : "?"}</span>
        </li>
      ))}
    </ul>
  );
}

/** What a step did, as the journal records it: state, times, the handoff it wrote and the result it produced. */
function StepCard({ step, index, onOpenThread }: { step: RunStep; index: number; onOpenThread: (threadId: string) => void }) {
  const status = stepStatus(step.state);
  const output = step.output as { truncated?: boolean; preview?: string } | Record<string, unknown> | null;
  const truncated = Boolean(output && typeof output === "object" && (output as { truncated?: boolean }).truncated);
  const text = output === null || output === undefined ? "" : truncated ? String((output as { preview?: string }).preview ?? "") : JSON.stringify(output, null, 2);
  return (
    <li className="space-y-1.5 rounded-lg border border-[var(--lp-hairline)] p-2.5 text-xs" data-testid={`wf-step-${step.key}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{t("wfNodeStep").replace("{n}", String(index + 1))}</span>
        <span className={`${STEP_PILL[status]} rounded-full px-2 py-0.5 text-[11px] font-medium`}>{t(NODE_KEY[status]!)}</span>
        {step.attempt > 1 ? <span className="text-muted-foreground">{t("wfNodeAttempt").replace("{n}", String(step.attempt))}</span> : null}
        <span className="ml-auto text-muted-foreground">{when(step.startedAt ?? null)}</span>
      </div>
      {step.awaiting ? <p className="text-muted-foreground">{t("wfNodeAwaiting").replace("{what}", step.awaiting)}</p> : null}
      {step.error ? <p className="break-words text-destructive-text" role="alert"><span className="font-medium">{t("wfNodeError")}: </span>{step.error}</p> : null}
      {step.handoff ? <p className="break-words"><span className="font-medium">{t("wfNodeHandoff")}: </span>{step.handoff}</p> : null}
      {text ? (
        <div>
          <div className="mb-0.5 font-medium">{t("wfNodeOutput")}</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 font-mono text-[11px] leading-4">{text}</pre>
          {truncated ? <p className="mt-0.5 text-muted-foreground">{t("wfNodeOutputTruncated")}</p> : null}
        </div>
      ) : null}
      {step.threadId ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" data-testid={`wf-open-thread-${step.key}`} onClick={() => onOpenThread(step.threadId!)}>{t("wfNodeOpenThread")}</Button> : null}
    </li>
  );
}

/**
 * What a node panel is given. The default panel is read-only; the editor (W6) passes `renderNodePanel` to put its property
 * form in the same place, with the same selection.
 */
export type NodePanelContext = { node: ViewNode; nodeKey: string; locale: Locale; run: NodeRun | null; definitionOnly: boolean; readOnly: true | false; onOpenThread: (threadId: string) => void; onClose: () => void };
export type NodePanelRenderer = (context: NodePanelContext) => ReactNode;

export function NodePanel({ node, locale, run, definitionOnly, onOpenThread, onClose, draft = false }: Pick<NodePanelContext, "node" | "locale" | "run" | "definitionOnly" | "onOpenThread" | "onClose"> & { draft?: boolean }) {
  return (
    <Surface testId="wf-node-panel" aria-label={t("wfNodeDetail")}>
      <SurfaceHeader className="justify-between">
        <h3 className="min-w-0 truncate text-sm font-medium">{nodeTitle(node, locale)}</h3>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>{t("wfNodeClose")}</Button>
      </SurfaceHeader>
      <SurfaceBody>
        <p className="text-xs text-muted-foreground">{[node.role, node.uses].filter(Boolean).join(" · ")}</p>
        {node.excerpt ? <p className="break-words text-xs">{node.excerpt}</p> : null}
        {node.calls ? <p className="font-mono text-xs text-muted-foreground">{t("wfNodeCalls").replace("{id}", node.calls.id)}</p> : null}
        {node.out.length ? <p className="text-xs"><span className="text-muted-foreground">{t("wfOutputs")}: </span><span className="font-mono">{node.out.join(", ")}</span></p> : null}
        {node.stages.length ? <p className="text-xs"><span className="text-muted-foreground">{t("wfNodeStages")}: </span><span className="font-mono">{node.stages.join(", ")}</span></p> : null}
        {run && run.steps.length ? (
          <ul className="space-y-2">{run.steps.map((step, index) => <StepCard key={step.key} step={step} index={index} onOpenThread={onOpenThread} />)}</ul>
        ) : draft ? null : <p className="text-xs text-muted-foreground">{definitionOnly ? t("wfNodeNoRunDefinition") : t("wfNodeNoRun")}</p>}
      </SurfaceBody>
    </Surface>
  );
}

/**
 * One workflow: its graph, and the runs it has had. A run is the same graph with a status on every node, read from the
 * engine's journal and re-read when the server signals a change in the project (or on a slow poll while one is active).
 */
export function WorkflowDetail({ id, projectId, locale, onBack, renderNodePanel, editProjectId = projectId, onEditDraft }: {
  id: string; projectId: string | null; locale: Locale; onBack: () => void; renderNodePanel?: NodePanelRenderer;
  /** Editing starts a draft in this project (the tab's project, or the one the page has open); without it, or without `onEditDraft`, the workflow is only shown. */
  editProjectId?: string | null; onEditDraft?: (draftId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useObservedWidth(rootRef);
  const [detail, setDetail] = useState<Detail | null | "missing">(null);
  const [error, setError] = useState<string | null>(null);
  // `null` shows the definition; a run id shows that run. `follow` keeps the newest active run on screen until the owner picks one.
  const [runId, setRunId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [snapshotGone, setSnapshotGone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [expanded, setExpanded] = useState<ReadonlyMap<string, { graph: WorkflowView; snapshot: RunSnapshot | null }>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const scope = projectId ?? undefined;
  const modelCatalog = useModelCatalog();
  const stepModels = useStepExecutors({ workflowId: id, projectId, revision: detail && detail !== "missing" ? `${detail.version}:${detail.sha256}` : null });

  const loadDetail = useCallback(async () => {
    try {
      const result = await rpc.call("workflow_get", { id, ...(scope ? { projectId: scope } : {}) });
      setError(null);
      setDetail(result.workflow ?? "missing");
      return result.workflow;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
  }, [id, scope, rpc]);

  const loadSnapshot = useCallback(async (target: string | null) => {
    if (!target) { setSnapshot(null); setSnapshotGone(false); return; }
    const mine = ++generation.current;
    try {
      const result = await rpc.call("workflow_run_snapshot", { runId: target });
      if (mine !== generation.current) return;
      setSnapshot(result.snapshot);
      setSnapshotGone(!result.snapshot);
      // The child runs behind expanded subworkflow nodes move with the parent.
      const next = new Map<string, { graph: WorkflowView; snapshot: RunSnapshot | null }>();
      let changed = false;
      for (const [key, entry] of expandedRef.current) {
        if (!entry.snapshot) { next.set(key, entry); continue; }
        const fresh = await rpc.call("workflow_run_snapshot", { runId: entry.snapshot.run.id }).then((value) => value.snapshot).catch(() => null);
        next.set(key, fresh ? { graph: fresh.graph, snapshot: fresh } : entry);
        changed = changed || Boolean(fresh);
      }
      if (changed && mine === generation.current) setExpanded(next);
    } catch { /* a missed read is repaired by the next signal or poll */ }
  }, [rpc]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // A different workflow starts from its definition.
  useEffect(() => {
    setDetail(null); setRunId(null); setFollow(true); setSnapshot(null); setSelected(null); setExpanded(new Map()); setError(null);
    void loadDetail().then((workflow) => { const pick = workflow ? pickRun(workflow.runs) : null; if (pick && isActive(pick.status)) setRunId(pick.id); });
  }, [loadDetail]);
  useEffect(() => { void loadSnapshot(runId); }, [runId, loadSnapshot]);

  const runs = detail && detail !== "missing" ? detail.runs : [];
  const active = Boolean(snapshot && isActive(snapshot.run.status)) || runs.some((run) => isActive(run.status));

  const refresh = useCallback(async (signalRun: string | null) => {
    const fresh = await loadDetail();
    if (fresh && follow) {
      const pick = pickRun(fresh.runs);
      const shown = fresh.runs.find((row) => row.id === runId);
      // A newer run that is active takes over the screen (its snapshot is read by the effect on `runId`); an older one never pulls it away.
      if (pick && isActive(pick.status) && pick.id !== runId && (!shown || pick.createdAt > shown.createdAt)) { setRunId(pick.id); return; }
    }
    if (!runId) return;
    const children = [...expandedRef.current.values()].map((entry) => entry.snapshot?.run.id);
    if (!signalRun || signalRun === runId || children.includes(signalRun)) await loadSnapshot(runId);
  }, [loadDetail, loadSnapshot, runId, follow]);

  // Signals come in bursts (every step writes several events): one read at a time, and one more after it if more arrived.
  const reading = useRef<{ busy: boolean; again: { run: string | null } | null }>({ busy: false, again: null });
  const schedule = useCallback((signalRun: string | null) => {
    const state = reading.current;
    if (state.busy) { state.again = { run: state.again && state.again.run !== signalRun ? null : signalRun }; return; }
    state.busy = true;
    void refresh(signalRun).finally(() => {
      state.busy = false;
      const next = state.again;
      state.again = null;
      if (next) schedule(next.run);
    });
  }, [refresh]);
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["workflow"], (signal) => scheduleRef.current(signal?.runId ?? null));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => scheduleRef.current(null), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs]);

  // Only the snapshot of the run on screen counts: the previous run's stays in state for a moment after the owner picks another.
  const current = snapshot && snapshot.run.id === runId ? snapshot : null;
  const graph: WorkflowView | null = current ? current.graph : detail && detail !== "missing" ? detail.graph : null;
  const runMode = current !== null;

  const { runStates, takenEdges } = useMemo(() => {
    if (!current) return { runStates: undefined, takenEdges: undefined };
    const top = runView(current);
    const states = new Map(top.runs);
    const edges = new Set(top.edges);
    for (const [key, entry] of expanded) {
      if (!entry.snapshot) continue;
      const inner = runView(entry.snapshot, key);
      for (const [innerKey, value] of inner.runs) states.set(innerKey, value);
      for (const edge of inner.edges) edges.add(edge);
      // The group shows the child run's status.
      const parent = states.get(key);
      if (parent) states.set(key, { ...parent, status: ({ running: "running", waiting: "waiting", succeeded: "done" } as Record<string, NodeRun["status"]>)[entry.snapshot.run.status] ?? "failed" });
    }
    return { runStates: states, takenEdges: edges };
  }, [current, expanded]);

  const expansions = useMemo<Expansions>(() => new Map([...expanded].map(([key, entry]) => [key, entry.graph])), [expanded]);

  const openThread = useCallback((threadId: string, title: string) => {
    if (!navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: title.slice(0, 40), params: { threadId } })) navigate.toThread(threadId);
  }, [navigate]);

  const lookup = (key: string): ViewNode | null => {
    const parts = key.split("/");
    let nodes = graph?.nodes ?? [];
    let found: ViewNode | null = null;
    for (let index = 0; index < parts.length; index++) {
      found = nodes.find((node) => node.id === parts[index]) ?? null;
      const inner = expanded.get(parts.slice(0, index + 1).join("/"));
      nodes = inner?.graph.nodes ?? [];
    }
    return found;
  };

  const onSelect = (key: string | null, node: ViewNode | null) => {
    setSelected(key);
    if (!key || !node) return;
    // A node that ran in a chat opens that chat in BB's side panel, and its details stay here.
    const steps = runStates?.get(key)?.steps ?? [];
    const last = [...steps].reverse().find((step) => step.threadId);
    if (last?.threadId) openThread(last.threadId, nodeTitle(node, locale));
  };

  const toggle = (key: string, node: ViewNode) => {
    if (expanded.has(key)) {
      setExpanded((current) => new Map([...current].filter(([other]) => other !== key && !other.startsWith(`${key}/`))));
      return;
    }
    const calls = node.calls;
    if (!calls) return;
    setLoading((current) => new Set(current).add(key));
    void (async () => {
      try {
        // In a run the child run behind the node is drawn with its statuses; otherwise (or before it started) the called definition.
        const parentKey = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : null;
        const parentSnapshot = parentKey ? expanded.get(parentKey)?.snapshot ?? null : current;
        const stepKeys = new Set((parentSnapshot?.steps ?? []).filter((step) => step.nodeId === node.id).map((step) => step.key));
        const child = [...(parentSnapshot?.children ?? [])].reverse().find((row) => stepKeys.has(row.stepKey));
        const childSnapshot = child ? (await rpc.call("workflow_run_snapshot", { runId: child.runId })).snapshot : null;
        if (childSnapshot) { setExpanded((current) => new Map(current).set(key, { graph: childSnapshot.graph, snapshot: childSnapshot })); return; }
        const definition = (await rpc.call("workflow_get", { id: calls.id, ...(scope ? { projectId: scope } : {}) })).workflow;
        if (definition) setExpanded((current) => new Map(current).set(key, { graph: definition.graph, snapshot: null }));
      } catch { /* the node stays collapsed */ } finally {
        setLoading((current) => { const next = new Set(current); next.delete(key); return next; });
      }
    })();
  };

  const startEdit = async (workflow: Detail) => {
    if (!editProjectId || !onEditDraft) return;
    setStarting({ busy: true, error: null });
    try {
      // A built-in workflow is read-only: it is copied under a new id; an own one is edited in place (its draft replaces its file when published).
      const result = await rpc.call("workflow_draft_create", { projectId: editProjectId, workflowId: workflow.id, mode: workflow.scope === "builtin" ? "duplicate" : "edit", scope: projectId ? "project" : "global" });
      if (!result.draftId) throw new Error(result.reason ?? "no draft");
      setStarting({ busy: false, error: null });
      onEditDraft(result.draftId);
    } catch (cause) { setStarting({ busy: false, error: cause instanceof Error ? cause.message : String(cause) }); }
  };

  /** A model chosen for an own workflow opens a draft of it with the change; the choice is checked against the catalog first, so a refused one opens nothing. */
  const chooseModel = async (workflow: Detail, nodeId: string, choice: ModelChoice | null): Promise<string | null> => {
    if (!editProjectId || !onEditDraft || !modelCatalog) return t("wfEditStartError").replace("{error}", "-");
    const refused = choice ? choiceRefusal(modelCatalog, choice) : null;
    if (refused) return issueText(refused.code === "no_effort" ? "no_effort" : refused.code);
    setStarting({ busy: true, error: null });
    try {
      const created = await rpc.call("workflow_draft_create", { projectId: editProjectId, workflowId: workflow.id, mode: "edit", scope: projectId ? "project" : "global" });
      if (!created.draftId) throw new Error(created.reason ?? "no draft");
      const doc = await getDraft(rpc, created.draftId);
      if (!doc || typeof doc.workflow !== "object" || doc.workflow === null) throw new Error("no draft");
      const definition = doc.workflow as Record<string, unknown>;
      const made = choice ? choiceOps(definition, modelCatalog, nodeId, choice) : { ok: true as const, ops: clearModelOps(definition, nodeId) ?? [] };
      if (!made.ok) { setStarting({ busy: false, error: null }); return issueText(made.code); }
      if (!made.ops.length) { setStarting({ busy: false, error: null }); return issueText("no_node"); }
      const patched = await rpc.call("workflow_draft_patch", { draftId: created.draftId, ops: made.ops, ...(doc.version ? { expectedVersion: doc.version } : {}) });
      if (!patched.ok) throw new Error("the draft refused the change");
      setStarting({ busy: false, error: null });
      onEditDraft(created.draftId);
      return null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStarting({ busy: false, error: message });
      return message;
    }
  };

  const selectedNode = selected ? lookup(selected) : null;
  const direction = width > 0 && width < 560 ? "DOWN" : "RIGHT";

  if (detail === "missing") return <p className="text-sm text-muted-foreground" data-testid="wf-missing">{t("wfRunGone")}</p>;
  if (!detail) return <div ref={rootRef}>{error ? <p role="alert" className="text-sm text-destructive">{t("wfLoadError")}: {error}</p> : <p className="text-sm text-muted-foreground" role="status">{t("wfLoading")}</p>}</div>;

  const runLabel = (row: RunRow) => `${t(RUN_STATUS_KEY[row.status] ?? "wfRunStatus_failed")} · ${when(row.createdAt)}`;
  return (
    <div ref={rootRef} className="min-w-0 space-y-4" data-testid="workflow-detail">
      <div className="lp-strip space-y-1.5">
        <Button type="button" size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-xs text-muted-foreground" onClick={onBack} data-testid="wf-back">‹ {t("wfBack")}</Button>
        <h2 className="break-words text-xl font-medium">{detail.name[locale]}</h2>
        <p className="break-words text-xs text-muted-foreground">{detail.description[locale]}</p>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="lp-pill-neutral rounded-full px-2 py-0.5 text-[11px] font-medium">{t(`wfStatus_${detail.status}` as I18nKey)}</span>
          <span className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px] font-medium">{t(`wfScope_${detail.scope}` as I18nKey)}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{detail.id} · {t("wfVersion").replace("{n}", String(detail.version))}</span>
          {editProjectId && onEditDraft ? (
            <Button type="button" size="sm" variant="outline" className="lp-raised ml-auto h-7 px-2.5 text-xs" disabled={starting.busy} data-testid="wf-edit-start" onClick={() => void startEdit(detail)}>
              {starting.busy ? t("wfEditStarting") : detail.scope === "builtin" ? t("wfDuplicateToEdit") : t("wfEditThis")}
            </Button>
          ) : null}
        </div>
        {detail.scope === "builtin" && editProjectId && onEditDraft ? <p className="text-xs text-muted-foreground" data-testid="wf-builtin-note">{t("wfBuiltinReadOnly")}</p> : null}
        {starting.error ? <p className="break-words text-xs text-destructive" role="alert" data-testid="wf-edit-start-error">{t("wfEditStartError").replace("{error}", starting.error)}</p> : null}
      </div>

      <Surface testId="wf-graph-panel">
        <SurfaceHeader className="flex-wrap justify-between">
          <h3 className="text-sm font-medium">{t("wfGraphHeading")}</h3>
          <Select value={runId ?? DEFINITION} onValueChange={(value) => { setRunId(value === DEFINITION ? null : value); setFollow(false); setSelected(null); }}>
            <SelectTrigger aria-label={t("wfRunPick")} className="h-8 w-full min-w-0 text-xs sm:w-72" data-testid="wf-run-pick">
              <SelectValue>
                {runId && runs.some((row) => row.id === runId)
                  ? <span className="flex min-w-0 items-center gap-2"><StatusDot status={runs.find((row) => row.id === runId)!.status} /><span className="truncate">{runLabel(runs.find((row) => row.id === runId)!)}</span></span>
                  : t("wfDefinition")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFINITION} data-testid="wf-pick-definition">{t("wfDefinition")}</SelectItem>
              {runs.map((row) => (
                <SelectItem key={row.id} value={row.id} data-testid={`wf-pick-run-${row.id}`}>
                  <span className="flex items-center gap-2"><StatusDot status={row.status} />{runLabel(row)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SurfaceHeader>
        <SurfaceBody className="space-y-2">
          {current ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="wf-run-summary">
              <span className={`${runPill(current.run.status)} rounded-full px-2 py-0.5 text-[11px] font-medium`}>{t(RUN_STATUS_KEY[current.run.status] ?? "wfRunStatus_failed")}</span>
              <span className="text-muted-foreground">{t("wfRunSummary").replace("{steps}", String(current.steps.length)).replace("{tokens}", current.run.tokens.toLocaleString())}</span>
              {current.run.reason ? <span className="min-w-0 break-words text-muted-foreground">{t("wfRunReason").replace("{reason}", current.run.reason)}</span> : null}
            </div>
          ) : null}
          {runId && snapshotGone ? <p className="text-xs text-muted-foreground">{t("wfRunGone")}</p> : null}
          {!runs.length && !runId ? <p className="text-xs text-muted-foreground">{t("wfRunNone")}</p> : null}
          {graph ? (
            <Suspense fallback={<p className="py-10 text-center text-xs text-muted-foreground" role="status">{t("wfGraphLoading")}</p>}>
              <WorkflowGraph graph={graph} locale={locale} expansions={expansions} runs={runStates} takenEdges={takenEdges} selected={selected} loadingKeys={loading}
                onSelect={onSelect} onToggleExpand={toggle} direction={direction} height={direction === "DOWN" ? 420 : 460}
                {...(runMode ? {} : { models: { executors: stepModels.byNode, providers: providerMap(modelCatalog) } })} />
            </Suspense>
          ) : null}
        </SurfaceBody>
      </Surface>

      {selectedNode ? (() => {
        const context: NodePanelContext = { node: selectedNode, nodeKey: selected!, locale, run: runStates?.get(selected!) ?? null, definitionOnly: !runMode, readOnly: true,
          onOpenThread: (threadId) => openThread(threadId, nodeTitle(selectedNode, locale)), onClose: () => setSelected(null) };
        return renderNodePanel ? renderNodePanel(context) : <NodePanel {...context} />;
      })() : null}

      <ModelsPanel graph={detail.graph} locale={locale} executors={stepModels.list} loaded={stepModels.loaded} catalog={modelCatalog} wide={width >= 720} busy={starting.busy}
        access={detail.scope === "builtin" ? "builtin" : editProjectId && onEditDraft ? "own" : "readonly"} onChoose={(nodeId, choice) => chooseModel(detail, nodeId, choice)}
        onDuplicate={editProjectId && onEditDraft ? () => void startEdit(detail) : null} />

      <Surface testId="wf-info">
        <SurfaceHeader><h3 className="text-sm font-medium">{t("wfDefinition")}</h3></SurfaceHeader>
        <SurfaceBody>
          <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfInputs")}</dt><dd><FieldList fields={detail.inputs} /></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfOutputs")}</dt><dd><FieldList fields={detail.outputs} /></dd></div>
            {detail.triggers.length ? <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfTriggers")}</dt><dd className="break-words text-xs">{detail.triggers.join(", ")}</dd></div> : null}
            {detail.requires.length ? <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfRequires")}</dt><dd className="break-words text-xs">{detail.requires.join(", ")}</dd></div> : null}
            <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfBudget")}</dt><dd className="break-words text-xs">{budgetText(detail.budget) || t("wfNoFields")}</dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs font-medium">{t("wfSource")}</dt><dd className="break-all font-mono text-[11px] text-muted-foreground">{detail.source}</dd></div>
          </dl>
          {detail.examples[locale].length ? (
            <div><p className="mb-1 text-xs font-medium">{t("wfExamples")}</p><ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{detail.examples[locale].map((line) => <li key={line} className="break-words">{line}</li>)}</ul></div>
          ) : null}
          {detail.warningMessages.length ? (
            <div><p className="mb-1 text-xs font-medium">{t("wfWarnings")}</p><ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{detail.warningMessages.map((line) => <li key={line} className="break-words">{line}</li>)}</ul></div>
          ) : null}
        </SurfaceBody>
      </Surface>
    </div>
  );
}

const budgetText = (budget: Detail["budget"]) => [
  budget.maxSteps !== null ? t("wfBudgetSteps").replace("{n}", String(budget.maxSteps)) : null,
  budget.maxTokens !== null ? t("wfBudgetTokens").replace("{n}", budget.maxTokens.toLocaleString()) : null,
  budget.maxCostUsd !== null ? t("wfBudgetCost").replace("{n}", String(budget.maxCostUsd)) : null,
  budget.maxWallSeconds !== null ? t("wfBudgetSeconds").replace("{n}", String(budget.maxWallSeconds)) : null,
].filter(Boolean).join(" · ");
