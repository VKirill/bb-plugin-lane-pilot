import { t } from "@lane-pilot/i18n";
import { writerFallbackSlots } from "@lane-pilot/models";
import { CONTROL_H, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Surface, SurfaceHeader, Switch } from "@lane-pilot/ui-kit";
import { agentPickerLabel } from "../../contracts/agent-display";
import type { RoleSpec } from "../../native-agent/ui";
import { PmAccessNote } from "../../settings/ui";
import { SettingField, asBoolean } from "../../ui-shell/ui";
import type { LpPage } from "./use-lp-page";

/** What the model catalog says about one provider's models: the shape `workflow_model_catalog` returns, trimmed to what the writer row reads. */
export type FallbackCatalog = { providers: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string; model: string; displayName: string }> }> };

/** The catalog's display names by `providerId/model`; a model is listed under its id and its model name, whichever a setting stores. */
export function fallbackModelNames(catalog: FallbackCatalog | null): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const provider of catalog?.providers ?? []) {
    for (const model of provider.models) {
      names.set(`${provider.id}/${model.id}`, model.displayName);
      names.set(`${provider.id}/${model.model}`, model.displayName);
    }
  }
  return names;
}

/** The writer row's fallback chain: display names, the raw model id while the catalog is missing that model, "—" for an off slot
 * before a filled one, and no trailing off slots. */
export function writerFallbackSummaryText(rows: ReadonlyArray<{ providerId: string; model: string } | null>, names: ReadonlyMap<string, string>): string {
  const last = rows.reduce((at, row, index) => (row ? index : at), -1);
  if (last < 0) return "—";
  return rows.slice(0, last + 1).map((row) => (row ? names.get(`${row.providerId}/${row.model}`) ?? row.model : "—")).join(" → ");
}

/** The PM chat: the agent new chats of the project start with. It loads everything on purpose, so there is no access to set. */
export function PmRow({ page }: { page: LpPage }) {
  const { data, rpc, scoped, projectId, displayedValue, writeDraft, setSaveError, setData, dataRef, setError, stackControls } = page;
  return (
    <Surface testId="main-agent">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("mainAgent")}</h2></SurfaceHeader>
      <div className={stackControls ? "lp-panel-body grid gap-2" : "lp-panel-body grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center"}>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("mainAgentHelp")}</p>
          <PmAccessNote />
        </div>
        <Select
          value={String(displayedValue("main.agent") ?? "") || "__default__"}
          onValueChange={(next) => {
            const value = next === "__default__" ? "" : next;
            writeDraft("main.agent", value);
            void rpc.call("save_setting", { ...scoped, projectId: projectId!, key: "main.agent", value, expectedVersion: data?.versions["main.agent"] ?? 0 }).then((result) => {
              if (!result.ok) { setSaveError(result.validation ? { kind: "validation", code: result.validation.code, params: result.validation.params } : { kind: "cas" }); return; }
              setSaveError(null);
              setData((current) => {
                const nextData = current ? { ...current, values: { ...current.values, "main.agent": result.value }, versions: { ...current.versions, "main.agent": result.version }, explicitKeys: value ? [...new Set([...current.explicitKeys, "main.agent"])] : current.explicitKeys.filter((key) => key !== "main.agent") } : current;
                dataRef.current = nextData;
                return nextData;
              });
            }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        >
          <SelectTrigger aria-label={t("mainAgent")} className={`${CONTROL_H} min-w-0 max-w-full`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{t("mainAgentDefault")}</SelectItem>
            {(data?.mainAgents ?? []).filter((agent) => agent.kind !== "internal").map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentPickerLabel(agent, t)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </Surface>
  );
}

/** Enabled switch / docs mode select for a RoleSpec row. */
export function RoleEnabledSwitch({ spec, page }: { spec: RoleSpec; page: LpPage }) {
  const { catalogRow, displayedValue, applySetting } = page;
  if (!spec.enabled) return null;
  const enabledKey = spec.enabled.key;
  const row = catalogRow(enabledKey);
  if (row && "mode" in spec.enabled) {
    const raw = displayedValue(enabledKey);
    const mode = raw === undefined || raw === null || raw === "" || raw === "auto" ? "auto" : asBoolean(raw, false) ? "true" : "false";
    return (
      <Select value={mode} onValueChange={(next) => void applySetting(row, next)}>
        <SelectTrigger aria-label={t(spec.enabled.label)} data-testid="docs-mode" className="w-[5.5rem] min-w-0 max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("docsModeAuto")}</SelectItem>
          <SelectItem value="true">{t("docsModeOn")}</SelectItem>
          <SelectItem value="false">{t("docsModeOff")}</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (row && "fallback" in spec.enabled) {
    return <Switch checked={asBoolean(displayedValue(enabledKey), spec.enabled.fallback)} aria-label={t(spec.enabled.label)} onCheckedChange={(next) => void applySetting(row, next)} />;
  }
  return null;
}

/** Writer model picker + fallback chain summary button. */
export function WriterModelCell({
  page,
  open,
  onToggle,
  fallbackNames,
}: {
  page: LpPage;
  open: boolean;
  onToggle: () => void;
  fallbackNames: ReadonlyMap<string, string>;
}) {
  const { data, modelPicker, pickerValue, saveWriterSelection } = page;
  const chain = writerFallbackSummaryText(writerFallbackSlots(data?.values ?? {}), fallbackNames);
  return (
    <div className="min-w-0 space-y-1">
      {modelPicker(pickerValue, (next) => { saveWriterSelection(next); })}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="role-drawer-writer"
        onClick={onToggle}
        className="block w-full break-words rounded px-1 text-left text-xs text-muted-foreground hover:bg-[var(--lp-well)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="writer-fallback-summary"
      >
        {t("writerFallbackSummary")} {chain}
      </button>
    </div>
  );
}

/** Onboarder / pair-selection picker cell. */
export function PairPickerCell({ selectionId, page }: { selectionId: NonNullable<Exclude<RoleSpec["model"], "writer" | undefined>>; page: LpPage }) {
  const picker = page.pickers[selectionId];
  return <>{page.modelPicker(picker.value, (next) => { void picker.save(next); })}</>;
}

/** Context mode fields inside AccessModePanel. */
export function AccessModeFields({ page }: { page: LpPage }) {
  const { displayedValue, catalogRow, applySetting, writeDraft } = page;
  return (
    <div className="space-y-2" data-testid="access-mode-fields">
      {(["helper.context_mode", ...(displayedValue("helper.context_mode") === "selected" ? ["helper.skills", "helper.mcp_servers", "helper.bb_plugins", "helper.native_plugins"] : [])] as const).map((key) => {
        const row = catalogRow(key);
        return row ? (
          <SettingField
            key={key}
            row={row}
            value={displayedValue(key)}
            disabled={false}
            onChange={(next) => void applySetting(row, next)}
            onDraft={(next) => writeDraft(key, next)}
          />
        ) : null;
      })}
    </div>
  );
}
