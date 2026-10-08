import { useEffect, useRef, useState, type ReactNode } from "react";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Icon, type IconName } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { cronProblem, timezoneProblem } from "../cron";
import { conditionText } from "../view-core";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { ChipsField, Field, FieldListEditor, NumberField, Section, SelectField, SwitchField, TextArea, TextField, say, typeLabel } from "./workflow-edit-fields";
import {
  CONDITION_OPS, NODE_TYPES, PASS_MODES, actionParams, clauseValueText, fieldsOps, fieldsOfKey, forEachOf, forEachOps, guardOps, guardValue, isRaw, nodeById, nodesOf, outFields, paramsOps, parseClauseValue,
  questionOf, questionOps, readFields, readWhen, refCandidates, removeEdgeOps, removeNodeOps, setEdgeOps, setMetaOps, setNodeOps, whenError, writeFields, writeWhen, expressionError,
  type Clause, type ConditionOp, type ModelError, type NodeType, type Raw, type WhenModel,
} from "./workflow-edit-model";
import type { Catalog, DraftEditing } from "./workflow-edit-state";
import { choiceOps, type ModelChoice } from "./workflow-model-ops";
import { NativeModelPicker } from "./workflow-native-picker";
import { issueText, sourceText, useModelCatalog, type StepExecutor } from "./workflow-models";
import { dataTabs, SidePanel, type NodeDataProps } from "./workflow-node-data";
import type { DraftCaseResult, DraftDoc } from "./workflow-drafts";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const bi = (value: unknown): { en: string; ru: string } => {
  if (typeof value === "string") return { en: value, ru: value };
  return isRaw(value) ? { en: text(value.en), ru: text(value.ru) } : { en: "", ru: "" };
};
const biOps = (current: unknown, lang: "en" | "ru", next: string): { en: string; ru: string } | null => {
  const both = { ...bi(current), [lang]: next };
  return !both.en && !both.ru ? null : { en: both.en || both.ru, ru: both.ru || both.en };
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const jsonObject = (value: string): ModelError | null => {
  if (!value.trim()) return null;
  try { return isRaw(JSON.parse(value)) ? null : { key: "wfEditErr_jsonObject" }; } catch { return { key: "wfEditErr_json" }; }
};

const TYPE_ICON: Record<NodeType, IconName> = { agent: "Bot", "lp-task": "Code", action: "Zap", decision: "GitBranch", human: "UserRoundPlus", parallel: "Layers", join: "Layers", subworkflow: "Workflow", note: "Info" };

/** The panel's frame: the property form in the slot below the graph, and a bottom sheet on a narrow screen. */
export function PanelFrame({ title, subtitle, onClose, children, narrow, testId }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; narrow: boolean; testId: string }) {
  return (
    <Surface testId={testId} aria-label={typeof title === "string" ? title : undefined} className={narrow ? "lp-wf-sheet" : undefined} data-narrow={narrow ? "1" : "0"}>
      <SurfaceHeader className="justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-sm font-medium">{title}</h3>{subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}</div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={onClose}>{t("wfNodeClose")}</Button>
      </SurfaceHeader>
      <SurfaceBody className="space-y-3">{children}</SurfaceBody>
    </Surface>
  );
}

