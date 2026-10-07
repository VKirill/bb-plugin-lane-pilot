import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract, stepExecutorSchema } from "../contracts";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import type { CatalogProvider, ModelCatalog } from "../workflow/model-catalog";
import type { ViewNode, WorkflowView } from "../workflow/view-core";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";
import type { ModelChoice } from "./workflow-model-ops";
import { NativeModelPicker } from "./workflow-native-picker";
import { nodeTitle } from "./workflow-titles";

/**
 * The model view of a workflow: a badge on each card (who works, on which provider and model, how hard), a table of every step with
 * pickers to change them, and the data both read from the server (`workflow_step_executors`, `workflow_model_catalog`).
 */
export type StepExecutor = z.infer<typeof stepExecutorSchema>;
type Call = (method: string, input: unknown) => Promise<unknown>;

// ------------------------------------------------------------------ data

/** The hub's providers and models; null while it is read, or when no machine answered. */
export function useModelCatalog(): ModelCatalog | null {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(rpc.call("workflow_model_catalog", {})).then((value) => { if (live && value) setCatalog(value as ModelCatalog); }, () => undefined);
    return () => { live = false; };
  }, [rpc]);
  return catalog;
}

/** Who works on each step of a workflow or a draft; read again when `revision` changes (a draft's version) or the settings it reads change. */
export function useStepExecutors(target: { workflowId?: string; draftId?: string; projectId: string | null; revision?: string | number | null }): { loaded: boolean; list: StepExecutor[]; byNode: ReadonlyMap<string, StepExecutor> } {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [state, setState] = useState<{ loaded: boolean; list: StepExecutor[] }>({ loaded: false, list: [] });
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
  }, [rpc, workflowId, draftId, projectId, revision]);
  const byNode = useMemo(() => new Map(state.list.map((row) => [row.nodeId, row])), [state.list]);
  return { loaded: state.loaded, list: state.list, byNode };
}

/** What a card needs: the executor of each node and the catalog's names and logos of the providers. */
export type GraphModels = {
  executors: ReadonlyMap<string, StepExecutor>; providers: ReadonlyMap<string, Pick<CatalogProvider, "displayName" | "logoUrl">>;
  /** Choosing on the card: the hub's catalog and what a choice does (patch the draft, open a draft of an own workflow). A built-in offers «Duplicate to edit» instead. */
  catalog?: ModelCatalog | null; access?: ModelsAccess;
  onChoose?: (nodeId: string, choice: ModelChoice | null) => Promise<string | null>;
  onDuplicate?: (() => void) | null;
};
export const providerMap = (catalog: ModelCatalog | null): GraphModels["providers"] => new Map((catalog?.providers ?? []).map((row) => [row.id, { displayName: row.displayName, logoUrl: row.logoUrl }]));

/** The executor of a graph card. A draft draws a parallel as one card, so its body's model is shown on it; a lowered graph has the body as a card of its own. */
export function executorFor(executors: ReadonlyMap<string, StepExecutor>, view: ViewNode): StepExecutor | undefined {
  return executors.get(view.id) ?? (view.kind === "parallel" && !view.id.endsWith(":fan") ? executors.get(`${view.id}:child`) : undefined);
}

// ------------------------------------------------------------------ names

/** `acp-opencode` is shown as `opencode`. */
export const providerShort = (id: string | null): string => (id ? id.replace(/^acp-/, "") : "");
/** `router9/ag/gemini-3.8-flash-high` is shown as `gemini-3.8-flash-high`. */
export const modelShort = (model: string | null): string => (model ? model.slice(model.lastIndexOf("/") + 1) : "");

