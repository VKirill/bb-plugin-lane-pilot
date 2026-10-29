import { useEffect, useMemo, useState, type ReactNode } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { agentPickerLabel } from "../../native-agent/agent-display";
import { Badge } from "@lane-pilot/ui-kit";
import { Icon } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import { AccessModePanel, isChanged, ModelOverridesPanel, ORIGIN_LABEL, PmAccessNote, RoleAccessBody, RoleModelsPanel, roleSummary, useAccessView, type AccessApi, type RoleView } from "../../settings/ui";
import { useRulesAnalyzer } from "../../self-repair/ui";
import { asBoolean } from "./page-model";
import { writerFallbackSlots } from "../../writer/ui";
import { SettingField } from "../../settings/ui";
import { BrowserDetail, CouncilDetail, WriterDetail } from "../../native-agent/ui";
import { originOfKeys, roleKey, roleName, rolePurpose, ROLE_GROUPS, type RoleOrigin, type RoleSpec } from "../../native-agent/ui";
import { Pill, type PillTone } from "./pill";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { LpPage } from "./use-lp-page";
import { roleRowOf } from "@lane-pilot/models";

/** A row of the table «role -> model» as `get_role_models` reads it for the place: what the role runs on now. */
type TableRole = { role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; version: number;
  pool: ReadonlyArray<{ providerId: string; model: string; effort: string | null }> };
/** The picker's levels a table row may store (the table's efforts); «none» and the rest leave the effort to the model's default. */
const TABLE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Roles that run on the model of the task's writer, not on a row of the table. */
const AS_WRITER = new Set(["code-repair", "night-fixer"]);
/** Roles that keep a picker of their own outside the table: the writer, the rules analyzer (its own config) and the onboarder. */
const OWN_PICKER = new Set(["writer", "rules-analyzer", "onboarder"]);

const ORIGIN_TONE: Record<RoleOrigin, PillTone> = { here: "info", inherited: "neutral", default: "muted" };

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

/** The row grid on a wide column: role, on/off, model, where the value comes from, what the role loads. */
const WIDE_GRID = "grid min-w-0 items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.15fr)_4.5rem_minmax(0,1.7fr)_6.75rem_minmax(0,1fr)]";

function useRoleModel(page: LpPage) {
  const { isGlobal, projectId } = page;
  const rules = useRulesAnalyzer(isGlobal ? null : projectId);
  return { rules };
}