/** «+»: what kind of step to add. */
export function AddNodeMenu({ after, onPick, onClose }: { after: string | null; onPick: (type: NodeType) => void; onClose: () => void }) {
  return (
    <Surface testId="wf-add-menu" aria-label={t("wfEditAddStep")}>
      <SurfaceHeader className="justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-sm font-medium">{t("wfEditAddStep")}</h3><p className="truncate text-xs text-muted-foreground">{after ? t("wfEditAddAfter").replace("{node}", after.replace("$start", "start")) : t("wfEditAddLoose")}</p></div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={onClose}>{t("wfNodeClose")}</Button>
      </SurfaceHeader>
      <SurfaceBody>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {NODE_TYPES.map((type) => (
            <li key={type}>
              <button type="button" className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-[var(--lp-hairline)] p-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" data-testid={`wf-add-type-${type}`} onClick={() => onPick(type)}>
                <span className="lp-tile size-7 shrink-0" aria-hidden><Icon name={TYPE_ICON[type]} className="size-3.5" /></span>
                <span className="min-w-0"><span className="block text-sm font-medium">{typeLabel(type)}</span><span className="block text-xs text-muted-foreground">{t(`wfEditType_${type}` as I18nKey)}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </SurfaceBody>
    </Surface>
  );
}

// ------------------------------------------------------------------ name → reference rows (edge inputs, subworkflow inputs)

function RefMap({ label, rows, suggestions, onChange, hint, testId, check }: { label: ReactNode; rows: Record<string, string>; suggestions: readonly string[]; onChange: (next: Record<string, string>) => void; hint?: ReactNode; testId?: string; check?: (ref: string) => ModelError | null }) {
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<ModelError | null>(null);
  const add = () => {
    if (!name.trim() && !ref.trim()) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())) { setError({ key: "wfEditErr_fieldName" }); return; }
    const refused = ref.trim() ? check?.(ref.trim()) ?? null : { key: "wfEditErr_fieldRequired" as const };
    if (refused) { setError(refused); return; }
    setError(null); setName(""); setRef("");
    onChange({ ...rows, [name.trim()]: ref.trim() });
  };
  return (
    <Field label={label} hint={hint} error={error}>
      <ul className="space-y-1.5" data-testid={testId}>
        {Object.entries(rows).map(([key, value]) => (
          <li key={key} className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-1.5">
            <span className="truncate font-mono text-xs" title={key}>{key}</span>
            <span className="truncate font-mono text-xs text-muted-foreground" title={value}>{value}</span>
            <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-muted-foreground" aria-label={t("wfEditRemoveField").replace("{name}", key)} onClick={() => { const { [key]: _gone, ...rest } = rows; onChange(rest); }}>×</Button>
          </li>
        ))}
        <li className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-1.5">
          <Input className="h-7 text-xs" value={name} placeholder={t("wfEditFieldName")} aria-label={t("wfEditFieldName")} onChange={(event) => setName(event.target.value)} />
          <Input className="h-7 font-mono text-xs" value={ref} placeholder="node.field" aria-label={t("wfEditRefPlaceholder")} list={`${testId ?? "refs"}-list`} onChange={(event) => setRef(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" onClick={add}>{t("wfEditAdd")}</Button>
        </li>
      </ul>
      <datalist id={`${testId ?? "refs"}-list`}>{suggestions.map((item) => <option key={item} value={item} />)}</datalist>
    </Field>
  );
}

// ------------------------------------------------------------------ the model of an agent

function ModelFields({ node, edit, definition, executor }: { node: Raw; edit: DraftEditing; definition: Raw; executor: StepExecutor | null }) {
  const id = text(node.id);
  const models = useModelCatalog(edit.projectId);
  const [refused, setRefused] = useState<string | null>(null);
  const reasoning = ["low", "medium", "high", "xhigh", "ultracode", "max"] as const;
  // BB's own provider and model window over the hub's catalog (the same one the Models table and the card use); without a catalog the names are typed.
  if (models?.providers.length) {
    const own = Boolean(text(node.provider) || text(node.model) || text(node.reasoning) || text(node.service_tier));
    const choose = (choice: ModelChoice) => {
      const made = choiceOps(definition, models, id, choice);
      if (!made.ok) { setRefused(issueText(made.code)); return; }
      setRefused(null);
      void edit.apply(made.ops);
    };
    return (
      <Field label={t("wfEditModel")} hint={t("wfEditModelHint")}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <NativeModelPicker catalog={models} testId="wf-edit-model-picker" label={t("wfEditModel")} onChoose={choose}
              seed={{ providerId: text(node.provider) || executor?.providerId || null, model: text(node.model) || executor?.model || null, effort: text(node.reasoning) || executor?.reasoningEffort || null, serviceTier: text(node.service_tier) || executor?.serviceTier || null }} />
          </div>
          {own ? <Button type="button" size="sm" variant="outline" className="lp-raised h-8 px-2.5 text-xs" data-testid="wf-edit-model-default" onClick={() => { setRefused(null); void edit.apply(setNodeOps(id, { provider: null, model: null, reasoning: null, service_tier: null })); }}>{t("wfEditDefault")}</Button> : null}
        </div>
        {!own ? <p className="text-xs text-muted-foreground" data-testid="wf-edit-model-inherited">{executor ? t("wfModelFrom").replace("{source}", sourceText(executor)) : t("wfEditDefault")}</p> : null}
        {refused ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="wf-edit-model-refused">{t("wfModelRejected").replace("{reason}", refused)}</p> : null}
      </Field>
    );
  }
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-3">
      <TextField label={t("wfEditProvider")} value={text(node.provider)} onCommit={(next) => void edit.apply(setNodeOps(id, { provider: next }))} />
      <TextField label={t("wfEditModelName")} value={text(node.model)} onCommit={(next) => void edit.apply(setNodeOps(id, { model: next }))} />
      <SelectField label={t("wfEditReasoning")} value={(text(node.reasoning) as (typeof reasoning)[number]) || ""} none={t("wfEditDefault")} options={reasoning.map((level) => ({ value: level, label: level }))} onChange={(next) => void edit.apply(setNodeOps(id, { reasoning: next }))} />
    </div>
  );
}

// ------------------------------------------------------------------ one node

export function NodeForm({ node, definition, catalog, edit, onClose, narrow, onConnect, executor = null, data = null }: { node: Raw; definition: Raw; catalog: Catalog; edit: DraftEditing; onClose: () => void; narrow: boolean; onConnect: (to: string) => void; executor?: StepExecutor | null; data?: NodeDataProps | null }) {
  const id = text(node.id);
  const [visit, setVisit] = useState<number | null>(null);
  useEffect(() => setVisit(null), [id]);
  const type = text(node.type) as NodeType;
  const set = (values: Raw, unset: string[] = []) => void edit.apply(setNodeOps(id, values, unset));
  const refs = refCandidates(definition, id);
  const others = nodesOf(definition).filter((candidate) => candidate.id !== id && candidate.type !== "note");
  const title = bi(node.title);
  const mode = (value: string) => value === "quick" || value === "standard" || value === "full";
  const description = type === "note" ? null : (
    <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <TextField label={`${t("wfEditTitle")} (EN)`} value={title.en} testId="wf-edit-title-en" onCommit={(next) => set({ title: biOps(node.title, "en", next) })} />
        <TextField label={`${t("wfEditTitle")} (RU)`} value={title.ru} testId="wf-edit-title-ru" onCommit={(next) => set({ title: biOps(node.title, "ru", next) })} />
      </div>
    </>
  );
  const body = (
    <>
      {description}
      {type === "agent" ? (
        <>
          <TextField label={t("wfEditRole")} value={text(node.role)} list={[...new Set(["worker", "plan-analyst", "builder", "reviewer", "qa-browser", ...catalog.specialists])]} testId="wf-edit-role" hint={t("wfEditRoleHint")} onCommit={(next) => set({ role: next })} />
          <TextArea label={t("wfEditPrompt")} value={text(node.prompt)} rows={6} suggestions={refs} testId="wf-edit-prompt" hint={t("wfEditPromptHint")} onCommit={(next) => set({ prompt: next })} />
          <ModelFields node={node} edit={edit} definition={definition} executor={executor} />
          <ChipsField label={t("wfEditSkills")} values={Array.isArray(node.skills) ? node.skills.filter((item): item is string => typeof item === "string") : []} catalog={catalog.skills.length ? catalog.skills : undefined} testId="wf-edit-skills" hint={t("wfEditSkillsHint")} onChange={(next) => set({ skills: next.slice(0, 8) })} />
          <ChipsField label={t("wfEditNodePlugins")} values={strings(node.plugins)} catalog={catalog.plugins.length ? catalog.plugins : undefined} testId="wf-edit-node-plugins" hint={t("wfEditNodePluginsHint")} onChange={(next) => set({ plugins: next.slice(0, 8) })} />
          <ChipsField label={t("wfEditNodeMcp")} values={strings(node.mcp)} catalog={catalog.mcpServers.length ? catalog.mcpServers.map((value) => ({ value })) : undefined} testId="wf-edit-node-mcp" hint={t("wfEditNodeMcpHint")} onChange={(next) => set({ mcp: next.slice(0, 8) })} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <SelectField label={t("wfEditEnvironment")} value={(text(node.environment) as "worktree") || ""} none={t("wfEditDefault")} testId="wf-edit-environment"
              options={(["worktree", "project", "personal", "none"] as const).map((value) => ({ value, label: t(`wfEditEnv_${value}` as I18nKey) }))} onChange={(next) => set({ environment: next })} />
            <SelectField label={t("wfEditSession")} value={(text(node.session) as "new") || ""} none={t("wfEditDefault")} testId="wf-edit-session"
              options={(["new", "same"] as const).map((value) => ({ value, label: t(`wfEditSession_${value}` as I18nKey) }))} onChange={(next) => set({ session: next })} />
          </div>
          <SwitchField label={t("wfEditAuthorized")} hint={t("wfEditAuthorizedHint")} checked={node.authorized === true} testId="wf-edit-authorized" onChange={(next) => set({ authorized: next ? true : null })} />
        </>
      ) : null}
      {type === "lp-task" ? (
        <>
          <p className="text-xs text-muted-foreground">{t("wfEditLpTaskHint")}</p>
          <ChipsField label={t("wfEditOwnsPaths")} values={Array.isArray(node.owns_paths) ? node.owns_paths.filter((item): item is string => typeof item === "string") : []} testId="wf-edit-owns" onChange={(next) => set({ owns_paths: next })} />
          <TextField label={t("wfEditQualityMode")} value={text(node.quality_mode)} onCommit={(next) => set({ quality_mode: next })} />
          {Array.isArray(node.stages) && node.stages.length ? <p className="break-words font-mono text-xs text-muted-foreground" data-testid="wf-edit-stages">{t("wfEditStagesLocked")}: {node.stages.join(", ")}</p> : null}
        </>
      ) : null}
      {type === "action" ? (
        <>
          <TextField label={t("wfEditAction")} value={text(node.action)} mono testId="wf-edit-action" hint={t("wfEditActionHint")} check={(next) => (!next || /^[a-z][a-z0-9_.:-]{0,63}$/.test(next) ? null : { key: "wfEditErr_actionKey" })} onCommit={(next) => set({ action: next })} />
          <TextArea label={t("wfEditParams")} value={json(actionParams(node))} rows={4} mono check={jsonObject} testId="wf-edit-params" onCommit={(next) => void edit.apply(paramsOps(node, next.trim() ? JSON.parse(next) as Raw : {}))} />
          {node.action === "emit" ? <TextArea label={t("wfEditEmitMap")} value={isRaw(node.map) ? json(node.map) : text(node.map)} rows={4} mono check={jsonObject} hint={t("wfEditEmitHint")} onCommit={(next) => set({ map: next.trim() ? JSON.parse(next) : null })} /> : null}
        </>
      ) : null}
      {type === "decision" ? (
        <SelectField label={t("wfEditReadsNode")} value={text(node.reads_node ?? node.reads)} none={t("wfEditNone")} hint={t("wfEditReadsHint")} testId="wf-edit-reads"
          options={others.map((candidate) => ({ value: text(candidate.id), label: text(candidate.id) }))} onChange={(next) => set({ reads_node: next }, "reads" in node && typeof node.reads === "string" ? ["reads"] : [])} />
      ) : null}
      {type === "human" ? (
        <>
          <TextArea label={t("wfEditQuestion")} value={questionOf(node)} rows={3} testId="wf-edit-question" check={(next) => (next.trim() ? null : { key: "wfEditErr_questionRequired" })} onCommit={(next) => void edit.apply(questionOps(node, next))} />
          <TextField label={t("wfEditRole")} value={text(node.role)} onCommit={(next) => set({ role: next })} />
          <ChipsField label={t("wfEditOptions")} values={Array.isArray(node.options) ? node.options.filter((item): item is string => typeof item === "string") : []} testId="wf-edit-options" onChange={(next) => set({ options: next })} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <SelectField label={t("wfEditOnTimeout")} value={(text(node.onTimeout) as "stop") || ""} none={t("wfEditDefault")} options={(["stop", "default"] as const).map((value) => ({ value, label: t(`wfEditTimeout_${value}` as I18nKey) }))} onChange={(next) => set({ onTimeout: next })} />
            <TextField label={t("wfEditDefaultOption")} value={text(node.defaultOption)} onCommit={(next) => set({ defaultOption: next })} />
          </div>
        </>
      ) : null}
      {type === "parallel" ? (
        <>
          <TextField label={t("wfEditForEach")} value={forEachOf(node)} mono list={refs} testId="wf-edit-foreach" hint={t("wfEditForEachHint")} onCommit={(next) => void edit.apply(forEachOps(node, next))} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <NumberField label={t("wfEditMaxFanOut")} value={typeof node.max_fan_out === "number" ? node.max_fan_out : null} min={1} max={50} onCommit={(next) => set({ max_fan_out: next })} />
            <NumberField label={t("wfEditBatchSize")} value={typeof node.batch_size === "number" ? node.batch_size : null} min={1} max={500} onCommit={(next) => set({ batch_size: next })} />
          </div>
          {isRaw(node.child) ? <p className="text-xs text-muted-foreground">{t("wfEditParallelChild")}</p> : null}
        </>
      ) : null}
      {type === "join" ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <SelectField label={t("wfEditJoinOf")} value={text(node.parallel)} none={t("wfEditNone")} testId="wf-edit-join-of" options={nodesOf(definition).filter((candidate) => candidate.type === "parallel").map((candidate) => ({ value: text(candidate.id), label: text(candidate.id) }))} onChange={(next) => set({ parallel: next })} />
          <SelectField label={t("wfEditJoinPolicy")} value={(text(node.policy) as "all") || ""} none={t("wfEditDefault")} options={(["all", "majority", "all_or_low_confidence"] as const).map((value) => ({ value, label: value }))} onChange={(next) => set({ policy: next })} />
        </div>
      ) : null}
      {type === "subworkflow" ? (
        <>
          <SelectField label={t("wfEditCalls")} value={text(node.workflow)} none={t("wfEditNone")} testId="wf-edit-calls"
            options={[...(text(node.workflow) && !catalog.workflows.some((row) => row.value === node.workflow) ? [{ value: text(node.workflow), label: text(node.workflow) }] : []), ...catalog.workflows.filter((row) => row.value !== text(definition.id))]} onChange={(next) => set({ workflow: next })} />
          <NumberField label={t("wfEditPinVersion")} value={typeof node.version === "number" ? node.version : null} min={1} hint={t("wfEditPinHint")} onCommit={(next) => set({ version: next })} />
          <RefMap label={t("wfEditInputsOfCall")} rows={isRaw(node.inputs) ? Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, text(value)])) : {}} suggestions={refs} testId="wf-edit-sub-inputs"
            check={(ref) => expressionCheck(ref, definition)} onChange={(next) => set({ inputs: next })} />
        </>
      ) : null}
      {type === "note" ? <TextArea label={t("wfEditNoteText")} value={text(node.text)} rows={4} testId="wf-edit-note" onCommit={(next) => set({ text: next })} /> : null}

      {type !== "note" ? (
        <>
          <FieldListEditor label={t("wfEditOutputs")} hint={t("wfEditOutputsHint")} rows={readFields(node.out ?? node.output)} testId="wf-edit-out" onChange={(rows) => void edit.apply(fieldsOps(node, rows))} />
          <Section title={t("wfEditGuards")} testId="wf-edit-guards">
            <div className="grid min-w-0 gap-3 sm:grid-cols-3">
              <NumberField label={t("wfEditMaxVisits")} value={guardValue(node, "maxVisits")} min={1} max={50} hint={t("wfEditMaxVisitsHint")} testId="wf-edit-visits" onCommit={(next) => void edit.apply(guardOps(node, "maxVisits", next))} />
              <NumberField label={t("wfEditRetries")} value={guardValue(node, "maxAttempts")} min={1} max={5} hint={t("wfEditRetriesHint")} testId="wf-edit-attempts" onCommit={(next) => void edit.apply(guardOps(node, "maxAttempts", next))} />
              <NumberField label={t("wfEditTimeout")} value={guardValue(node, "timeoutSec")} min={1} max={86400} hint={t("wfEditTimeoutHint")} testId="wf-edit-timeout" onCommit={(next) => void edit.apply(guardOps(node, "timeoutSec", next))} />
            </div>
            <ChipsField label={t("wfEditModes")} values={Array.isArray(node.applicable_modes) ? node.applicable_modes.filter((item): item is string => typeof item === "string") : []} catalog={["quick", "standard", "full"].map((value) => ({ value }))} hint={t("wfEditModesHint")}
              onChange={(next) => set({ applicable_modes: next.filter(mode).length ? next.filter(mode) : null })} />
            <TextField label={t("wfEditSkipWhen")} value={typeof node.skip_when === "string" ? node.skip_when : ""} mono hint={t("wfEditSkipHint")} check={(next) => (next.trim() ? expressionError(next, definition) : null)} onCommit={(next) => set({ skip_when: next })} />
          </Section>
        </>
      ) : null}
      {type !== "note" ? (
        <SelectField label={t("wfEditConnectTo")} value="" none={undefined} testId="wf-edit-connect" hint={t("wfEditConnectHint")}
          options={[...others.map((candidate) => ({ value: text(candidate.id), label: text(candidate.id) })), { value: "end", label: t("wfEditEnd") }]} onChange={(to) => { if (to) onConnect(to); }} />
      ) : null}
      <div className="flex justify-end border-t border-[var(--lp-hairline)] pt-3">
        <Button type="button" size="sm" variant="outline" className="lp-raised h-8 px-3 text-xs text-destructive-text" data-testid="wf-edit-remove-node" onClick={() => { void edit.apply(removeNodeOps(id)); onClose(); }}>{t("wfEditRemoveStep")}</Button>
      </div>
    </>
  );
  const frameTitle = text(node.label) || title.en || id;
  const frameSubtitle = `${typeLabel(type)} · ${id}`;
  // With the step's data at hand the panel has the same tabs as everywhere (parameters, inputs, outputs, last run); without it it is the form alone.
  if (data && type !== "note") {
    return <SidePanel testId="wf-node-panel" title={frameTitle} subtitle={frameSubtitle} onClose={onClose} narrow={narrow} tabs={[{ id: "params", label: t("wfTabParams"), content: body }, ...dataTabs(data, visit, setVisit)]} />;
  }
  return <PanelFrame testId="wf-node-panel" title={frameTitle} subtitle={frameSubtitle} onClose={onClose} narrow={narrow}>{body}</PanelFrame>;
}

