import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract, stepExecutorSchema } from "../../contracts";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import type { CatalogProvider, ModelCatalog } from "@lane-pilot/models";
import type { ViewNode, WorkflowView } from "@lane-pilot/workflow-engine/ui";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { nodeTitle } from "./workflow-titles";

/**
 * The model view of a graph: a badge on each card (who works, on which provider and model, how hard), a table of every step, and the
 * data both read from the server (`workflow_step_executors`, `workflow_model_catalog`). READ-ONLY: the model belongs to the step's
 * role (the table «role -> model» in Settings), and nothing on a step changes it.
 */
export type StepExecutor = z.infer<typeof stepExecutorSchema>;
type Call = (method: string, input: unknown) => Promise<unknown>;

// ------------------------------------------------------------------ data

/** The hub's providers and models; null while it is read, or when no machine answered. */
export function useModelCatalog(projectId?: string | null): ModelCatalog | null {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    let live = true;
    // With the project the answer says which machine its helpers run on: the pickers list and check that machine's models.
    void Promise.resolve(rpc.call("workflow_model_catalog", projectId ? { projectId } : {})).then((value) => { if (live && value) setCatalog(value as ModelCatalog); }, () => undefined);
    return () => { live = false; };
  }, [rpc, projectId]);
  return catalog;
}

/** Who works on each step of a workflow or a draft; read again when `revision` changes (a draft's version) or the settings it reads change. */
export function useStepExecutors(target: { workflowId?: string; draftId?: string; projectId: string | null; revision?: string | number | null }): { loaded: boolean; list: StepExecutor[]; byNode: ReadonlyMap<string, StepExecutor>; reload: () => void } {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [state, setState] = useState<{ loaded: boolean; list: StepExecutor[] }>({ loaded: false, list: [] });
  const [again, setAgain] = useState(0);
  const { workflowId, draftId, projectId, revision } = target;
  useEffect(() => {
    if (!workflowId && !draftId) return;
    let live = true;
    const input = { ...(workflowId ? { workflowId } : {}), ...(draftId ? { draftId } : {}), ...(projectId ? { projectId } : {}) };
    void Promise.resolve(rpc.call("workflow_step_executors", input)).then(
      (value) => { if (live) setState({ loaded: true, list: (value as { executors?: StepExecutor[] }).executors ?? [] }); },
      () => { if (live) setState({ loaded: true, list: [] }); },
    );
    return () => { live = false; };
  }, [rpc, workflowId, draftId, projectId, revision, again]);
  // The cards of the graph are the nodes of this workflow; the steps of the workflows it calls are in the table only.
  const byNode = useMemo(() => new Map(state.list.filter((row) => !row.fragment).map((row) => [row.nodeId, row])), [state.list]);
  const reload = useCallback(() => setAgain((n) => n + 1), []);
  return { loaded: state.loaded, list: state.list, byNode, reload };
}

/** What a card needs: the executor of each node and the catalog's names and logos of the providers. */
export type GraphModels = {
  executors: ReadonlyMap<string, StepExecutor>; providers: ReadonlyMap<string, Pick<CatalogProvider, "displayName" | "logoUrl">>;
};
export const providerMap = (catalog: ModelCatalog | null): GraphModels["providers"] => new Map((catalog?.providers ?? []).map((row) => [row.id, { displayName: row.displayName, logoUrl: row.logoUrl }]));

/** The id of a row of the table: a step of a called workflow is `<workflow>/<node>`, as its override is keyed. */
export const rowId = (executor: Pick<StepExecutor, "nodeId" | "fragment">): string => (executor.fragment ? `${executor.fragment.workflowId}/${executor.nodeId}` : executor.nodeId);

/** The model block of the step panel (the «Parameters» tab): the line the step runs on and where it comes from; the model is the role's. */
export function StepModelBlock({ executor, models }: { executor: StepExecutor; models: GraphModels; title?: string }) {
  if (executor.mode === "none") return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-[var(--lp-hairline)] p-2.5" data-testid="wf-panel-model" data-source={executor.source}>
      <p className="text-[11px] font-medium text-muted-foreground">{t("wfModelsColModel")}</p>
      <div className="flex min-w-0 items-center gap-1.5 text-xs" data-testid="wf-panel-model-line">
        <ProviderMark id={executor.providerId} logoUrl={executor.providerId ? models.providers.get(executor.providerId)?.logoUrl : null} />
        <span className="min-w-0 truncate" title={executor.model ?? ""}>{executorLine(executor)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="wf-panel-model-source">{t("wfModelFrom").replace("{source}", sourceText(executor))}</p>
      <p className="text-[11px] text-muted-foreground">{t("wfModelsRoleHint")}</p>
    </div>
  );
}

