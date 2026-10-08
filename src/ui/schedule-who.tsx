import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { ERRAND_BUILTIN } from "../schedule/errand-model";
import type { CostView, ErrandDefaultView, ModelView } from "../schedule/views";
import { PRESET_SLUGS, presetSelection } from "../workflow/model-presets";
import { Pill } from "./pill";
import { fill } from "./schedule-parts";
import type { ModelFields } from "./schedule-model";
import { executorLine, modelShort, providerShort, sourceText, useModelCatalog, type StepExecutor } from "./workflow-models";
import { NativeModelPicker, type PickerSeed } from "./workflow-native-picker";

/** «Who runs it» of the schedule screens: the resolved model with where it comes from, the cost, the native model picker, the steps of a chain. */

type Shown = Pick<ModelView, "providerId" | "model" | "reasoningEffort" | "serviceTier">;
/** «claude-code · opus-5-5 · high · fast». */
export const modelLine = (model: Shown): string =>
  [providerShort(model.providerId), modelShort(model.model), model.reasoningEffort && model.reasoningEffort !== "none" ? model.reasoningEffort : null, model.serviceTier === "fast" ? t("wfModelFast") : null].filter(Boolean).join(" · ");

export function sourceLabel(model: Pick<ModelView, "source" | "sourceKey">): string {
  const key = `schWhoSource_${model.source.replace("-", "_")}` as I18nKey;
  return fill(t(key), { key: model.sourceKey ?? "" });
}

const WHO_ISSUES: ReadonlySet<string> = new Set(["unknown_preset", "invalid_schedule_default", "provider_without_model"]);

/** The saved model of an errand and where it comes from; the problems the resolution found are named under it. */
export function WhoLine({ model, testId }: { model: ModelView; testId: string }) {
  const issues = model.issues.filter((code) => WHO_ISSUES.has(code)).map((code) => ({ code, key: `schWhoIssue_${code}` as I18nKey }));
  return (
    <div className="min-w-0 space-y-0.5 text-sm" data-testid={testId}>
      <p className="break-words" data-testid={`${testId}-line`}>{fill(t("schWhoLine"), { model: modelLine(model), source: sourceLabel(model) })}</p>
      {issues.map((item) => <p key={item.code} className="break-words text-xs text-destructive-text" data-testid={`${testId}-issue`}>{t(item.key)}</p>)}
    </div>
  );
}

export const usdText = (usd: number): string => usd.toFixed(usd < 0.1 ? 3 : 2);
const price = (usd: number): string => String(Number(usd.toFixed(3)));

/** «≈ $0.12 per run (average of 5)»; with no history the model's price; «unknown» when the model has none. */
export function costText(cost: CostView): string {
  if (cost.perRunUsd !== null) return fill(t("schCostPerRun"), { usd: usdText(cost.perRunUsd), n: cost.samples });
  if (cost.priceInPer1M !== null && cost.priceOutPer1M !== null) return fill(t("schCostPrice"), { in: price(cost.priceInPer1M), out: price(cost.priceOutPer1M) });
  return t("schCostUnknown");
}

/** What a model offers to start from when the picker has no own choice: the Automation default in force, else the built-in errand model. */
export function defaultSeed(effective: ErrandDefaultView["effective"] | undefined): PickerSeed {
  if (effective && "provider" in effective) return { providerId: effective.provider, model: effective.model, effort: effective.reasoning_effort ?? null, serviceTier: effective.service_tier ?? null };
  const preset = effective && "preset" in effective ? presetSelection(effective.preset, {}) : null;
  if (preset) return { providerId: preset.providerId, model: preset.model, effort: preset.reasoning, serviceTier: null };
  return { providerId: ERRAND_BUILTIN.providerId, model: ERRAND_BUILTIN.model, effort: ERRAND_BUILTIN.reasoningEffort, serviceTier: null };
}

const NONE = "__none";

