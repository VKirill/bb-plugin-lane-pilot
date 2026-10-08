import { useState, type ReactNode } from "react";
import { t, type I18nKey } from "../../i18n";
import { agentPickerLabel } from "../agent-display";
import { Badge } from "@lane-pilot/ui-kit";
import { Icon } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import { AccessModePanel, isChanged, ORIGIN_LABEL, PmAccessNote, RoleAccessBody, roleSummary, useAccessView, type AccessApi, type RoleView } from "./agent-access";
import { useRulesAnalyzer } from "./rule-proposals";
import { asBoolean } from "./page-model";
import { SettingField } from "./setting-controls";
import { BrowserDetail, CouncilDetail, WriterDetail } from "./team-details";
import { originOfKeys, roleKey, roleName, rolePurpose, ROLE_GROUPS, type RoleOrigin, type RoleSpec } from "./team-model";
import { Pill, type PillTone } from "./pill";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { LpPage } from "./use-lp-page";

const ORIGIN_TONE: Record<RoleOrigin, PillTone> = { here: "info", inherited: "neutral", default: "muted" };

/** The row grid on a wide column: role, on/off, model, where the value comes from, what the role loads. */
const WIDE_GRID = "grid min-w-0 items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.15fr)_4.5rem_minmax(0,1.7fr)_6.75rem_minmax(0,1fr)]";

function useRoleModel(page: LpPage) {
  const { isGlobal, projectId } = page;
  const rules = useRulesAnalyzer(isGlobal ? null : projectId);
  return { rules };
}

/** One role of the table: name, on/off, model picker, origin and access, with a drawer for what is specific to the role. */
function RoleRow({ spec, page, access, rules, open, onToggle }: {
  spec: RoleSpec; page: LpPage; access: AccessApi; rules: ReturnType<typeof useRulesAnalyzer>; open: boolean; onToggle: () => void;
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
  if (spec.model === "writer") model = modelPicker(pickerValue, (next) => { saveWriterSelection(next); });
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
  const { projectId, selectedSectionId, isGlobal, data, displayedValue, stackControls, wideTable } = page;
  const access = useAccessView(projectId!, selectedSectionId, data?.versions["helper.context_mode"] ?? 0);
  const { rules } = useRoleModel(page);
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
                    <RoleRow key={spec.id} spec={spec} page={page} access={access} rules={rules} open={open.has(spec.id)} onToggle={() => toggle(spec.id)} />
                  ))}
                </section>
              ))}
            </div>
          </div>
        </SurfaceBody>
      </Surface>
      <AccessModePanel api={access} modeControl={modeControl} />
    </div>
  );
}