/** The executor of a graph card. A draft draws a parallel as one card, so its body's model is shown on it; a lowered graph has the body as a card of its own. */
export function executorFor(executors: ReadonlyMap<string, StepExecutor>, view: ViewNode): StepExecutor | undefined {
  return executors.get(view.id) ?? (view.kind === "parallel" && !view.id.endsWith(":fan") ? executors.get(`${view.id}:child`) : undefined);
}

// ------------------------------------------------------------------ names

/** `acp-cursor` is shown as `cursor`. */
export const providerShort = (id: string | null): string => (id ? id.replace(/^acp-/, "") : "");
/** `router9/ag/gemini-3.8-flash-high` is shown as `gemini-3.8-flash-high`. */
export const modelShort = (model: string | null): string => (model ? model.slice(model.lastIndexOf("/") + 1) : "");

export function sourceText(executor: Pick<StepExecutor, "source" | "sourceKey" | "settingsKey">): string {
  switch (executor.source) {
    case "table": return t("wfModelSrc_table");
    case "pinned": return t("wfModelSrc_pinned");
    case "stage": return t("wfModelSrc_stage").replace("{key}", executor.sourceKey ?? executor.settingsKey ?? "");
    case "pm": return t("wfModelSrc_pm");
    case "role-default": return t("wfModelSrc_role_default");
    case "writer": return `${t("wfModelSrc_writer")}${executor.sourceKey ? ` (${executor.sourceKey})` : ""}`;
    case "helper": return t("wfModelSrc_helper");
    case "session": return t("wfModelSrc_session").replace("{step}", executor.sourceKey ?? "");
    default: return t("wfModelSrc_none");
  }
}

const COST_PILL: Record<StepExecutor["costTier"], string> = { none: "lp-pill-muted", low: "lp-pill-success", medium: "lp-pill-neutral", high: "lp-pill-warning", unknown: "lp-pill-muted" };
const ISSUE_INFO = new Set(["effort_auto"]);
export const realIssues = (executor: StepExecutor): string[] => executor.issues.filter((code) => !ISSUE_INFO.has(code));
export const issueText = (code: string): string => {
  const key = `wfModelIssue_${code}` as I18nKey;
  try { const text = t(key); return text === key ? code : text; } catch { return code; }
};

// ------------------------------------------------------------------ the badge on a card

/** «codex · gpt-6-luna · high · fast», the badge text and the read-only cell. */
export const executorLine = (executor: StepExecutor): string =>
  [providerShort(executor.providerId), modelShort(executor.model), executor.reasoningEffort, executor.serviceTier === "fast" ? t("wfModelFast") : null].filter(Boolean).join(" · ") || t("wfModelSrc_none");

export function ProviderMark({ id, logoUrl }: { id: string | null; logoUrl?: string | null }) {
  // The logo is drawn as a mask in the text colour (as BB does); a provider without one gets its first letter, written by CSS so it is not read as text.
  return logoUrl
    ? <span className="lp-model-logo" aria-hidden style={{ maskImage: `url(${logoUrl})`, WebkitMaskImage: `url(${logoUrl})` }} />
    : <span className="lp-model-logo lp-model-letter" aria-hidden data-letter={providerShort(id).slice(0, 1).toUpperCase()} />;
}

