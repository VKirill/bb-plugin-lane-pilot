import { useState, type ReactNode } from "react";
import { roleDisplayName, t, type Locale } from "@lane-pilot/i18n";
import { belowTier, modelTier, roleFallbackModel, type ModelCatalog, type ModelTier } from "@lane-pilot/models";
import { Badge, Button, Icon, StatusPill } from "@lane-pilot/ui-kit";
import type { LoadoutRole } from "../../contracts";
import { roleName, rolePurpose, type RoleSpec } from "../../native-agent/ui";
import { NativeModelPicker, type ModelChoice } from "../../ui-shell/ui";
import { ORIGIN_LABEL, RoleAccessBody, PmAccessNote, isChanged, roleKey, roleSummary, type AccessApi, type Origin, type RoleView } from "./agent-access";
import { AS_WRITER, TABLE_EFFORTS, type TableRoleRow } from "./agents-loadout-helpers";

/** Required items are the same for every role and are named once under the table, so the cells list only what a role adds. */
const isOptionalItem = (item: LoadoutRole["items"][number]): boolean => item.from !== "required";

const itemLabel = (type: LoadoutRole["items"][number]["type"]): string => {
  if (type === "skill") return t("consoleLoadoutColSkills");
  if (type === "plugin") return t("consoleLoadoutColPlugins");
  if (type === "mcp") return t("consoleLoadoutColMcp");
  if (type === "instructions") return t("consoleLoadoutInstructions");
  return t("consoleLoadoutTools");
};

function PoolLine({
  roleId,
  row,
  catalog,
  busy,
  onSavePool,
}: {
  roleId: string;
  row: TableRoleRow;
  catalog: ModelCatalog;
  busy: boolean;
  onSavePool: (nextPool: TableRoleRow["pool"]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const label = (entry: { providerId: string; model: string }) =>
    catalog.providers.find((p) => p.id === entry.providerId)?.models.find((m) => m.id === entry.model)?.displayName ?? entry.model;
  const builtin = row.pool.length ? null : roleFallbackModel(roleId);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground" data-testid={`loadout-pool-${roleId}`}>
      <span>{row.pool.length ? t("roleModelsPool") : builtin ? `${t("roleModelsPool")}${label(builtin)}` : t("roleModelsPoolNone")}</span>
      {row.pool.map((entry) => (
        <span
          key={`${entry.providerId}/${entry.model}`}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--lp-hairline)] px-1.5 py-0.5 text-foreground"
        >
          {label(entry)}
          {entry.effort ? ` · ${entry.effort}` : ""}
          <button
            type="button"
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t("roleModelsPoolRemove").replace("{model}", label(entry))}
            data-testid={`loadout-pool-remove-${roleId}-${entry.model}`}
            onClick={() => onSavePool(row.pool.filter((item) => item !== entry))}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <div className="basis-full pt-1">
          <NativeModelPicker
            catalog={catalog}
            seed={{ providerId: null, model: null, effort: null, serviceTier: null }}
            disabled={busy}
            testId={`loadout-pool-picker-${roleId}`}
            label={t("roleModelsPoolAdd").replace("{role}", roleId)}
            onChoose={(choice) => {
              setAdding(false);
              if (
                (choice.providerId === row.providerId && choice.model === row.model) ||
                row.pool.some((entry) => entry.providerId === choice.providerId && entry.model === choice.model)
              ) {
                return;
              }
              onSavePool([
                ...row.pool,
                { providerId: choice.providerId, model: choice.model, effort: choice.effort && TABLE_EFFORTS.has(choice.effort) ? choice.effort : null },
              ]);
            }}
          />
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-5 px-1.5 text-[11px]"
        disabled={busy}
        aria-label={t("roleModelsPoolAdd").replace("{role}", roleId)}
        data-testid={`loadout-pool-add-${roleId}`}
        onClick={() => setAdding((current) => !current)}
      >
        {adding ? "−" : "+"}
      </Button>
    </div>
  );
}

function CountCell({
  names,
  heading,
  missingCount,
  label,
  testId,
}: {
  names: readonly string[];
  heading: string;
  missingCount: number;
  label: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--lp-body)]" data-testid={testId}>
      <span className="text-muted-foreground md:hidden">{heading}:</span>
      <span className="min-w-0 break-words" title={names.length > 0 ? label.replace("{n}", String(names.length)) : undefined}>
        {names.length > 0 ? names.join(", ") : "—"}
      </span>
      {missingCount > 0 ? (
        <StatusPill tone="warn" className="text-[11px]">
          {t("consoleLoadoutMissingFlag")}
        </StatusPill>
      ) : null}
    </div>
  );
}