/**
 * BB's own model window for an errand task, plus a preset list. The window opens on what the task names, else on what runs now (`resolved`),
 * else on `fallback`. A choice sets the task's provider, model, effort and fast mode; a preset sets only the preset; «Use the default» clears all.
 */
export function WhoPicker({ projectId, fields, resolved, fallback, onChange, disabled = false, testId = "sch-who" }: {
  projectId: string | null; fields: ModelFields; resolved: ModelView | null; fallback?: PickerSeed | undefined; onChange: (fields: ModelFields) => void; disabled?: boolean; testId?: string;
}) {
  const catalog = useModelCatalog(projectId);
  const own = fields.model !== undefined;
  const seed: PickerSeed = own
    ? { providerId: fields.providerId ?? ERRAND_BUILTIN.providerId, model: fields.model ?? null, effort: fields.reasoning ?? null, serviceTier: fields.serviceTier ?? null }
    : resolved ? { providerId: resolved.providerId, model: resolved.model, effort: resolved.reasoningEffort, serviceTier: resolved.serviceTier } : fallback ?? defaultSeed(undefined);
  const touched = fields.model !== undefined || fields.providerId !== undefined || fields.preset !== undefined || fields.reasoning !== undefined || fields.serviceTier !== undefined;
  return (
    <div className="min-w-0 space-y-2" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        {catalog ? (
          <div className="min-w-0 space-y-1">
            <span className="block text-xs font-medium">{t("schWhoPick")}</span>
            <NativeModelPicker catalog={catalog} seed={seed} disabled={disabled} testId={`${testId}-picker`} label={t("schWhoPick")} className="min-w-0"
              onChoose={(choice) => onChange({ providerId: choice.providerId, model: choice.model, ...(choice.effort ? { reasoning: choice.effort } : {}), ...(choice.serviceTier === "fast" ? { serviceTier: "fast" as const } : {}) })} />
          </div>
        ) : null}
        <div className="min-w-0 space-y-1">
          <span className="block text-xs font-medium" id={`${testId}-preset-label`}>{t("schWhoPreset")}</span>
          <Select value={fields.preset && !own ? fields.preset : NONE} disabled={disabled} onValueChange={(value) => onChange(value === NONE ? {} : { preset: value })}>
            <SelectTrigger aria-labelledby={`${testId}-preset-label`} className="h-8 w-full min-w-40 text-sm" data-testid={`${testId}-preset`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("schWhoPresetNone")}</SelectItem>
              {PRESET_SLUGS.map((slug) => <SelectItem key={slug} value={slug}>{slug}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {touched ? <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" disabled={disabled} data-testid={`${testId}-default`} onClick={() => onChange({})}>{t("schWhoUseDefault")}</Button> : null}
      </div>
    </div>
  );
}

/** The steps of a chain that use a model, with the model and where it comes from: read-only, the steps are set in the chain. */
export function StepModels({ workflowId, projectId }: { workflowId: string; projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [steps, setSteps] = useState<StepExecutor[] | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("workflow_step_executors", { workflowId, projectId }).then((result) => { if (live) setSteps(result.executors.filter((row) => row.mode !== "none")); }).catch(() => { if (live) setSteps([]); });
    return () => { live = false; };
  }, [rpc, workflowId, projectId]);
  return (
    <div className="min-w-0 space-y-1" data-testid="sch-steps">
      <p className="text-xs font-medium">{t("schWhoSteps")}</p>
      {steps === null ? <p className="text-xs text-muted-foreground" role="status">{t("schWhoStepsLoading")}</p>
        : steps.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="sch-steps-none">{t("schWhoStepsNone")}</p>
          : (
            <ul className="space-y-1 text-xs">
              {steps.map((step) => (
                <li key={step.nodeId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" data-testid={`sch-step-${step.nodeId}`}>
                  <span className="font-mono">{step.nodeId}</span>
                  <span className="min-w-0 break-words" data-testid={`sch-step-model-${step.nodeId}`}>{executorLine(step)}</span>
                  <Pill tone="muted" testId={`sch-step-source-${step.nodeId}`}>{sourceText(step)}</Pill>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}