/** «codex · gpt-6-luna · medium», dimmed when the value is inherited; the tooltip says where it comes from. A code task also shows its fallbacks. */
export function ModelBadge({ executor, providers, id }: { executor: StepExecutor; providers: GraphModels["providers"]; id: string }) {
  if (executor.mode === "none") return null;
  const text = executorLine(executor);
  const problems = realIssues(executor);
  const chain = executor.mode === "chain" ? executor.fallbacks.map((row) => (row.pm ? t("wfModelChainPm") : modelShort(row.model))).filter(Boolean) : [];
  const title = [
    t("wfModelFrom").replace("{source}", sourceText(executor)),
    ...(executor.mode === "chain" ? [`${t("wfModelChain")}: ${[executor, ...executor.fallbacks].map((row) => ("pm" in row && row.pm ? t("wfModelChainPm") : `${providerShort(row.providerId)}/${modelShort(row.model)}`)).join(" → ")}`] : []),
    ...problems.map(issueText),
  ].join("\n");
  return (
    <div className="lp-wf-models" data-testid={`wf-model-${id}`} data-source={executor.source} data-inherited={executor.inherited ? "1" : "0"} data-issue={problems.length ? "1" : "0"} data-mode={executor.mode} title={title}>
      <span className="lp-wf-model">
        <ProviderMark id={executor.providerId} logoUrl={executor.providerId ? providers.get(executor.providerId)?.logoUrl : null} />
        <span className="lp-wf-model-text">{text}</span>
      </span>
      {chain.length ? <span className="lp-wf-chain" data-testid={`wf-chain-${id}`}>→ {chain.join(" → ")}</span> : null}
    </div>
  );
}

/** The model on a graph card: a badge, with the source in its tooltip. The model is the role's, so there is nothing to pick here. */
export function CardModel({ executor, models, id }: { executor: StepExecutor; models: GraphModels; id: string }) {
  if (executor.mode === "none") return null;
  return <ModelBadge executor={executor} providers={models.providers} id={id} />;
}

// ------------------------------------------------------------------ the table

type Hosts = ModelCatalog["hosts"];

const hostNames = (ids: readonly string[], hosts: Hosts): string => ids.map((id) => hosts.find((host) => host.id === id)?.name ?? id).join(", ");
/** Where an entry is offered: nothing when it is on every connected machine, else the machines' names. */
export const offeredOn = (ids: readonly string[], hosts: Hosts): string => {
  if (!ids.length) return t("wfModelNotAvailable");
  const connected = hosts.filter((host) => host.connected).map((host) => host.id);
  return connected.length && connected.every((id) => ids.includes(id)) ? "" : t("wfModelOn").replace("{hosts}", hostNames(ids, hosts));
};

function ReadOnlyCells({ executor }: { executor: StepExecutor }) {
  return <div className="min-w-0 truncate text-xs" title={executor.model ?? ""} data-label={t("wfModelsColModel")} data-testid={`wf-model-line-${rowId(executor)}`}>{executorLine(executor)}</div>;
}