export function sourceText(executor: Pick<StepExecutor, "source" | "sourceKey" | "settingsKey">): string {
  switch (executor.source) {
    case "preset": return t("wfModelSrc_preset").replace("{key}", executor.sourceKey ?? "");
    case "stage": return t("wfModelSrc_stage").replace("{key}", executor.sourceKey ?? executor.settingsKey ?? "");
    case "agent": return t("wfModelSrc_agent").replace("{key}", executor.sourceKey ?? "");
    case "pm": return t("wfModelSrc_pm");
    case "role-default": return t("wfModelSrc_role_default");
    case "writer": return `${t("wfModelSrc_writer")}${executor.sourceKey ? ` (${executor.sourceKey})` : ""}`;
    case "helper": return t("wfModelSrc_helper");
    case "node": return t("wfModelSrc_node");
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

/**
 * The model on a graph card. Where the step holds its own model the badge is BB's native picker (provider tabs, model search, reasoning,
 * fast mode); on a built-in workflow the badge opens «Duplicate to edit»; elsewhere it is only a badge. A refusal is told under it.
 */
export function CardModel({ executor, models, id }: { executor: StepExecutor; models: GraphModels; id: string }) {
  const [refused, setRefused] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const { catalog, access, onChoose, onDuplicate } = models;
  if (executor.mode === "none") return null;
  const editable = executor.overridable && (access === "draft" || access === "own") && Boolean(onChoose) && Boolean(catalog?.providers.length);
  if (editable && catalog && onChoose) {
    return (
      <div className="lp-wf-card-model min-w-0">
        <NativeModelPicker catalog={catalog} testId={`wf-card-picker-${id}`} label={t("wfModelModelLabel").replace("{step}", id)} className="lp-wf-card-picker"
          seed={{ providerId: executor.providerId, model: executor.model, effort: executor.reasoningEffort, serviceTier: executor.serviceTier }}
          onChoose={(choice) => { setRefused(null); void onChoose(executor.nodeId, choice).then((reason) => setRefused(reason)); }} />
        {refused ? <p className="break-words text-[11px] text-destructive-text" role="alert" data-testid={`wf-card-refused-${id}`}>{t("wfModelRejected").replace("{reason}", refused)}</p> : null}
      </div>
    );
  }
  if (access === "builtin" && onDuplicate && executor.overridable) {
    return (
      <div className="lp-wf-card-model min-w-0 nodrag nopan" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <button type="button" className="lp-wf-model-button" aria-expanded={asking} data-testid={`wf-card-model-${id}`} onClick={() => setAsking(!asking)}>
          <ModelBadge executor={executor} providers={models.providers} id={id} />
        </button>
        {asking ? (
          <div className="lp-wf-dup" data-testid={`wf-card-duplicate-${id}`}>
            <p className="text-[11px] leading-4 text-muted-foreground">{t("wfModelsBuiltinHint")}</p>
            <Button type="button" size="sm" variant="outline" className="lp-raised mt-1 h-7 px-2 text-xs" onClick={onDuplicate}>{t("wfDuplicateToEdit")}</Button>
          </div>
        ) : null}
      </div>
    );
  }
  return <ModelBadge executor={executor} providers={models.providers} id={id} />;
}

// ------------------------------------------------------------------ the table

/** How a change reaches the workflow: into the draft being edited, into a draft opened for an own workflow, or not at all (built-in). */
export type ModelsAccess = "draft" | "own" | "builtin" | "readonly";
type Hosts = ModelCatalog["hosts"];

const hostNames = (ids: readonly string[], hosts: Hosts): string => ids.map((id) => hosts.find((host) => host.id === id)?.name ?? id).join(", ");
/** Where an entry is offered: nothing when it is on every connected machine, else the machines' names. */
export const offeredOn = (ids: readonly string[], hosts: Hosts): string => {
  if (!ids.length) return t("wfModelNotAvailable");
  const connected = hosts.filter((host) => host.connected).map((host) => host.id);
  return connected.length && connected.every((id) => ids.includes(id)) ? "" : t("wfModelOn").replace("{hosts}", hostNames(ids, hosts));
};

function ReadOnlyCells({ executor }: { executor: StepExecutor }) {
  return <div className="min-w-0 truncate text-xs" title={executor.model ?? ""} data-label={t("wfModelsColModel")} data-testid={`wf-model-line-${executor.nodeId}`}>{executorLine(executor)}</div>;
}

function ModelsRow({ executor, view, locale, catalog, access, wide, busy, onChoose }: {
  executor: StepExecutor; view: ViewNode | undefined; locale: Locale; catalog: ModelCatalog | null; access: ModelsAccess; wide: boolean; busy: boolean;
  onChoose: (nodeId: string, choice: ModelChoice | null) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const title = view ? nodeTitle(view, locale) : executor.nodeId;
  const editable = executor.overridable && access !== "builtin" && access !== "readonly" && catalog !== null && catalog.providers.length > 0;
  const choose = (choice: ModelChoice | null) => {
    setError(null);
    void onChoose(executor.nodeId, choice).then((refused) => setError(refused));
  };
  const problems = realIssues(executor);
  const notes = executor.issues.filter((code) => ISSUE_INFO.has(code));
  return (
    <li className="lp-model-row" data-testid={`wf-model-row-${executor.nodeId}`} data-wide={wide ? "1" : "0"} data-inherited={executor.inherited ? "1" : "0"} data-issue={problems.length ? "1" : "0"}>
      <div className="min-w-0" data-label={t("wfModelsColStep")}>
        <div className="truncate text-sm font-medium" title={title}>{title}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{executor.nodeId}</div>
      </div>
      <div className="min-w-0 truncate text-xs" title={executor.agent.helper ?? ""} data-label={t("wfModelsColAgent")} data-testid={`wf-model-agent-${executor.nodeId}`}>{executor.agent.label}</div>
      {editable && catalog ? (
        <div className={`min-w-0 ${executor.inherited ? "opacity-80" : ""}`} data-label={t("wfModelsColModel")}>
          <NativeModelPicker catalog={catalog} testId={`wf-model-picker-${executor.nodeId}`} disabled={busy} label={t("wfModelModelLabel").replace("{step}", title)}
            seed={{ providerId: executor.providerId, model: executor.model, effort: executor.reasoningEffort, serviceTier: executor.serviceTier }} onChoose={choose} />
        </div>
      ) : <ReadOnlyCells executor={executor} />}
      <div className="min-w-0 text-xs text-muted-foreground" data-label={t("wfModelsColSource")} data-testid={`wf-model-source-${executor.nodeId}`} data-source={executor.source}>
        <span className={executor.inherited ? "italic" : "text-foreground"}>{sourceText(executor)}</span>
        {editable && !executor.inherited ? <Button type="button" size="sm" variant="ghost" className="ml-1 h-6 px-1.5 text-xs" disabled={busy} data-testid={`wf-model-reset-${executor.nodeId}`} onClick={() => choose(null)}>{t("wfModelDefault")}</Button> : null}
      </div>
      <div className="min-w-0" data-label={t("wfModelsColCost")}><span className={`${COST_PILL[executor.costTier]} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={`wf-model-cost-${executor.nodeId}`}>{t(`wfModelCost_${executor.costTier}` as I18nKey)}</span></div>
      {executor.mode === "chain" ? (
        <div className="lp-model-extra" data-testid={`wf-model-chain-${executor.nodeId}`}>
          <span className="font-medium">{t("wfModelChain")}:</span>{" "}
          {executor.fallbacks.map((row, index) => <span key={index}>→ {row.pm ? (row.model ? `${t("wfModelChainPm")} (${modelShort(row.model)})` : t("wfModelChainPm")) : `${providerShort(row.providerId)} · ${modelShort(row.model)}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ""}`} </span>)}
          {executor.parts.map((part) => <span key={part.stage} className="block">{t("wfModelCritic")}: {[providerShort(part.providerId), modelShort(part.model), part.reasoningEffort].filter(Boolean).join(" · ")}</span>)}
        </div>
      ) : null}
      {!executor.overridable && executor.settingsKey ? <div className="lp-model-extra text-muted-foreground">{t("wfModelSetIn").replace("{key}", executor.settingsKey)}</div> : null}
      {problems.length || notes.length || error ? (
        <div className="lp-model-extra" role={error ? "alert" : undefined}>
          {error ? <p className="break-words text-destructive-text" data-testid={`wf-model-error-${executor.nodeId}`}>{t("wfModelRejected").replace("{reason}", error)}</p> : null}
          {problems.map((code) => <p key={code} className="break-words lp-text-warning" data-testid={`wf-model-issue-${executor.nodeId}-${code}`}>{issueText(code)}</p>)}
          {notes.map((code) => <p key={code} className="break-words text-muted-foreground">{issueText(code)}</p>)}
        </div>
      ) : null}
    </li>
  );
}

/**
 * One row per step that has a model: who works there, provider, model and effort (pickers where the step itself holds them),
 * where the value comes from, and a price class. A step whose model Settings decide shows it read-only with the setting named.
 * A change goes to `onChoose`, which patches the draft and answers with the reason it refused, or null.
 */
export function ModelsPanel({ graph, locale, executors, loaded, catalog, access, wide, busy = false, onChoose, onDuplicate }: {
  graph: WorkflowView; locale: Locale; executors: readonly StepExecutor[]; loaded: boolean; catalog: ModelCatalog | null; access: ModelsAccess; wide: boolean; busy?: boolean;
  onChoose: (nodeId: string, choice: ModelChoice | null) => Promise<string | null>;
  onDuplicate?: (() => void) | null;
}): ReactNode {
  const views = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const withModel = executors.filter((row) => row.mode !== "none");
  const without = executors.filter((row) => row.mode === "none");
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of withModel) counts.set(providerShort(row.providerId) || "?", (counts.get(providerShort(row.providerId) || "?") ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [withModel]);
  const hint = access === "builtin" ? t("wfModelsBuiltinHint") : access === "own" ? t("wfModelsOwnHint") : t("wfModelsHint");
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
          {access === "builtin" && onDuplicate ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={busy} data-testid="wf-models-duplicate" onClick={onDuplicate}>{t("wfDuplicateToEdit")}</Button> : null}
        </div>
        {!loaded ? <p className="text-xs text-muted-foreground" role="status">{t("wfModelsLoading")}</p> : null}
        {loaded && !withModel.length ? <p className="text-xs text-muted-foreground" data-testid="wf-models-empty">{t("wfModelsEmpty")}</p> : null}
        {loaded && withModel.length && catalog && !catalog.providers.length ? <p className="text-xs text-muted-foreground">{t("wfModelsCatalogEmpty")}</p> : null}
        {withModel.length ? (
          <>
            {wide ? (
              <div className="lp-model-head" aria-hidden data-wide="1">
                {(["wfModelsColStep", "wfModelsColAgent", "wfModelsColModel", "wfModelsColSource", "wfModelsColCost"] as const).map((key) => <span key={key}>{t(key)}</span>)}
              </div>
            ) : null}
            <ul className="lp-model-list" data-testid="wf-models-list">
              {withModel.map((row) => <ModelsRow key={row.nodeId} executor={row} view={views.get(row.nodeId) ?? views.get(row.nodeId.replace(/:child$/, ""))} locale={locale} catalog={catalog} access={access} wide={wide} busy={busy} onChoose={onChoose} />)}
            </ul>
          </>
        ) : null}
        {without.length ? <p className="break-words text-xs text-muted-foreground" data-testid="wf-models-none">{t("wfModelsNone").replace("{steps}", without.slice(0, 14).map((row) => row.nodeId).join(", ") + (without.length > 14 ? ` +${without.length - 14}` : ""))}</p> : null}
      </SurfaceBody>
    </Surface>
  );
}