const expressionCheck = (ref: string, definition: Raw): ModelError | null => expressionError(ref, definition);

// ------------------------------------------------------------------ one edge

/** The condition of an edge, built from the fields its source declares, or written as an expression. Only a valid one is sent. */
function ConditionEditor({ when, definition, fromKey, onCommit }: { when: unknown; definition: Raw; fromKey: string; onCommit: (next: unknown) => void }) {
  const fields = fieldsOfKey(definition, fromKey === "$start" ? "start" : fromKey);
  const [model, setModel] = useState<WhenModel>(() => readWhen(when, describe));
  const [error, setError] = useState<ModelError | null>(null);
  const dirty = useRef(false);
  const signature = JSON.stringify(when ?? null);
  useEffect(() => { if (!dirty.current) { setModel(readWhen(when, describe)); setError(null); } }, [signature]);
  const attempt = (next: WhenModel) => {
    const refused = whenError(next, definition, fromKey);
    setError(refused);
    if (refused) return;
    dirty.current = false;
    onCommit(writeWhen(next));
  };
  const change = (next: WhenModel, now: boolean) => { dirty.current = true; setModel(next); if (now) attempt(next); };
  const kind = model.kind === "complex" ? "complex" : model.kind;
  const firstField = fields[0]?.name ?? "";
  const clauseAt = (index: number, patch: Partial<Clause>) => {
    if (model.kind !== "clauses") return model;
    return { ...model, clauses: model.clauses.map((clause, at) => (at === index ? { ...clause, ...patch } : clause)) };
  };
  return (
    <Field label={t("wfEditCondition")} error={error} hint={model.kind === "none" ? t("wfEditConditionNone") : undefined}>
      <div className="space-y-2" data-testid="wf-edit-condition">
        <div className="lp-seg flex-wrap" role="group" aria-label={t("wfEditCondition")}>
          {(["none", "clauses", "expression"] as const).map((value) => (
            <Button key={value} type="button" variant="ghost" className="lp-seg-item h-7 px-2.5 text-xs hover:bg-transparent" aria-pressed={kind === value} data-testid={`wf-cond-mode-${value}`}
              onClick={() => {
                if (value === "none") { change({ kind: "none" }, true); return; }
                if (value === "clauses") change({ kind: "clauses", join: "all", clauses: [{ field: firstField, op: "eq" }] }, false);
                else change({ kind: "expression", text: model.kind === "complex" || model.kind === "none" ? "" : model.kind === "clauses" ? describe(writeWhen(model)) : "" }, false);
              }}>{t(`wfEditCondMode_${value}` as I18nKey)}</Button>
          ))}
        </div>
        {model.kind === "complex" ? <p className="break-words rounded-lg bg-[var(--lp-well)] p-2 font-mono text-xs" data-testid="wf-cond-complex">{model.text}</p> : null}
        {model.kind === "expression" ? (
          <TextField label={t("wfEditExpression")} value={model.text} mono testId="wf-cond-expression" list={fields.map((field) => `${fromKey === "$start" ? "input" : fromKey}.${field.name}`)} hint={t("wfEditExpressionHint")}
            check={(next) => (next.trim() ? expressionError(next, definition) : null)} onCommit={(next) => { dirty.current = true; setModel({ kind: "expression", text: next }); attempt({ kind: "expression", text: next }); }} />
        ) : null}
        {model.kind === "clauses" ? (
          <div className="space-y-2">
            {model.clauses.map((clause, index) => {
              const field = fields.find((candidate) => candidate.name === clause.field.split(".")[0]);
              return (
                <div key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-1.5 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_auto]" data-testid={`wf-cond-clause-${index}`}>
                  <Input className="h-8 font-mono text-xs" value={clause.field} list="wf-cond-fields" aria-label={t("wfEditCondField")} placeholder={t("wfEditCondField")} data-testid={`wf-cond-field-${index}`}
                    onChange={(event) => change(clauseAt(index, { field: event.target.value }), false)} onBlur={() => attempt(model)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); attempt(model); } }} />
                  <SelectField label="" value={clause.op} options={CONDITION_OPS.map((op) => ({ value: op, label: t(`wfEditOp_${op}` as I18nKey) }))} testId={`wf-cond-op-${index}`}
                    onChange={(op) => { const next = clauseAt(index, { op: (op || "eq") as ConditionOp, ...(op === "exists" ? { value: undefined } : {}) }); change(next, true); }} />
                  {clause.op === "exists" ? <span className="hidden sm:block" /> : field?.type === "enum" && field.values && clause.op !== "in" && clause.op !== "notIn" ? (
                    <SelectField label="" value={typeof clause.value === "string" ? clause.value : ""} none={t("wfEditValue")} options={field.values.map((value) => ({ value, label: value }))} testId={`wf-cond-value-${index}`} onChange={(value) => change(clauseAt(index, { value: value || undefined }), true)} />
                  ) : (
                    <Input className="h-8 font-mono text-xs" value={clauseValueText(clause.value)} aria-label={t("wfEditValue")} placeholder={clause.op === "in" || clause.op === "notIn" ? t("wfEditValueList") : t("wfEditValue")} data-testid={`wf-cond-value-${index}`}
                      onChange={(event) => change(clauseAt(index, { value: parseClauseValue(clause.op, event.target.value, field) }), false)} onBlur={() => attempt(model)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); attempt(model); } }} />
                  )}
                  <Button type="button" size="sm" variant="ghost" className="size-8 p-0 text-muted-foreground" aria-label={t("wfEditRemoveCondition")} onClick={() => {
                    const clauses = model.clauses.filter((_, at) => at !== index);
                    change(clauses.length ? { ...model, clauses } : { kind: "none" }, true);
                  }}>×</Button>
                </div>
              );
            })}
            <datalist id="wf-cond-fields">{fields.map((field) => <option key={field.name} value={field.name}>{field.type}</option>)}</datalist>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" data-testid="wf-cond-add" onClick={() => change({ ...model, clauses: [...model.clauses, { field: firstField, op: "eq" }] }, false)}>{t("wfEditAddCondition")}</Button>
              {model.clauses.length > 1 ? (
                <div className="lp-seg" role="group" aria-label={t("wfEditCondJoin")}>
                  {(["all", "any"] as const).map((join) => <Button key={join} type="button" variant="ghost" className="lp-seg-item h-7 px-2.5 text-xs hover:bg-transparent" aria-pressed={model.join === join} onClick={() => change({ ...model, join }, true)}>{t(`wfEditJoin_${join}` as I18nKey)}</Button>)}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Field>
  );
}
const describe = (when: unknown): string => (typeof when === "string" ? when : conditionText(when as never) ?? "");