function ModelsRow({ executor, view, locale, wide }: { executor: StepExecutor; view: ViewNode | undefined; locale: Locale; wide: boolean }) {
  const title = view ? nodeTitle(view, locale) : executor.nodeId;
  const rid = rowId(executor);
  const problems = realIssues(executor);
  const notes = executor.issues.filter((code) => ISSUE_INFO.has(code));
  return (
    <li className="lp-model-row" data-testid={`wf-model-row-${rid}`} data-wide={wide ? "1" : "0"} data-inherited={executor.inherited ? "1" : "0"} data-issue={problems.length ? "1" : "0"}>
      <div className="min-w-0" data-label={t("wfModelsColStep")}>
        <div className="truncate text-sm font-medium" title={title}>{title}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{rid}</div>
      </div>
      <div className="min-w-0 truncate text-xs" title={executor.agent.helper ?? ""} data-label={t("wfModelsColAgent")} data-testid={`wf-model-agent-${rid}`}>{executor.agent.label}</div>
      <ReadOnlyCells executor={executor} />
      <div className="min-w-0 text-xs text-muted-foreground" data-label={t("wfModelsColSource")} data-testid={`wf-model-source-${rid}`} data-source={executor.source}>
        <span className={executor.inherited ? "italic" : "text-foreground"}>{sourceText(executor)}</span>
      </div>
      <div className="min-w-0" data-label={t("wfModelsColCost")}><span className={`${COST_PILL[executor.costTier]} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={`wf-model-cost-${rid}`}>{t(`wfModelCost_${executor.costTier}` as I18nKey)}</span></div>
      {executor.mode === "chain" ? (
        <div className="lp-model-extra" data-testid={`wf-model-chain-${rid}`}>
          <span className="font-medium">{t("wfModelChain")}:</span>{" "}
          {executor.fallbacks.map((row, index) => <span key={index}>→ {row.pm ? (row.model ? `${t("wfModelChainPm")} (${modelShort(row.model)})` : t("wfModelChainPm")) : `${providerShort(row.providerId)} · ${modelShort(row.model)}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ""}`} </span>)}
          {executor.parts.map((part) => <span key={part.stage} className="block">{t("wfModelCritic")}: {[providerShort(part.providerId), modelShort(part.model), part.reasoningEffort].filter(Boolean).join(" · ")}</span>)}
        </div>
      ) : null}
      {executor.settingsKey ? <div className="lp-model-extra text-muted-foreground">{t("wfModelSetIn").replace("{key}", executor.settingsKey)}</div> : null}
      {problems.length || notes.length ? (
        <div className="lp-model-extra">
          {problems.map((code) => <p key={code} className="break-words lp-text-warning" data-testid={`wf-model-issue-${rid}-${code}`}>{issueText(code)}</p>)}
          {notes.map((code) => <p key={code} className="break-words text-muted-foreground">{issueText(code)}</p>)}
        </div>
      ) : null}
    </li>
  );
}

/**
 * One row per step that has a model: who works there, provider, model and effort, where the value comes from (the role's row of the
 * table in Settings, named), and a price class. Read-only.
 */
export function ModelsPanel({ graph, locale, executors, loaded, catalog, wide }: {
  graph: WorkflowView; locale: Locale; executors: readonly StepExecutor[]; loaded: boolean; catalog: ModelCatalog | null; wide: boolean;
}): ReactNode {
  const views = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const withModel = executors.filter((row) => row.mode !== "none");
  const without = executors.filter((row) => row.mode === "none" && !row.fragment);
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of withModel) counts.set(providerShort(row.providerId) || "?", (counts.get(providerShort(row.providerId) || "?") ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [withModel]);
  const hint = t("wfModelsRoleHint");
  return (
    <Surface testId="wf-models-panel" aria-label={t("wfModels")}>
      <SurfaceHeader className="flex-wrap justify-between gap-2">
        <h3 className="text-sm font-medium">{t("wfModels")}</h3>
        {withModel.length ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="wf-models-summary">
            <span>{t("wfModelsSummary").replace("{n}", String(withModel.length))}</span>
            {summary.map(([name, count]) => <span key={name} className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px] font-medium">{name} {count}</span>)}
          </span>
        ) : null}
      </SurfaceHeader>
      <SurfaceBody className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 break-words text-xs text-muted-foreground" data-testid="wf-models-hint">{hint}</p>
        </div>
        {!loaded ? <p className="text-xs text-muted-foreground" role="status">{t("wfModelsLoading")}</p> : null}
        {loaded && !withModel.length ? <p className="text-xs text-muted-foreground" data-testid="wf-models-empty">{t("wfModelsEmpty")}</p> : null}
                {withModel.length ? (
          <>
            {wide ? (
              <div className="lp-model-head" aria-hidden data-wide="1">
                {(["wfModelsColStep", "wfModelsColAgent", "wfModelsColModel", "wfModelsColSource", "wfModelsColCost"] as const).map((key) => <span key={key}>{t(key)}</span>)}
              </div>
            ) : null}
            <ul className="lp-model-list" data-testid="wf-models-list">
              {withModel.map((row, index) => (
                <Fragment key={rowId(row)}>
                  {row.fragment && withModel[index - 1]?.fragment?.workflowId !== row.fragment.workflowId ? (
                    <li className="lp-model-group" data-testid={`wf-model-group-${row.fragment.workflowId}`} role="presentation">
                      {t("wfModelsFragment").replace("{workflow}", row.fragment.workflowId).replace("{step}", row.fragment.nodeId)}
                    </li>
                  ) : null}
                  <ModelsRow executor={row} view={row.fragment ? undefined : views.get(row.nodeId) ?? views.get(row.nodeId.replace(/:child$/, ""))} locale={locale} wide={wide} />
                </Fragment>
              ))}
            </ul>
          </>
        ) : null}
        {without.length ? <p className="break-words text-xs text-muted-foreground" data-testid="wf-models-none">{t("wfModelsNone").replace("{steps}", without.slice(0, 14).map((row) => row.nodeId).join(", ") + (without.length > 14 ? ` +${without.length - 14}` : ""))}</p> : null}
      </SurfaceBody>
    </Surface>
  );
}
