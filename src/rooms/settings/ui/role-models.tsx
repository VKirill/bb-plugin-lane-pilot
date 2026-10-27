import { useCallback, useEffect, useState } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { belowTier, modelTier, roleModelKey, roleRow, type ModelTier } from "@lane-pilot/models";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { LpPage } from "../../ui-shell/ui";

type Row = {
  role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; sourceKey: string | null;
  own: boolean; version: number; defaultModel: string; defaultEffort: string; offered: boolean | null;
};
type Option = { id: string; providerId: string; label: string; family: "claude" | "gpt" | "google" | "glm"; offered: boolean | null; efforts: string[] };
type View = { roles: Row[]; options: Option[] };

const fill = (text: string, values: Record<string, string>) => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text);
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const nameKey = (role: string) => `roleModelName_${role.replace(/-/g, "_")}` as I18nKey;
const whyKey = (role: string) => `roleModelWhy_${role.replace(/-/g, "_")}` as I18nKey;

/**
 * The ONE table «role -> model» of the team tab (the owner's decision of 2026-10-27: the model belongs to the role, not to the step; the same
 * in every graph). Each role has a model from the six Claude and GPT models the machines offer, and an effort. A choice is saved at the
 * place the page shows (global, project or section) as the setting `role_model.<role>`; «Default» drops that row. A role whose model comes
 * from a setting made before the table says so. The writer of a task is not here: it is picked per task from the writers' anamnesis.
 */
export function RoleModelsPanel({ page }: { page: LpPage }) {
  const { rpc, projectId, selectedSectionId, isGlobal } = page;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const place = { projectId: projectId ?? "", ...(selectedSectionId ? { sectionId: selectedSectionId } : {}) };

  const load = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return rpc.call("get_role_models", place).then((next: View) => { setView(next); setError(""); }, (cause: unknown) => { setView(null); setError(fill(t("roleModelsLoadFailed"), { error: message(cause) })); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, projectId, selectedSectionId]);
  useEffect(() => { void load(); }, [load]);

  const save = async (row: Row, value: { model: string; reasoning_effort: string } | null) => {
    setBusy(true);
    try {
      const key = roleModelKey(row.role);
      const result = value === null && row.own && !isGlobal
        ? await rpc.call("reset_project_settings", { ...place, keys: [key], expectedVersions: { [key]: row.version } })
        : await rpc.call("save_setting", { ...place, key, value, expectedVersion: row.version });
      // The table is read again either way (a refused save leaves it as it was); the reason is told after, or the read would wipe it.
      const why = result.ok ? "" : String(result.validation ? result.validation.params[1] ?? result.validation.code : result.conflict ? "conflict" : "refused");
      await load();
      if (why) setError(fill(t("roleModelsSaveFailed"), { error: why }));
    } catch (cause) { setError(fill(t("roleModelsSaveFailed"), { error: message(cause) })); }
    setBusy(false);
  };

  if (!projectId) return null;
  return (
    <Surface testId="role-models">
      <SurfaceHeader className="justify-between"><h2 className="text-sm font-medium">{t("roleModelsTitle")}</h2></SurfaceHeader>
      <SurfaceBody className="space-y-3">
        <p className="max-w-2xl text-xs text-muted-foreground">{t("roleModelsHelp")}</p>
        <p className="max-w-2xl text-xs text-muted-foreground" data-testid="role-models-writers">{t("roleModelsWriters")}</p>
        {error ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="role-models-error">{error}</p> : null}
        {!view && !error ? <p className="text-sm text-muted-foreground" role="status">{t("roleModelsLoading")}</p> : null}
        {view ? (
          <ul className="overflow-hidden rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)]" data-testid="role-models-list">
            {view.roles.map((row) => <RoleModelRow key={row.role} row={row} options={view.options} busy={busy} onSave={(value) => void save(row, value)} />)}
          </ul>
        ) : null}
      </SurfaceBody>
    </Surface>
  );
}

function RoleModelRow({ row, options, busy, onSave }: { row: Row; options: Option[]; busy: boolean; onSave: (value: { model: string; reasoning_effort: string } | null) => void }) {
  const name = t(nameKey(row.role));
  const picked = options.find((option) => option.id === row.model);
  // The model in force may be one the table does not list (an earlier stage setting named any model): it is shown, and the six stay the choices.
  const choices = picked ? options : [{ id: row.model, providerId: row.providerId, label: row.model, family: "claude" as const, offered: row.offered, efforts: [] }, ...options];
  const efforts = (choices.find((option) => option.id === row.model)?.efforts.length ? choices.find((option) => option.id === row.model)!.efforts : ["low", "medium", "high", "xhigh", "max"]);
  const effortList = efforts.includes(row.effort) ? efforts : [row.effort, ...efforts];
  const least: ModelTier | undefined = roleRow(row.role).least;
  const light = row.source === "table" && Boolean(least) && belowTier(modelTier(row.model), least!);
  const source = row.source === "table" ? t("roleModelsSource_table") : row.source === "stage" ? fill(t("roleModelsSource_stage"), { key: row.sourceKey ?? "" }) : t("roleModelsSource_default");
  const choose = (model: string) => {
    const option = options.find((item) => item.id === model);
    const effort = option && option.efforts.length && !option.efforts.includes(row.effort) ? (option.efforts.includes("high") ? "high" : option.efforts[0]!) : row.effort;
    onSave({ model, reasoning_effort: effort });
  };
  return (
    <li className="grid min-w-0 items-center gap-x-3 gap-y-1 border-t border-[var(--lp-hairline)] px-3 py-2 first:border-t-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_6rem_minmax(0,1fr)]" data-testid={`role-model-${row.role}`} data-source={row.source} data-own={row.own ? "1" : "0"}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={name}>{name}</div>
        <div className="break-words text-[11px] text-muted-foreground">{t(whyKey(row.role))}</div>
      </div>
      <div className="min-w-0">
        <Select value={row.model} disabled={busy} onValueChange={choose}>
          <SelectTrigger aria-label={fill(t("roleModelsModelLabel"), { role: name })} className="h-8 w-full text-sm" data-testid={`role-model-pick-${row.role}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {choices.map((option) => <SelectItem key={option.id} value={option.id} disabled={option.offered === false && option.id !== row.model}>{option.label}{option.offered === false ? ` (${t("roleModelsNotOffered")})` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0">
        <Select value={row.effort} disabled={busy} onValueChange={(effort) => onSave({ model: row.model, reasoning_effort: effort })}>
          <SelectTrigger aria-label={fill(t("roleModelsEffortLabel"), { role: name })} className="h-8 w-full text-sm" data-testid={`role-effort-pick-${row.role}`}><SelectValue /></SelectTrigger>
          <SelectContent>{effortList.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className={row.source === "table" ? "text-foreground" : "italic"} data-testid={`role-model-source-${row.role}`}>{source}</span>
        {row.own ? <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={busy} data-testid={`role-model-reset-${row.role}`} onClick={() => onSave(null)}>{t("roleModelsReset")}</Button> : null}
        {light ? <span className="basis-full break-words lp-text-warning" data-testid={`role-model-light-${row.role}`}>{t("roleModelsLight")}</span> : null}
      </div>
    </li>
  );
}