export function EdgeForm({ edge, rawIndex, definition, edit, onClose, narrow }: { edge: { from: string; to: string }; rawIndex: number; definition: Raw; edit: DraftEditing; onClose: () => void; narrow: boolean }) {
  const raw = (Array.isArray(definition.edges) ? definition.edges[rawIndex] : null) as Raw | null;
  if (!raw) return null;
  const sourceFields = fieldsOfKey(definition, edge.from === "$start" ? "start" : edge.from);
  const sourceName = edge.from === "$start" ? "start" : edge.from;
  const refs = [...sourceFields.map((field) => `${sourceName === "start" ? "input" : sourceName}.${field.name}`), ...refCandidates(definition, edge.from === "$start" ? null : edge.from)];
  const set = (values: Raw, unset: string[] = []) => void edit.apply(setEdgeOps(rawIndex, values, unset));
  const pass = (PASS_MODES as readonly string[]).includes(text(raw.pass)) ? text(raw.pass) as (typeof PASS_MODES)[number] : "artifact";
  return (
    <PanelFrame testId="wf-edge-panel" title={`${sourceName} → ${edge.to === "$end" ? "end" : edge.to}`} subtitle={t("wfEditEdge")} onClose={onClose} narrow={narrow}>
      <TextField label={t("wfEditEdgeLabel")} value={text(raw.label)} testId="wf-edit-edge-label" hint={t("wfEditEdgeLabelHint")} check={(next) => (next.length <= 80 ? null : { key: "wfEditErr_labelLong" })} onCommit={(next) => set({ label: next })} />
      <SelectField label={t("wfEditPass")} value={pass} testId="wf-edit-pass" hint={t(`wfEditPassHint_${pass}` as I18nKey)} options={PASS_MODES.map((value) => ({ value, label: t(`wfPass_${value}` as I18nKey) }))} onChange={(next) => set({ pass: next === "artifact" ? null : next })} />
      <ConditionEditor when={raw.when} definition={definition} fromKey={edge.from} onCommit={(next) => set({ when: next })} />
      <RefMap label={t("wfEditCarries")} hint={t("wfEditCarriesHint")} rows={isRaw(raw.with) ? Object.fromEntries(Object.entries(raw.with).map(([key, value]) => [key, text(value)])) : {}} suggestions={refs} testId="wf-edit-carries"
        check={(ref) => expressionError(ref, definition)} onChange={(next) => set({ with: Object.keys(next).length ? next : null })} />
      <div className="flex justify-end border-t border-[var(--lp-hairline)] pt-3">
        <Button type="button" size="sm" variant="outline" className="lp-raised h-8 px-3 text-xs text-destructive-text" data-testid="wf-edit-remove-edge" onClick={() => { void edit.apply(removeEdgeOps(rawIndex)); onClose(); }}>{t("wfEditRemoveEdge")}</Button>
      </div>
    </PanelFrame>
  );
}

