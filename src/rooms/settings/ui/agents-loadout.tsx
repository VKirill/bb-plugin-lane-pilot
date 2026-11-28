import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import { roleModelKey, roleRow, type ModelTier } from "@lane-pilot/models";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { Alert, AlertDescription, AlertTitle, PageHeader, Segments, usePanelLayout } from "@lane-pilot/ui-kit";
import type { AgentLoadoutOutput, LoadoutRole, rpcContract } from "../../contracts";
import type { RoleSpec } from "../../native-agent/ui";
import { ModelOverridesPanel, useModelCatalog, type ModelChoice, type ScreenPayload } from "../../ui-shell/ui";
import { AccessModePanel, roleKey, useAccessView } from "./agent-access";
import {
  accessRoleOf,
  fallbackRolesFromGroups,
  FILTER_LABELS,
  SPEC_BY_ROLE,
  TABLE_EFFORTS,
  tableRoleIdOf,
  type LoadoutFilter,
  type ScopeLevel,
  type TableRoleRow,
} from "./agents-loadout-helpers";
import { LoadoutRoleRow, MATRIX_GRID } from "./agents-loadout-row";
import { OwnedSettings } from "./owned-settings";

export interface AgentsLoadoutProps {
  projectId?: string | null;
  sectionId?: string | null;
  locale?: Locale;
  projects?: ReadonlyArray<{ id: string; name: string }>;
  sections?: ReadonlyArray<{ id: string; name: string }>;
  onScopeChange?: (next: { projectId?: string; sectionId?: string }) => void;
  pageData?: ScreenPayload | null;
  stackControls?: boolean;
  wideTable?: boolean;
  renderPmRow?: () => ReactNode;
  renderWriterModel?: (open: boolean, onToggle: () => void) => ReactNode;
  renderOnboarderModel?: () => ReactNode;
  renderExtraPicker?: (selectionId: string) => ReactNode;
  renderWriterDetail?: () => ReactNode;
  renderBrowserDetail?: () => ReactNode;
  renderSettingSwitch?: (spec: RoleSpec) => ReactNode;
  renderModeFields?: () => ReactNode;
  onResetKeys?: (keys: string[]) => Promise<void> | void;
  overridesProjectCache?: Map<string, unknown>;
}

