import { useCallback, useEffect, useState } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { belowTier, modelTier, roleModelKey, roleRow, type ModelTier } from "@lane-pilot/models";
import { Button, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { ModelCatalog } from "@lane-pilot/models";
import type { LpPage } from "../../ui-shell/ui";
import { NativeModelPicker, useModelCatalog, type ModelChoice } from "../../workflow/ui";

type PoolEntry = { providerId: string; model: string; effort: string | null };
type Row = {
  role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; sourceKey: string | null;
  own: boolean; version: number; defaultModel: string; defaultEffort: string; offered: boolean | null; pool: PoolEntry[];
};
type Option = { id: string; providerId: string; label: string; family: "claude" | "gpt" | "google" | "glm" | "other"; offered: boolean | null; efforts: string[] };
type View = { roles: Row[]; options: Option[] };
type Pick = { provider: string; model: string; reasoning_effort?: string };
type RowValue = Pick & { pool?: Pick[] };
const pickOf = (entry: { providerId: string; model: string; effort: string | null }): Pick => ({ provider: entry.providerId, model: entry.model, ...(entry.effort ? { reasoning_effort: entry.effort } : {}) });

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
export function RoleModelsPanel({ page, refreshKey = 0, onSaved }: { page: LpPage; refreshKey?: number; onSaved?: () => void }) {
  const { rpc, projectId, selectedSectionId, isGlobal } = page;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const catalog = useModelCatalog(projectId);
  const place = { projectId: projectId ?? "", ...(selectedSectionId ? { sectionId: selectedSectionId } : {}) };

  const load = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return rpc.call("get_role_models", place).then((next: View) => { setView(next); setError(""); }, (cause: unknown) => { setView(null); setError(fill(t("roleModelsLoadFailed"), { error: message(cause) })); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, projectId, selectedSectionId, refreshKey]);
  useEffect(() => { void load(); }, [load]);

  const save = async (row: Row, value: RowValue | null) => {
    setBusy(true);
    try {
      const key = roleModelKey(row.role);
      const result = value === null && row.own && !isGlobal
        ? await rpc.call("reset_project_settings", { ...place, keys: [key], expectedVersions: { [key]: row.version } })
        : await rpc.call("save_setting", { ...place, key, value, expectedVersion: row.version });
      // The table is read again either way (a refused save leaves it as it was); the reason is told after, or the read would wipe it.
      const why = result.ok ? "" : String(result.validation ? result.validation.params[1] ?? result.validation.code : result.conflict ? "conflict" : "refused");
      await load();
      // Only a save that went in changes the roster above; a refused one keeps its reason on screen.
      if (why) setError(fill(t("roleModelsSaveFailed"), { error: why }));
      else onSaved?.();
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
            {view.roles.map((row) => <RoleModelRow key={row.role} row={row} catalog={catalog} busy={busy} onSave={(value) => void save(row, value)} />)}
          </ul>
        ) : null}
      </SurfaceBody>
    </Surface>
  );
}

function RoleModelRow({ row, catalog, busy, onSave }: { row: Row; catalog: ModelCatalog | null; busy: boolean; onSave: (value: RowValue | null) => void }) {
  const name = t(nameKey(row.role));
  const [adding, setAdding] = useState(false);
  const least: ModelTier | undefined = roleRow(row.role).least;
  const light = row.source === "table" && Boolean(least) && belowTier(modelTier(row.model), least!);
  const source = row.source === "table" ? t("roleModelsSource_table") : row.source === "stage" ? fill(t("roleModelsSource_stage"), { key: row.sourceKey ?? "" }) : t("roleModelsSource_default");
  const main: Pick = { provider: row.providerId, model: row.model, reasoning_effort: row.effort };
  const same = (a: Pick, b: Pick) => a.provider === b.provider && a.model === b.model;
  // The pool travels with every save of the row, so changing the model keeps the other models of the role.
  const withPool = (next: Pick, pool: Pick[] = row.pool.map(pickOf)): RowValue => {
    const rest = pool.filter((entry) => !same(entry, next));
    return { ...next, ...(rest.length ? { pool: rest } : {}) };
  };
  const asPick = (choice: ModelChoice): Pick => ({ provider: choice.providerId, model: choice.model, ...(choice.effort ? { reasoning_effort: choice.effort } : {}) });
  const label = (entry: { providerId: string; model: string }) => catalog?.providers.find((p) => p.id === entry.providerId)?.models.find((m) => m.id === entry.model)?.displayName ?? entry.model;
  return (
    <li className="grid min-w-0 items-center gap-x-3 gap-y-1 border-t border-[var(--lp-hairline)] px-3 py-2 first:border-t-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)]" data-testid={`role-model-${row.role}`} data-source={row.source} data-own={row.own ? "1" : "0"}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={name}>{name}</div>
        <div className="break-words text-[11px] text-muted-foreground">{t(whyKey(row.role))}</div>
      </div>
      <div className="min-w-0">
        {catalog ? (
          <NativeModelPicker catalog={catalog} seed={{ providerId: row.providerId, model: row.model, effort: row.effort, serviceTier: null }} disabled={busy}
            testId={`role-model-pick-${row.role}`} label={fill(t("roleModelsModelLabel"), { role: name })} className="min-w-0"
            onChoose={(choice) => onSave(withPool(asPick(choice)))} />
        ) : <span className="text-sm" data-testid={`role-model-pick-${row.role}`}>{label(row)} · {row.effort}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className={row.source === "table" ? "text-foreground" : "italic"} data-testid={`role-model-source-${row.role}`}>{source}</span>
        {row.own ? <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={busy} data-testid={`role-model-reset-${row.role}`} onClick={() => onSave(null)}>{t("roleModelsReset")}</Button> : null}
        {light ? <span className="basis-full break-words lp-text-warning" data-testid={`role-model-light-${row.role}`}>{t("roleModelsLight")}</span> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground md:col-span-3" data-testid={`role-model-pool-${row.role}`}>
        <span>{row.pool.length ? t("roleModelsPool") : t("roleModelsPoolNone")}</span>
        {row.pool.map((entry) => (
          <span key={`${entry.providerId}/${entry.model}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--lp-hairline)] px-1.5 py-0.5 text-foreground">
            {label(entry)}{entry.effort ? ` · ${entry.effort}` : ""}
            <button type="button" className="text-muted-foreground hover:text-foreground" disabled={busy} aria-label={fill(t("roleModelsPoolRemove"), { model: label(entry) })}
              data-testid={`role-model-pool-remove-${row.role}-${entry.model}`} onClick={() => onSave(withPool(main, row.pool.map(pickOf).filter((item) => !same(item, pickOf(entry)))))}>×</button>
          </span>
        ))}
        {catalog && adding ? (
          <NativeModelPicker catalog={catalog} seed={{ providerId: null, model: null, effort: null, serviceTier: null }} disabled={busy}
            testId={`role-model-pool-picker-${row.role}`} label={fill(t("roleModelsPoolAdd"), { role: name })}
            onChoose={(choice) => { setAdding(false); onSave(withPool(main, [...row.pool.map(pickOf), asPick(choice)])); }} />
        ) : null}
        {catalog ? (
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} aria-label={fill(t("roleModelsPoolAdd"), { role: name })}
            data-testid={`role-model-pool-add-${row.role}`} onClick={() => setAdding((open) => !open)}>{adding ? "−" : "+"}</Button>
        ) : null}
      </div>
    </li>
  );
}