// ------------------------------------------------------------------ the workflow itself

export function WorkflowForm({ definition, catalog, edit, onClose, narrow }: { definition: Raw; catalog: Catalog; edit: DraftEditing; onClose: () => void; narrow: boolean }) {
  const meta = (values: Raw) => void edit.apply(setMetaOps(values));
  const name = bi(definition.name), description = bi(definition.description);
  const requires = (isRaw(definition.requires) ? definition.requires : {}) as Raw;
  const list = (key: string) => (Array.isArray(requires[key]) ? (requires[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  const setRequires = (key: string, next: unknown) => meta({ requires: { ...requires, [key]: next } });
  const guards = (isRaw(definition.guards) ? definition.guards : {}) as Raw;
  const budget = (isRaw(definition.budget) ? definition.budget : {}) as Raw;
  const num = (source: Raw, key: string) => (typeof source[key] === "number" ? source[key] as number : null);
  const triggerRows: Raw[] = Array.isArray(definition.triggers) ? definition.triggers.map((item) => (typeof item === "string" ? { type: item } : isRaw(item) ? item : null)).filter((item): item is Raw => item !== null) : [];
  const triggers = triggerRows.map((item) => text(item.type)).filter(Boolean);
  const schedule = triggerRows.find((item) => item.type === "schedule");
  // A change of one field of the schedule keeps the others; an empty one is dropped.
  const setSchedule = (patch: Raw) => meta({ triggers: triggerRows.map((item) => (item.type === "schedule" ? Object.fromEntries(Object.entries({ ...item, ...patch }).filter(([, value]) => value !== undefined && value !== "")) : item)) });
  return (
    <PanelFrame testId="wf-workflow-panel" title={t("wfEditWorkflowSettings")} subtitle={text(definition.id)} onClose={onClose} narrow={narrow}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <TextField label={`${t("wfEditName")} (EN)`} value={name.en} testId="wf-edit-name-en" onCommit={(next) => meta({ name: biOps(definition.name, "en", next) })} />
        <TextField label={`${t("wfEditName")} (RU)`} value={name.ru} testId="wf-edit-name-ru" onCommit={(next) => meta({ name: biOps(definition.name, "ru", next) })} />
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <TextArea label={`${t("wfEditDescription")} (EN)`} value={description.en} rows={2} onCommit={(next) => meta({ description: biOps(definition.description, "en", next) })} />
        <TextArea label={`${t("wfEditDescription")} (RU)`} value={description.ru} rows={2} onCommit={(next) => meta({ description: biOps(definition.description, "ru", next) })} />
      </div>
      <FieldListEditor label={t("wfInputs")} rows={readFields(definition.inputs)} testId="wf-edit-inputs" hint={t("wfEditInputsHint")} onChange={(rows) => meta({ inputs: writeFields(rows) })} />
      <FieldListEditor label={t("wfOutputs")} rows={readFields(definition.outputs)} testId="wf-edit-outputs" onChange={(rows) => meta({ outputs: writeFields(rows) })} />
      <Section title={t("wfEditRequires")} open testId="wf-edit-requires">
        <ChipsField label={t("wfEditReqMachines")} values={list("machines")} catalog={catalog.hosts.length ? catalog.hosts.map((host) => ({ value: host.value, label: host.label })) : undefined} testId="wf-edit-machines" hint={t("wfEditReqMachinesHint")} onChange={(next) => setRequires("machines", next)} />
        <ChipsField label={t("wfEditReqSkills")} values={list("skills")} catalog={catalog.skills.length ? catalog.skills : undefined} onChange={(next) => setRequires("skills", next)} />
        <ChipsField label={t("wfEditReqPlugins")} values={list("plugins")} catalog={catalog.plugins.length ? catalog.plugins : undefined} onChange={(next) => setRequires("plugins", next)} />
        <ChipsField label={t("wfEditReqSecrets")} values={list("secrets")} catalog={catalog.secrets.length ? catalog.secrets : undefined} testId="wf-edit-secrets" hint={t("wfEditReqSecretsHint")} onChange={(next) => setRequires("secrets", next)} />
        <ChipsField label={t("wfEditReqMcp")} values={list("mcp")} catalog={catalog.mcpServers.length ? catalog.mcpServers.map((value) => ({ value })) : undefined} testId="wf-edit-mcp-servers" onChange={(next) => setRequires("mcp", next)} />
        <ChipsField label={t("wfEditReqTools")} values={list("tools")} testId="wf-edit-tools" onChange={(next) => setRequires("tools", next)} />
        <ChipsField label={t("wfEditReqPlatforms")} values={list("platforms")} catalog={["threads", "instagram", "facebook", "vk", "x"].map((value) => ({ value }))} testId="wf-edit-platforms" onChange={(next) => setRequires("platforms", next)} />
        {catalog.mcpServers.length ? <p className="break-words text-xs text-muted-foreground" data-testid="wf-edit-mcp">{t("wfEditMcpAvailable")}: {catalog.mcpServers.join(", ")}</p> : null}
        <SwitchField label={t("wfEditBrowserSession")} checked={requires.browserSession === true} onChange={(next) => setRequires("browserSession", next)} />
      </Section>
      <Section title={t("wfEditLimits")}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <NumberField label={t("wfEditGuardSteps")} value={num(guards, "maxSteps")} min={1} max={500} onCommit={(next) => meta({ guards: { ...guards, maxSteps: next ?? undefined } })} />
          <NumberField label={t("wfEditGuardFanOut")} value={num(guards, "maxFanOut")} min={1} max={50} onCommit={(next) => meta({ guards: { ...guards, maxFanOut: next ?? undefined } })} />
          <NumberField label={t("wfEditBudgetTokens")} value={num(budget, "maxTokens")} min={1} onCommit={(next) => meta({ budget: { ...budget, maxTokens: next ?? undefined } })} />
          <NumberField label={t("wfEditBudgetSeconds")} value={num(budget, "maxWallSeconds")} min={1} onCommit={(next) => meta({ budget: { ...budget, maxWallSeconds: next ?? undefined } })} />
        </div>
        <SelectField label={t("wfEditQualityDefault")} value={(isRaw(definition.quality_mode) ? text(definition.quality_mode.default) : text(definition.quality_mode)) as "standard" | ""} none={t("wfEditDefault")}
          options={(["quick", "standard", "full"] as const).map((value) => ({ value, label: value }))} onChange={(next) => meta({ quality_mode: next ? { default: next } : null })} />
        <ChipsField label={t("wfTriggers")} values={triggers} catalog={["chat", "manual", "schedule", "telegram"].map((value) => ({ value }))} testId="wf-edit-triggers"
          onChange={(next) => meta({ triggers: next.map((type) => triggerRows.find((item) => item.type === type) ?? { type }) })} />
        {schedule ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="wf-edit-schedule">
            <TextField label={t("wfEditCron")} value={text(schedule.cron)} mono placeholder="0 9 * * *" hint={t("wfEditCronHint")} testId="wf-edit-cron"
              check={(next) => (next.trim() ? cronProblem(next) : null)} onCommit={(next) => setSchedule({ cron: next.trim() })} />
            <TextField label={t("wfEditTimezone")} value={text(schedule.timezone)} placeholder="Europe/Moscow" testId="wf-edit-timezone"
              check={(next) => (next.trim() ? timezoneProblem(next.trim()) : null)} onCommit={(next) => setSchedule({ timezone: next.trim() })} />
            <TextField label={t("wfEditScheduleProject")} value={text(schedule.projectId)} mono hint={t("wfEditScheduleProjectHint")} testId="wf-edit-schedule-project" onCommit={(next) => setSchedule({ projectId: next.trim() })} />
            <TextArea label={t("wfEditScheduleInputs")} value={isRaw(schedule.inputs) ? json(schedule.inputs) : ""} rows={3} mono check={jsonObject} testId="wf-edit-schedule-inputs"
              onCommit={(next) => setSchedule({ inputs: next.trim() ? JSON.parse(next) : undefined })} />
          </div>
        ) : null}
      </Section>
      <Section title={t("wfEditTestCase")} testId="wf-edit-test-case">
        <TextArea label={t("wfEditTestCaseJson")} value={isRaw(definition.test) ? json(definition.test) : ""} rows={8} mono check={jsonObject} hint={t("wfEditTestCaseHint")} testId="wf-edit-test-json"
          onCommit={(next) => meta({ test: next.trim() ? JSON.parse(next) : null })} />
      </Section>
    </PanelFrame>
  );
}

// ------------------------------------------------------------------ tests and versions

const when = (at: number) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");

export function TestResults({ doc, testRun }: { doc: DraftDoc; testRun: DraftEditing["testRun"] }) {
  const tests = doc.tests;
  const stale = Boolean(tests && tests.version !== doc.version);
  const invalid = Boolean(testRun && !testRun.ran && testRun.reason === "invalid");
  if (!tests && !invalid) return <p className="text-xs text-muted-foreground" data-testid="wf-tests-none">{t("wfEditTestsNone")}</p>;
  return (
    <div className="space-y-2" data-testid="wf-tests">
      {invalid ? <p className="text-xs text-destructive-text" role="alert" data-testid="wf-tests-invalid">{t("wfEditTestsInvalid")}</p> : null}
      {tests ? (
        <>
          <p className="flex flex-wrap items-center gap-x-2 text-xs">
            <span className={`${stale ? "lp-pill-muted" : tests.green ? "lp-pill-success" : "lp-pill-danger"} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid="wf-tests-verdict">{stale ? t("wfEditTestsStale") : tests.green ? t("wfEditTestsGreen") : t("wfEditTestsRed")}</span>
            <span className="text-muted-foreground">{t("wfDraftVersion").replace("{n}", String(tests.version))} · {when(tests.at)}</span>
          </p>
          <ul className="space-y-1.5">{tests.results.map((row) => <CaseRow key={row.caseId} row={row} />)}</ul>
        </>
      ) : null}
    </div>
  );
}
function CaseRow({ row }: { row: DraftCaseResult }) {
  return (
    <li className="min-w-0 space-y-1 rounded-lg border border-[var(--lp-hairline)] p-2 text-xs" data-testid={`wf-case-${row.caseId}`} data-green={row.green ? "1" : "0"}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`${row.green ? "lp-pill-success" : "lp-pill-danger"} rounded-full px-2 py-0.5 text-[11px] font-medium`}>{row.green ? t("wfEditCaseGreen") : t("wfEditCaseRed")}</span>
        <span className="min-w-0 break-all font-mono">{row.caseId}</span>
        <span className="text-muted-foreground">{row.status}</span>
      </div>
      {row.path.length ? <p className="break-words font-mono text-muted-foreground">{row.path.join(" → ")}</p> : null}
      {row.failures.map((line) => <p key={line} className="break-words text-destructive-text">{line}</p>)}
    </li>
  );
}

export function VersionsList({ doc, edit }: { doc: DraftDoc; edit: DraftEditing }) {
  if (!doc.history.length) return <p className="text-xs text-muted-foreground">{t("wfEditVersionsNone")}</p>;
  return (
    <ul className="divide-y divide-border/60" data-testid="wf-versions">
      {doc.history.map((row) => (
        <li key={row.version} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs">
          <span className="font-mono">{t("wfDraftVersion").replace("{n}", String(row.version))}</span>
          <span className="min-w-0 flex-1 break-words text-muted-foreground">{row.summary || "-"}</span>
          <span className="text-muted-foreground">{when(row.at)}</span>
          {row.version === doc.version ? <span className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px]">{t("wfEditCurrent")}</span>
            : <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" data-testid={`wf-restore-${row.version}`} disabled={edit.busy} onClick={() => void edit.restore(row.version)}>{t("wfEditRestore")}</Button>}
        </li>
      ))}
    </ul>
  );
}

export { say, nodeById, outFields };