/** One role of the table: name, on/off, model picker, origin and access, with a drawer for what is specific to the role. */
function RoleRow({ spec, page, access, rules, open, onToggle, fallbackNames, tableRoles, saveTableRole }: {
  spec: RoleSpec; page: LpPage; access: AccessApi; rules: ReturnType<typeof useRulesAnalyzer>; open: boolean; onToggle: () => void; fallbackNames: ReadonlyMap<string, string>;
  tableRoles: ReadonlyMap<string, TableRole> | null; saveTableRole: (row: TableRole, next: { providerId: string; model: string; reasoningLevel: string }) => void;
}) {
  const { data, isGlobal, selectedSectionId, displayedValue, applySetting, catalogRow, modelPicker, pickerValue, saveWriterSelection, pickers, inheritReset, stackControls, wideTable } = page;
  const id = roleKey(spec.id);
  const role: RoleView | undefined = access.view?.roles.find((item) => item.role === spec.id);
  const changed = role ? isChanged(role) : false;
  const accessOrigin: "role" | "global" | "project" | "section" = changed && role ? role.origin ?? access.scope : "role";
  const origin = spec.keys.length ? originOfKeys(spec.keys, data?.explicitKeys, data?.inheritedKeys) : null;
  const hereLabel = isGlobal ? "accessOrigin_global" : selectedSectionId ? "accessOrigin_section" : "accessOrigin_project";
  const name = t(roleName(spec.id));

  let model: ReactNode = <span className="text-xs text-muted-foreground">—</span>;
  if (spec.model === "writer") {
    const chain = writerFallbackSummaryText(writerFallbackSlots(data?.values ?? {}), fallbackNames);
    model = <div className="min-w-0 space-y-1">
      {modelPicker(pickerValue, (next) => { saveWriterSelection(next); })}
      <button type="button" aria-expanded={open} aria-controls={`role-drawer-${id}`} onClick={onToggle}
        className="block w-full break-words rounded px-1 text-left text-xs text-muted-foreground hover:bg-[var(--lp-well)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="writer-fallback-summary">
        {t("writerFallbackSummary")} {chain}
      </button>
    </div>;
  }
  else if (spec.model === "rules") {
    model = isGlobal || !rules.loaded ? <span className="text-xs text-muted-foreground">{isGlobal ? t("teamRulesPerProject") : t("writerCatalogLoading")}</span>
      : <div onPointerDownCapture={() => { rules.touched.current = true; }} onKeyDownCapture={() => { rules.touched.current = true; }}>
        {modelPicker(rules.analyzer ?? { providerId: "", model: "", reasoningLevel: "none" }, (next) => { void rules.save(next); })}
      </div>;
  } else if (spec.model) {
    const picker = pickers[spec.model];
    model = modelPicker(picker.value, (next) => { void picker.save(next); });
  } else if (spec.detail === "council") model = <span className="text-xs text-muted-foreground">{t("teamCouncilSeats")}</span>;
  else if (spec.detail === "browser") {
    const pair = [displayedValue("browser_qa.provider"), displayedValue("browser_qa.model")].filter(Boolean).join(" · ");
    model = <span className="min-w-0 truncate text-xs text-muted-foreground">{pair || "—"}</span>;
  }
  // What the role really runs on: the task writer's model, or the row of the table «role -> model» above. A row of the table outranks an
  // older stage picker (plan_critique.*, memory.*…), so such a picker is replaced by what the table says, not left on screen doing nothing.
  if (AS_WRITER.has(spec.id)) model = <span className="text-xs text-muted-foreground" data-testid={`team-model-${spec.id}`}>{t("teamModelAsWriter")}</span>;
  else if (!OWN_PICKER.has(spec.id)) {
    const row = tableRoles?.get(roleRowOf(spec.id));
    if (row && (row.source === "table" || !spec.model || spec.detail === "browser" || spec.detail === "council")) {
      // BB's own window, as everywhere; a choice is saved into the role's row of the table (its pool stays), «+N» is the rest of the pool.
      model = <div className="flex min-w-0 items-center gap-1.5" title={t("teamModelFromTable")} data-testid={`team-model-${spec.id}`}>
        <div className="min-w-0 flex-1">{modelPicker({ providerId: row.providerId, model: row.model, reasoningLevel: row.effort as never }, (next) => saveTableRole(row, next))}</div>
        {row.pool.length ? <span className="shrink-0 text-xs text-muted-foreground">+{row.pool.length}</span> : null}
      </div>;
    }
  }

  let toggle: ReactNode = null;
  if (spec.enabled) {
    const enabledKey = spec.enabled.key;
    const row = catalogRow(enabledKey);
    if (row && "mode" in spec.enabled) {
      const raw = displayedValue(enabledKey);
      const mode = raw === undefined || raw === null || raw === "" || raw === "auto" ? "auto" : asBoolean(raw, false) ? "true" : "false";
      toggle = <Select value={mode} onValueChange={(next) => void applySetting(row, next)}>
        <SelectTrigger aria-label={t(spec.enabled.label)} data-testid="docs-mode" className="w-[5.5rem] min-w-0 max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("docsModeAuto")}</SelectItem>
          <SelectItem value="true">{t("docsModeOn")}</SelectItem>
          <SelectItem value="false">{t("docsModeOff")}</SelectItem>
        </SelectContent>
      </Select>;
    } else if (row && "fallback" in spec.enabled) {
      toggle = <Switch checked={asBoolean(displayedValue(enabledKey), spec.enabled.fallback)} aria-label={t(spec.enabled.label)} onCheckedChange={(next) => void applySetting(row, next)} />;
    }
  }

  const summary = role && access.view ? roleSummary(role, access.view.mandatory) : access.failed ? "—" : "…";
  const hasDrawer = Boolean(spec.detail || role || spec.keys.length);
  const wide = wideTable && !stackControls;
  return (
    <div id={`access-card-${id}`} data-testid={`access-role-${id}`} data-role-row={spec.id} data-lp-keys={spec.keys.join(" ")} data-open={open} data-changed={changed} data-origin={accessOrigin}
      className="min-w-0 scroll-mt-3 border-t border-[var(--lp-hairline)] first:border-t-0">
      <div data-testid={spec.testId} className={wide ? `${WIDE_GRID} px-3 py-2.5` : "grid min-w-0 gap-2 px-3 py-3"}>
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{name}</div>
            <div className="text-xs text-muted-foreground">{t(rolePurpose(spec.id))}</div>
          </div>
          {wide ? null : <div className="shrink-0">{toggle}</div>}
        </div>
        {wide ? <div className="flex items-center">{toggle}</div> : null}
        <div className="min-w-0 max-w-full" data-testid={spec.model ? `role-model-${id}` : undefined}>{model}</div>
        <div className="flex min-w-0 items-center gap-2">
          {origin ? <Pill tone={ORIGIN_TONE[origin]} testId={`role-origin-${id}`}>{origin === "here" ? t(hereLabel) : origin === "inherited" ? t("inheritedFromGlobal") : t("accessOrigin_default")}</Pill> : <span className="text-xs text-muted-foreground">—</span>}
        </div>
        <button type="button" aria-expanded={open} aria-controls={`role-drawer-${id}`} disabled={!hasDrawer} onClick={onToggle}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-[var(--lp-well)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
          data-testid={`role-open-${id}`}>
          <Icon name="ChevronRight" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 break-words text-xs" data-testid={`access-summary-${id}`}>{summary}</span>
          {changed ? <Badge variant="secondary" className="shrink-0" data-testid={`access-badge-${id}`}>{t(ORIGIN_LABEL[accessOrigin])}</Badge> : null}
        </button>
      </div>
      {open ? (
        <div id={`role-drawer-${id}`} className="min-w-0 space-y-4 border-t border-[var(--lp-hairline)] bg-[var(--lp-well)]/40 px-3 py-3" data-testid={`role-drawer-${id}`}>
          {spec.keys.length ? <div className="flex flex-wrap items-center gap-2">{inheritReset(spec.keys)}</div> : null}
          {spec.detail === "writer" ? <WriterDetail page={page} /> : null}
          {spec.detail === "council" ? <CouncilDetail page={page} /> : null}
          {spec.detail === "browser" ? <BrowserDetail page={page} /> : null}
          {role && access.view ? (
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{t("tabAccess")}</h3>
                <Badge variant={changed ? "secondary" : "outline"} data-testid={`access-badge-open-${id}`}>{t(ORIGIN_LABEL[accessOrigin])}</Badge>
              </div>
              <RoleAccessBody role={role} view={access.view} scope={access.scope} below={access.below[role.role] ?? "role"} busy={access.busy === role.role}
                onSave={(r, v) => void access.save(r, v)} onReset={(r) => void access.reset(r)} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The PM chat: the agent new chats of the project start with. It loads everything on purpose, so there is no access to set. */
function PmRow({ page }: { page: LpPage }) {
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
            {(data?.mainAgents ?? []).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentPickerLabel(agent, t)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </Surface>
  );
}

/** Who works: one table of every role with its on/off switch, model, where the value comes from and what the role loads. */
export function TeamTab({ page }: { page: LpPage }) {
  const { projectId, selectedSectionId, isGlobal, data, displayedValue, stackControls, wideTable, rpc } = page;
  const access = useAccessView(projectId!, selectedSectionId, data?.versions["helper.context_mode"] ?? 0);
  const { rules } = useRoleModel(page);
  // The fallback chain names its models as the pickers do; until the catalog arrives it shows the raw model ids.
  const [catalog, setCatalog] = useState<FallbackCatalog | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("workflow_model_catalog", projectId ? { projectId } : {}).then((value) => { if (live) setCatalog(value); }, () => undefined);
    return () => { live = false; };
  }, [rpc, projectId]);
  const fallbackNames = useMemo(() => fallbackModelNames(catalog), [catalog]);
  // The table «role -> model» of this place, read again whenever the page's settings change or either view of the table saves a row.
  const [tableRoles, setTableRoles] = useState<ReadonlyMap<string, TableRole> | null>(null);
  const [tableTick, setTableTick] = useState(0);
  const saveTableRole = (row: TableRole, next: { providerId: string; model: string; reasoningLevel: string }) => {
    const effort = TABLE_EFFORTS.has(next.reasoningLevel) ? next.reasoningLevel : null;
    const pool = row.pool.filter((entry) => !(entry.providerId === next.providerId && entry.model === next.model))
      .map((entry) => ({ provider: entry.providerId, model: entry.model, ...(entry.effort ? { reasoning_effort: entry.effort } : {}) }));
    const value = { provider: next.providerId, model: next.model, ...(effort ? { reasoning_effort: effort } : {}), ...(pool.length ? { pool } : {}) };
    void rpc.call("save_setting", { projectId: projectId!, ...(selectedSectionId ? { sectionId: selectedSectionId } : {}), key: `role_model.${row.role}`, value, expectedVersion: row.version })
      .finally(() => setTableTick((tick) => tick + 1));
  };
  useEffect(() => {
    let live = true;
    if (!projectId) return;
    void rpc.call("get_role_models", { projectId, ...(selectedSectionId ? { sectionId: selectedSectionId } : {}) })
      .then((value: { roles: TableRole[] }) => { if (live) setTableRoles(new Map(value.roles.map((row) => [row.role, row]))); }, () => undefined);
    return () => { live = false; };
  }, [rpc, projectId, selectedSectionId, data, tableTick]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const wide = wideTable && !stackControls;
  const roleModeOff = access.view !== null && access.view.mode !== "roles";
  const modeControl = (
    <div className="space-y-2" data-testid="access-mode-fields">
      {(["helper.context_mode", ...(displayedValue("helper.context_mode") === "selected" ? ["helper.skills", "helper.mcp_servers", "helper.bb_plugins", "helper.native_plugins"] : [])] as const).map((key) => {
        const row = page.catalogRow(key);
        return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
          onChange={(next) => void page.applySetting(row, next)} onDraft={(next) => page.writeDraft(key, next)} /> : null;
      })}
    </div>
  );
  return (
    <div className="space-y-6" data-testid="agent-access" data-scope={access.scope}>
      {isGlobal ? null : <PmRow page={page} />}
      <RoleModelsPanel page={page} refreshKey={tableTick} onSaved={() => setTableTick((tick) => tick + 1)} />
      <Surface testId="team-table">
        <SurfaceHeader className="justify-between"><h2 className="text-sm font-medium">{t("teamTitle")}</h2></SurfaceHeader>
        <SurfaceBody className="space-y-3">
          <p className="max-w-2xl text-xs text-muted-foreground">{t("teamHelp")}</p>
          <div className={roleModeOff ? "opacity-60" : undefined} data-testid="access-roles" data-inactive={roleModeOff}>
            <div className="overflow-hidden rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-card)]">
              {wide ? (
                <div className={`${WIDE_GRID} bg-[var(--lp-well)] px-3 py-1.5 text-xs font-medium text-muted-foreground`} aria-hidden>
                  <span>{t("teamColRole")}</span><span>{t("teamColOn")}</span><span>{t("teamColModel")}</span><span>{t("teamColSource")}</span><span>{t("teamColAccess")}</span>
                </div>
              ) : null}
              {ROLE_GROUPS.map((group) => (
                <section key={group.id} data-testid={`access-section-${group.id}`}>
                  <h3 className="border-t border-[var(--lp-hairline)] bg-[var(--lp-well)] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:border-t-0">{t(`accessGroup_${group.id}` as I18nKey)}</h3>
                  {group.roles.map((spec) => (
                    <RoleRow key={spec.id} spec={spec} page={page} access={access} rules={rules} open={open.has(spec.id)} onToggle={() => toggle(spec.id)} fallbackNames={fallbackNames} tableRoles={tableRoles} saveTableRole={saveTableRole} />
                  ))}
                </section>
              ))}
            </div>
          </div>
        </SurfaceBody>
      </Surface>
      {isGlobal ? <ModelOverridesPanel page={page} /> : null}
      <AccessModePanel api={access} modeControl={modeControl} />
    </div>
  );
}