export interface LoadoutRoleRowProps {
  entry: LoadoutRole;
  accessRole: string;
  tableRoleId: string | null;
  tableRow: TableRoleRow | undefined;
  spec: RoleSpec | undefined;
  accessViewRole: RoleView | undefined;
  access: AccessApi;
  catalog: ModelCatalog | null;
  locale: Locale;
  isGlobal: boolean;
  busy: boolean;
  open: boolean;
  wide: boolean;
  leastTier: ModelTier | undefined;
  hasExplicitKeys: boolean;
  onToggle: () => void;
  onSaveModel: (tableRoleId: string, row: TableRoleRow | undefined, choice: ModelChoice) => void;
  onSavePool: (tableRoleId: string, row: TableRoleRow, nextPool: TableRoleRow["pool"]) => void;
  onResetAbove: () => void;
  renderWriterModel?: () => ReactNode;
  renderOnboarderModel?: () => ReactNode;
  renderExtraPicker?: (selectionId: string) => ReactNode;
  renderWriterDetail?: () => ReactNode;
  renderBrowserDetail?: () => ReactNode;
  renderSettingSwitch?: (spec: RoleSpec) => ReactNode;
}

export const MATRIX_GRID =
  "grid min-w-0 items-center gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.65fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_auto]";

/** Single unified matrix row for a role from `agent_loadout` with inline model/pool picker, missing flags, reset, and expandable drawer. */
export function LoadoutRoleRow({
  entry,
  accessRole,
  tableRoleId,
  tableRow,
  spec,
  accessViewRole,
  access,
  catalog,
  locale,
  isGlobal,
  busy,
  open,
  wide,
  leastTier,
  hasExplicitKeys,
  onToggle,
  onSaveModel,
  onSavePool,
  onResetAbove,
  renderWriterModel,
  renderOnboarderModel,
  renderExtraPicker,
  renderWriterDetail,
  renderBrowserDetail,
  renderSettingSwitch,
}: LoadoutRoleRowProps) {
  const id = roleKey(accessRole);
  // HTML ids must be unique per row: scout seats share `accessRole` but not `entry.role`.
  const domId = roleKey(entry.role);
  const changed = accessViewRole ? isChanged(accessViewRole) : false;
  const accessOrigin: "role" | Origin = changed && accessViewRole ? accessViewRole.origin ?? access.scope : "role";
  const displayName =
    entry.kind === "custom"
      ? entry.role
      : (() => {
          const translated = roleDisplayName(accessRole, locale);
          return translated !== accessRole ? translated : t(roleName(accessRole));
        })();
  const purposeKey = rolePurpose(accessRole);
  const purposeText = t(purposeKey);
  const showPurpose = purposeText && purposeText !== purposeKey;

  const skills = entry.items.filter((item) => item.type === "skill");
  const plugins = entry.items.filter((item) => item.type === "plugin");
  const mcps = entry.items.filter((item) => item.type === "mcp");
  const missingSkills = skills.filter((item) => item.missing).length;
  const missingPlugins = plugins.filter((item) => item.missing).length;
  const missingMcps = mcps.filter((item) => item.missing).length;
  const totalMissing = entry.items.filter((item) => item.missing).length;

  const isOwnModelAtScope = tableRow ? tableRow.own : !isGlobal && (entry.model.from === "project" || entry.model.from === "section");
  const isOwnAccessAtScope = Boolean(accessViewRole && accessViewRole.origin === access.scope && !accessViewRole.inherited);
  const canResetAbove = !isGlobal && (isOwnModelAtScope || isOwnAccessAtScope || hasExplicitKeys);
  const canResetGlobal = isGlobal && Boolean(tableRow?.own);

  const effectiveModelId = tableRow?.model ?? entry.model.model ?? "";
  const effectiveProviderId = tableRow?.providerId ?? entry.model.provider ?? null;
  const lightWarning = Boolean(
    leastTier &&
      effectiveModelId &&
      (tableRow?.source === "table" || entry.model.from !== "builtin") &&
      belowTier(modelTier(effectiveModelId), leastTier),
  );

  const hasCatalogProviders = Boolean(
    catalog?.providers.some((p) => p.hostIds.length > 0 && p.models.some((m) => m.hostIds.length > 0)),
  );

  let modelCell: ReactNode;
  if (entry.role === "writer" && renderWriterModel) {
    modelCell = renderWriterModel();
  } else if (entry.role === "onboarder" && renderOnboarderModel) {
    modelCell = renderOnboarderModel();
  } else if (AS_WRITER.has(entry.role)) {
    modelCell = <span className="text-xs text-muted-foreground" data-testid={`loadout-model-${id}`}>{t("teamModelAsWriter")}</span>;
  } else if (entry.role === "workspace-provisioner") {
    modelCell = <span className="text-xs text-muted-foreground" data-testid={`loadout-model-${id}`}>—</span>;
  } else if (entry.kind === "pm") {
    modelCell = (
      <span className="text-xs text-muted-foreground" data-testid={`loadout-model-${id}`}>
        {entry.model.provider && entry.model.model ? `${entry.model.provider} · ${entry.model.model}` : "—"}
      </span>
    );
  } else if (tableRoleId && hasCatalogProviders && catalog) {
    modelCell = (
      <div className="min-w-0 space-y-1" data-testid={`loadout-model-${id}`}>
        <NativeModelPicker
          catalog={catalog}
          seed={{
            providerId: effectiveProviderId,
            model: effectiveModelId || null,
            effort: tableRow?.effort ?? null,
            serviceTier: null,
          }}
          disabled={busy}
          testId={`loadout-model-pick-${entry.role}`}
          label={t("roleModelsModelLabel").replace("{role}", displayName)}
          onChoose={(choice) => onSaveModel(tableRoleId, tableRow, choice)}
        />
        {tableRow ? (
          <PoolLine
            roleId={tableRoleId}
            row={tableRow}
            catalog={catalog}
            busy={busy}
            onSavePool={(nextPool) => onSavePool(tableRoleId, tableRow, nextPool)}
          />
        ) : null}
        {lightWarning ? <span className="block text-[11px] lp-text-warning">{t("roleModelsLight")}</span> : null}
      </div>
    );
  } else if (spec?.model && spec.model !== "writer" && renderExtraPicker) {
    modelCell = renderExtraPicker(spec.model);
  } else {
    modelCell = (
      <span className="text-xs text-muted-foreground" data-testid={`loadout-model-${id}`}>
        {effectiveProviderId && effectiveModelId ? `${effectiveProviderId} · ${effectiveModelId}` : effectiveModelId || "—"}
      </span>
    );
  }

  const toggleSwitch = spec?.enabled && renderSettingSwitch ? renderSettingSwitch(spec) : null;
  const hasDrawer = Boolean(
    entry.items.length > 0 ||
      entry.note ||
      (entry.role === "writer" && renderWriterDetail) ||
      (entry.role === "browser-qa" && renderBrowserDetail) ||
      (accessViewRole && access.view) ||
      entry.kind === "pm",
  );

  const summary = accessViewRole && access.view ? roleSummary(accessViewRole, access.view.mandatory) : null;

  return (
    <div
      id={`access-card-${domId}`}
      data-testid={`access-role-${id}`}
      data-role-row={accessRole}
      data-loadout-role={entry.role}
      data-lp-keys={spec?.keys.join(" ") ?? ""}
      data-open={open}
      data-changed={changed}
      data-origin={accessOrigin}
      className="min-w-0 scroll-mt-3 border-t border-[var(--lp-hairline)] first:border-t-0"
    >
      <div data-testid={spec?.testId} className={wide ? `${MATRIX_GRID} px-4 py-[11px]` : "grid min-w-0 gap-2 px-4 py-3"}>
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12.5px] font-[550] text-[var(--lp-ink)]">{displayName}</span>
              {entry.machine ? (
                <Badge variant="outline" className="text-[10px]">
                  {entry.machine}
                </Badge>
              ) : null}
              {changed ? (
                <Badge variant="secondary" className="text-[10px]" data-testid={`access-badge-${id}`}>
                  {t(ORIGIN_LABEL[accessOrigin])}
                </Badge>
              ) : null}
            </div>
            {showPurpose ? <div className="text-xs text-muted-foreground">{purposeText}</div> : null}
            {summary ? (
              <div className="text-[11px] text-muted-foreground" data-testid={`access-summary-${id}`}>
                {summary}
              </div>
            ) : null}
          </div>
          {toggleSwitch ? <div className="shrink-0">{toggleSwitch}</div> : null}
        </div>

        <div className="min-w-0 max-w-full" data-testid={spec?.model ? `role-model-${id}` : undefined}>
          {modelCell}
        </div>

        <CountCell
          names={skills.filter(isOptionalItem).map((item) => item.name)}
          heading={t("consoleLoadoutColSkills")}
          missingCount={missingSkills}
          label={t("consoleLoadoutCountSkills")}
          testId={`loadout-skills-${id}`}
        />
        <CountCell
          names={plugins.filter(isOptionalItem).map((item) => item.name)}
          heading={t("consoleLoadoutColPlugins")}
          missingCount={missingPlugins}
          label={t("consoleLoadoutCountPlugins")}
          testId={`loadout-plugins-${id}`}
        />
        <CountCell
          names={mcps.filter(isOptionalItem).map((item) => item.name)}
          heading={t("consoleLoadoutColMcp")}
          missingCount={missingMcps}
          label={t("consoleLoadoutCountMcp")}
          testId={`loadout-mcp-${id}`}
        />

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {canResetAbove ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              className="h-7 px-2 text-xs"
              data-testid={`loadout-reset-${id}`}
              onClick={onResetAbove}
            >
              {t("consoleLoadoutResetLevelAbove")}
            </Button>
          ) : canResetGlobal ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              className="h-7 px-2 text-xs"
              data-testid={`loadout-reset-${id}`}
              onClick={onResetAbove}
            >
              {t("roleModelsReset")}
            </Button>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`role-drawer-${domId}`}
            disabled={!hasDrawer}
            onClick={onToggle}
            data-testid={`role-open-${id}`}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-[var(--lp-well)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
          >
            <Icon name="ChevronRight" className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
            {totalMissing > 0 ? (
              <StatusPill tone="warn" className="text-[10px]">
                {totalMissing}
              </StatusPill>
            ) : null}
          </button>
        </div>
      </div>

      {open ? (
        <div
          id={`role-drawer-${domId}`}
          data-testid={`role-drawer-${id}`}
          className="min-w-0 space-y-4 border-t border-[var(--lp-hairline)] bg-[var(--lp-well)]/40 px-3 py-3"
        >
          {entry.items.length > 0 || entry.note ? (
            <div className="space-y-2" data-testid={`loadout-detail-${id}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
                <span>{t("consoleLoadoutItemsTitle")}</span>
                {entry.machine ? (
                  <span className="text-muted-foreground">{t("consoleLoadoutMachine").replace("{machine}", entry.machine)}</span>
                ) : null}
                {entry.note ? <span className="text-muted-foreground">· {entry.note}</span> : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {entry.items.map((item) => (
                  <span
                    key={`${item.type}:${item.name}`}
                    data-testid={`loadout-item-${id}-${item.type}-${item.name}`}
                    data-missing={item.missing ? "true" : "false"}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                      item.missing ? "border-[var(--lp-warning)] bg-[var(--lp-card)]" : "border-[var(--lp-hairline)] bg-[var(--lp-card)]"
                    }`}
                  >
                    <span className="text-muted-foreground">{itemLabel(item.type)}:</span>
                    <span className="font-medium text-foreground">{item.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      ({t("consoleLoadoutFromPrefix").replace("{from}", item.from)})
                    </span>
                    {item.missing ? (
                      <StatusPill tone="warn" className="text-[10px]">
                        {t("consoleLoadoutMissingFlag")}
                      </StatusPill>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {entry.role === "writer" && renderWriterDetail ? renderWriterDetail() : null}
          {entry.role === "browser-qa" && renderBrowserDetail ? renderBrowserDetail() : null}

          {entry.kind === "pm" ? <PmAccessNote /> : null}

          {accessViewRole && access.view ? (
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{t("tabAccess")}</h3>
                <Badge variant={changed ? "secondary" : "outline"} data-testid={`access-badge-open-${id}`}>
                  {t(ORIGIN_LABEL[accessOrigin])}
                </Badge>
              </div>
              <RoleAccessBody
                role={accessViewRole}
                view={access.view}
                scope={access.scope}
                below={access.below[accessViewRole.role] ?? "role"}
                busy={access.busy === accessViewRole.role}
                onSave={(r, v) => void access.save(r, v)}
                onReset={(r) => void access.reset(r)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
