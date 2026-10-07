import { t } from "../../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { findModel, findProvider, nodeEffortsFor, type ModelCatalog } from "../workflow/model-catalog";
import { effortFor, firstChoice } from "./workflow-model-ops";
import { modelShort, offeredOn, providerShort } from "./workflow-models";

const DEFAULT = "__default__";

/**
 * The model of one agent step, from the same catalog as the Models table: provider, model, effort. «Default» clears the step's own
 * choice, so it runs on the workflow agent's default. A provider or model no connected machine offers is listed but cannot be picked.
 */
export function CatalogModelFields({ provider, model, reasoning, catalog, onChange }: {
  provider: string; model: string; reasoning: string; catalog: ModelCatalog;
  onChange: (fields: { provider: string | null; model: string | null; reasoning: string | null }) => void;
}) {
  const row = provider ? findProvider(catalog, provider) : undefined;
  const picked = findModel(row, model);
  const efforts = nodeEffortsFor(picked);
  const label = "block text-xs font-medium";
  const trigger = "h-8 w-full min-w-0 text-sm";
  const suffix = (ids: readonly string[]) => (offeredOn(ids, catalog.hosts) ? ` · ${offeredOn(ids, catalog.hosts)}` : "");
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-3" data-testid="wf-edit-model-catalog">
      <div className="min-w-0 space-y-1">
        <span className={label}>{t("wfEditProvider")}</span>
        <Select value={provider || DEFAULT} onValueChange={(next) => {
          if (next === DEFAULT) { onChange({ provider: null, model: null, reasoning: null }); return; }
          const choice = firstChoice(catalog, next, reasoning || null);
          if (choice) onChange({ provider: choice.providerId, model: choice.model, reasoning: reasoning ? choice.effort ?? null : null });
        }}>
          <SelectTrigger className={trigger} aria-label={t("wfEditProvider")} data-testid="wf-edit-provider"><SelectValue>{provider ? row?.displayName ?? providerShort(provider) : t("wfEditDefault")}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{t("wfEditDefault")}</SelectItem>
            {catalog.providers.map((item) => (
              <SelectItem key={item.id} value={item.id} disabled={!item.hostIds.length || !item.models.some((entry) => entry.hostIds.length)} data-testid={`wf-edit-provider-option-${item.id}`}>
                {item.displayName}{suffix(item.hostIds)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0 space-y-1">
        <span className={label}>{t("wfEditModelName")}</span>
        <Select value={model} disabled={!row} onValueChange={(next) => {
          const entry = findModel(row, next);
          if (row && entry) onChange({ provider: row.id, model: entry.id, reasoning: reasoning ? effortFor(entry, reasoning) : null });
        }}>
          <SelectTrigger className={trigger} aria-label={t("wfEditModelName")} data-testid="wf-edit-model"><SelectValue>{picked?.displayName ?? (model ? modelShort(model) : t("wfEditDefault"))}</SelectValue></SelectTrigger>
          <SelectContent>
            {(row?.models ?? []).map((entry) => (
              <SelectItem key={entry.id} value={entry.id} disabled={!entry.hostIds.length} data-testid={`wf-edit-model-option-${entry.id}`}>
                {entry.displayName}{suffix(entry.hostIds)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0 space-y-1">
        <span className={label}>{t("wfEditReasoning")}</span>
        <Select value={reasoning && efforts.includes(reasoning) ? reasoning : DEFAULT} disabled={!picked} onValueChange={(next) => {
          if (row && picked) onChange({ provider: row.id, model: picked.id, reasoning: next === DEFAULT ? null : next });
        }}>
          <SelectTrigger className={trigger} aria-label={t("wfEditReasoning")} data-testid="wf-edit-effort"><SelectValue>{reasoning || t("wfEditDefault")}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{t("wfEditDefault")}</SelectItem>
            {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