/** P13 Agents & loadout: single unified role matrix (model, skills, plugins, MCP, missing flags, per-row access/details), custom agents, and global model override reset. */
export function AgentsLoadout({
  projectId: projectIdProp = null,
  sectionId: sectionIdProp = null,
  locale: localeProp,
  projects: projectsProp,
  sections: sectionsProp,
  onScopeChange,
  pageData = null,
  stackControls: stackControlsProp,
  wideTable: wideTableProp = true,
  renderPmRow,
  renderWriterModel,
  renderOnboarderModel,
  renderExtraPicker,
  renderWriterDetail,
  renderBrowserDetail,
  renderSettingSwitch,
  renderModeFields,
  onResetKeys,
  overridesProjectCache,
}: AgentsLoadoutProps) {
  const rpc = useRpc<typeof rpcContract>() as unknown as {
    call: (method: string, input: unknown) => Promise<unknown>;
  };
  const locale = localeProp ?? detectLocale();
  const { stackControls: layoutStack } = usePanelLayout();
  const stackControls = stackControlsProp ?? layoutStack;

  const [localScope, setLocalScope] = useState<{ projectId: string | null; sectionId: string | null } | null>(null);
  const rawProjectId = localScope ? localScope.projectId : projectIdProp;
  const rawSectionId = localScope ? localScope.sectionId : sectionIdProp;
  const isGlobal = !rawProjectId || rawProjectId === GLOBAL_SETTINGS_PROJECT_ID;
  const effectiveProjectId = isGlobal ? GLOBAL_SETTINGS_PROJECT_ID : rawProjectId!;
  const effectiveSectionId = isGlobal ? null : rawSectionId;
  const level: ScopeLevel = isGlobal ? "system" : effectiveSectionId ? "section" : "project";

  const [fetchedProjects, setFetchedProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [fetchedSections, setFetchedSections] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (projectsProp) return;
    let alive = true;
    void rpc
      .call("list_projects", {})
      .then((res) => {
        if (alive && res && Array.isArray((res as { projects?: unknown }).projects)) {
          setFetchedProjects((res as { projects: Array<{ id: string; name: string }> }).projects);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rpc, projectsProp]);

  const projects = projectsProp ?? fetchedProjects;
  const sections = sectionsProp ?? fetchedSections;

  useEffect(() => {
    if (sectionsProp || isGlobal || !rawProjectId) return;
    let alive = true;
    void rpc
      .call("list_sections", { projectId: rawProjectId })
      .then((res) => {
        if (alive && res && Array.isArray((res as { sections?: unknown }).sections)) {
          setFetchedSections((res as { sections: Array<{ id: string; name: string }> }).sections);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rpc, sectionsProp, isGlobal, rawProjectId]);

  const [tick, setTick] = useState(0);
  const [loadout, setLoadout] = useState<AgentLoadoutOutput | null>(null);
  const [loadoutFallback, setLoadoutFallback] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [tableRoles, setTableRoles] = useState<ReadonlyMap<string, TableRoleRow> | null>(null);
  const [filter, setFilter] = useState<LoadoutFilter>("all");
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const fallbackCacheRef = useRef<Map<string, unknown>>(new Map());

  const place = useMemo(
    () => ({ projectId: effectiveProjectId, ...(effectiveSectionId ? { sectionId: effectiveSectionId } : {}) }),
    [effectiveProjectId, effectiveSectionId],
  );

  const loadData = useCallback(async () => {
    setLoadError(null);
    const [loadoutRes, tableRes] = await Promise.all([
      rpc.call("agent_loadout", place).catch((cause: unknown) => ({ __err: cause })),
      rpc.call("get_role_models", place).catch(() => null),
    ]);

    if (loadoutRes && typeof loadoutRes === "object" && "roles" in loadoutRes && Array.isArray((loadoutRes as AgentLoadoutOutput).roles)) {
      setLoadout(loadoutRes as AgentLoadoutOutput);
      setLoadoutFallback(false);
    } else if (loadoutRes && typeof loadoutRes === "object" && "__err" in loadoutRes) {
      // Fall back to static role groups if agent_loadout is unmocked in legacy test harnesses.
      setLoadout(null);
      setLoadoutFallback(true);
      const err = (loadoutRes as { __err: unknown }).__err;
      if (err instanceof Error && err.message && !/unmocked|not registered|handler/i.test(err.message)) {
        setLoadError(err.message);
      }
    } else {
      setLoadout(null);
      setLoadoutFallback(true);
    }

    if (tableRes && typeof tableRes === "object" && Array.isArray((tableRes as { roles?: unknown }).roles)) {
      setTableRoles(new Map((tableRes as { roles: TableRoleRow[] }).roles.map((r) => [r.role, r])));
    } else {
      setTableRoles(null);
    }
  }, [rpc, place]);

  useEffect(() => {
    void loadData();
  }, [loadData, tick, pageData]);

  const catalog = useModelCatalog(effectiveProjectId);
  const access = useAccessView(effectiveProjectId, effectiveSectionId, tick);

  const rolesList = useMemo(
    () => (loadout ? loadout.roles : fallbackRolesFromGroups()),
    [loadout],
  );

  const countsByKind = useMemo(() => {
    const counts: Record<LoadoutFilter, number> = { all: rolesList.length, pipeline: 0, specialist: 0, pm: 0, custom: 0 };
    for (const r of rolesList) counts[r.kind] += 1;
    return counts;
  }, [rolesList]);

  const filteredRoles = useMemo(
    () => (filter === "all" ? rolesList : rolesList.filter((r) => r.kind === filter)),
    [rolesList, filter],
  );

  const missingItemsTotal = useMemo(
    () => rolesList.reduce((sum, r) => sum + r.items.filter((i) => i.missing).length, 0),
    [rolesList],
  );

  const handleLevelPick = (nextLevel: ScopeLevel) => {
    let nextScope: { projectId?: string; sectionId?: string };
    if (nextLevel === "system") {
      nextScope = {};
    } else if (nextLevel === "project") {
      const targetProject = !isGlobal ? rawProjectId! : projects[0]?.id;
      if (!targetProject) return;
      nextScope = { projectId: targetProject };
    } else {
      const targetProject = !isGlobal ? rawProjectId! : projects[0]?.id;
      const targetSection = effectiveSectionId ?? sections[0]?.id;
      if (!targetProject || !targetSection) return;
      nextScope = { projectId: targetProject, sectionId: targetSection };
    }
    if (onScopeChange) onScopeChange(nextScope);
    else setLocalScope({ projectId: nextScope.projectId ?? null, sectionId: nextScope.sectionId ?? null });
  };

  const handleSaveModel = async (tableRoleId: string, row: TableRoleRow | undefined, choice: ModelChoice) => {
    setBusyRole(tableRoleId);
    setSaveError(null);
    try {
      const pool = (row?.pool ?? [])
        .filter((entry) => !(entry.providerId === choice.providerId && entry.model === choice.model))
        .map((entry) => ({
          provider: entry.providerId,
          model: entry.model,
          ...(entry.effort ? { reasoning_effort: entry.effort } : {}),
        }));
      const value = {
        provider: choice.providerId,
        model: choice.model,
        ...(choice.effort && TABLE_EFFORTS.has(choice.effort) ? { reasoning_effort: choice.effort } : {}),
        ...(pool.length ? { pool } : {}),
      };
      const res = (await rpc.call("save_setting", {
        ...place,
        key: roleModelKey(tableRoleId),
        value,
        expectedVersion: row?.version ?? 0,
      })) as { ok?: boolean; conflict?: boolean; validation?: { code?: string; params?: string[] } };
      if (res && res.ok === false) {
        const msg = res.validation ? String(res.validation.params?.[1] ?? res.validation.code ?? "invalid") : res.conflict ? "conflict" : "refused";
        setSaveError(t("roleModelsSaveFailed").replace("{error}", msg));
      } else {
        setTick((n) => n + 1);
      }
    } catch (cause) {
      setSaveError(t("roleModelsSaveFailed").replace("{error}", cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusyRole(null);
    }
  };

  const handleSavePool = async (tableRoleId: string, row: TableRoleRow, nextPool: TableRoleRow["pool"]) => {
    setBusyRole(tableRoleId);
    setSaveError(null);
    try {
      const pool = nextPool.map((entry) => ({
        provider: entry.providerId,
        model: entry.model,
        ...(entry.effort ? { reasoning_effort: entry.effort } : {}),
      }));
      const value = {
        provider: row.providerId,
        model: row.model,
        ...(TABLE_EFFORTS.has(row.effort) ? { reasoning_effort: row.effort } : {}),
        ...(pool.length ? { pool } : {}),
      };
      await rpc.call("save_setting", { ...place, key: roleModelKey(tableRoleId), value, expectedVersion: row.version });
      setTick((n) => n + 1);
    } catch (cause) {
      setSaveError(t("roleModelsSaveFailed").replace("{error}", cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusyRole(null);
    }
  };

  const handleResetAbove = async (
    entry: LoadoutRole,
    tableRoleId: string | null,
    tableRow: TableRoleRow | undefined,
    spec: RoleSpec | undefined,
    accessRoleKey: string | null,
    accessVersion: number,
  ) => {
    const id = entry.role;
    setBusyRole(id);
    setSaveError(null);
    try {
      const resetKeys: string[] = [];
      const expectedVersions: Record<string, number> = {};
      if (tableRoleId && (tableRow?.own || (!isGlobal && (entry.model.from === "project" || entry.model.from === "section")))) {
        const key = roleModelKey(tableRoleId);
        resetKeys.push(key);
        expectedVersions[key] = tableRow?.version ?? 0;
      }
      if (!isGlobal && accessRoleKey) {
        resetKeys.push(accessRoleKey);
        expectedVersions[accessRoleKey] = accessVersion;
      }
      if (resetKeys.length > 0) {
        await rpc.call("reset_project_settings", { ...place, keys: resetKeys, expectedVersions });
      }
      if (!isGlobal && spec?.keys.length && onResetKeys && pageData?.explicitKeys) {
        const explicitSpecKeys = spec.keys.filter((k) => pageData.explicitKeys.includes(k));
        if (explicitSpecKeys.length > 0) await onResetKeys(explicitSpecKeys);
      }
      setTick((n) => n + 1);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyRole(null);
    }
  };

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const levelLabel = t(
    level === "system" ? "consoleLoadoutLevelSystem" : level === "project" ? "consoleLoadoutLevelProject" : "consoleLoadoutLevelSection",
  );
  const wide = wideTableProp && !stackControls;
  const roleModeOff = access.view !== null && access.view.mode !== "roles";

  const filterItems = (["all", "pipeline", "specialist", "pm", "custom"] as const)
    .filter((k) => k === "all" || countsByKind[k] > 0)
    .map((k) => ({ id: k, label: `${t(FILTER_LABELS[k])} · ${countsByKind[k]}` }));

  const overridesPage = {
    rpc,
    projectCache: { current: overridesProjectCache ?? fallbackCacheRef.current },
  };

  return (
    <div className="space-y-6" data-testid="agent-access" data-scope={access.scope}>
      <PageHeader
        title={t("consoleSysAgents")}
        subtitle={t("consoleLoadoutSubtitle").replace("{level}", levelLabel)}
        actions={
          <Segments
            testId="loadout-level-picker"
            label={t("consoleLoadoutLevelAria")}
            compact={stackControls}
            value={level}
            onChange={(next) => handleLevelPick(next as ScopeLevel)}
            items={[
              { id: "system", label: t("consoleLoadoutLevelSystem") },
              { id: "project", label: t("consoleLoadoutLevelProject") },
              { id: "section", label: t("consoleLoadoutLevelSection") },
            ]}
          />
        }
      />

      {missingItemsTotal > 0 ? (
        <div className="lp-sys-warn" role="status" data-testid="loadout-missing-banner">
          {t("consoleLoadoutMissingBanner").replace("{n}", String(missingItemsTotal))}
        </div>
      ) : null}

      {loadError ? (
        <Alert variant="destructive" data-testid="loadout-load-error">
          <AlertTitle>{t("consoleLoadoutLoadError")}</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {saveError ? (
        <Alert variant="destructive" data-testid="loadout-save-error">
          <AlertTitle>{saveError}</AlertTitle>
        </Alert>
      ) : null}

      <section className="space-y-4" data-testid="role-models">
        {rolesList.length > 0 ? (
          <Segments
            testId="loadout-filter"
            label={t("consoleLoadoutColRole")}
            compact={stackControls}
            value={filter}
            onChange={(next) => setFilter(next as LoadoutFilter)}
            items={filterItems}
          />
        ) : null}
        <div className="space-y-3">
          {!loadout && !loadoutFallback && rolesList.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="loadout-loading">
              {t("consoleLoadoutLoading")}
            </p>
          ) : filteredRoles.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="loadout-empty">
              {t("consoleLoadoutEmpty")}
            </p>
          ) : (
            <div className={roleModeOff ? "opacity-60" : undefined} data-testid="access-roles" data-inactive={roleModeOff}>
              <div className="lp-sys-table-card" data-testid="team-table">
                {wide ? (
                  <div className={`${MATRIX_GRID} lp-sys-thead max-md:hidden`} aria-hidden>
                    <span>{t("consoleLoadoutColRole")}</span>
                    <span>{t("consoleLoadoutColModel")}</span>
                    <span>{t("consoleLoadoutColSkills")}</span>
                    <span>{t("consoleLoadoutColPlugins")}</span>
                    <span>{t("consoleLoadoutColMcp")}</span>
                    <span className="text-right">{t("consoleLoadoutColActions")}</span>
                  </div>
                ) : null}
                {filteredRoles.map((entry) => {
                  const accessRole = accessRoleOf(entry);
                  // Scout seats share one access role (and its test id) but open and close as separate rows.
                  const rowKey = roleKey(entry.role);
                  const tableRoleId = tableRoleIdOf(entry, tableRoles);
                  const tableRow = tableRoleId ? tableRoles?.get(tableRoleId) : undefined;
                  const spec = SPEC_BY_ROLE.get(accessRole) ?? SPEC_BY_ROLE.get(entry.role);
                  const accessViewRole = access.view?.roles.find((r) => r.role === accessRole);
                  const leastTier: ModelTier | undefined = tableRoleId ? roleRow(tableRoleId).least : undefined;
                  const hasExplicitKeys = Boolean(spec?.keys.some((k) => pageData?.explicitKeys.includes(k)));
                  const isRowOpen = openRows.has(rowKey);
                  const ownAccessKey =
                    accessViewRole && accessViewRole.origin === access.scope && !accessViewRole.inherited
                      ? accessViewRole.key
                      : null;

                  return (
                    <LoadoutRoleRow
                      key={`${entry.kind}:${entry.role}`}
                      entry={entry}
                      accessRole={accessRole}
                      tableRoleId={tableRoleId}
                      tableRow={tableRow}
                      spec={spec}
                      accessViewRole={accessViewRole}
                      access={access}
                      catalog={catalog}
                      locale={locale}
                      isGlobal={isGlobal}
                      busy={busyRole === (tableRoleId ?? entry.role)}
                      open={isRowOpen}
                      wide={wide}
                      leastTier={leastTier}
                      hasExplicitKeys={hasExplicitKeys}
                      onToggle={() => toggleRow(rowKey)}
                      onSaveModel={(tid, row, choice) => void handleSaveModel(tid, row, choice)}
                      onSavePool={(tid, row, nextPool) => void handleSavePool(tid, row, nextPool)}
                      onResetAbove={() =>
                        void handleResetAbove(
                          entry,
                          tableRoleId,
                          tableRow,
                          spec,
                          ownAccessKey,
                          accessViewRole?.version ?? 0,
                        )
                      }
                      renderWriterModel={renderWriterModel ? () => renderWriterModel(isRowOpen, () => toggleRow(rowKey)) : undefined}
                      renderOnboarderModel={renderOnboarderModel}
                      renderExtraPicker={renderExtraPicker}
                      renderWriterDetail={renderWriterDetail}
                      renderBrowserDetail={renderBrowserDetail}
                      renderSettingSwitch={renderSettingSwitch}
                    />
                  );
                })}
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("consoleLoadoutMandatoryFootnote")}</p>
        </div>
      </section>

      {renderPmRow ? renderPmRow() : null}

      {access.view || access.failed ? (
        <AccessModePanel api={access} modeControl={renderModeFields ? renderModeFields() : null} />
      ) : null}

      <OwnedSettings locale={locale} />

      {isGlobal ? <ModelOverridesPanel page={overridesPage} /> : null}
    </div>
  );
}
