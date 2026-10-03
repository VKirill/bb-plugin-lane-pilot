import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { detectLocale, t, type I18nKey } from "../../i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "../lp-defaults";
import { ACCESS_GROUPS, ACCESS_SWITCHES, CORE_INSTRUCTION_SWITCHES, type AccessGroup, type AccessSwitch, type RoleAccess } from "../helper-context";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { CONTROL_H } from "./control-row";
import { usePanelLayout } from "./panel-layout";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";

type Source = "role" | "owner";
/** The layer a value comes from: the role profile in code, or the scope that holds the row. */
type Origin = "global" | "project" | "section";
type RoleView = {
  role: string; key: string; version: number; value: unknown; inherited: boolean; origin: Origin | null;
  groups: Record<AccessGroup, { names: string[] | null; source: Source }>;
  switches: Record<AccessSwitch, { include: boolean; source: Source }>;
};
type AccessView = {
  mode: string;
  modeOrigin: Origin | null;
  roles: RoleView[];
  catalog: { bbPlugins: Array<{ id: string; name: string }>; skills: Array<{ name: string; description: string }> };
  mandatory: { bbPlugins: string[]; mcpServers: string[] };
  providers: Record<string, string[]>;
};

const SECTIONS: Array<{ id: "code" | "check" | "project" | "browser" | "specialists"; roles: string[] }> = [
  { id: "code", roles: ["writer", "code-repair", "night-fixer"] },
  { id: "check", roles: ["plan-critic", "code-critic", "specialist-reviewer", "night-reviewer", "gate-triage", "pm-reader", "council-seat", "rules-analyzer"] },
  { id: "project", roles: ["docs-maintainer", "onboarder", "memory-maintainer", "project-life"] },
  { id: "browser", roles: ["browser-qa", "errand"] },
  { id: "specialists", roles: ["specialist:design-lead", "specialist:copy-lead", "specialist:seo-specialist", "specialist:tavily"] },
];
const roleKey = (role: string) => role.replace(/[:-]/g, "_");
const GROUP_LABEL: Record<AccessGroup, I18nKey> = {
  bbPlugins: "accessBbPlugins", skills: "accessSkills", mcpServers: "accessMcpServers", nativePlugins: "accessNativePlugins",
};
const SWITCH_LABEL: Record<AccessSwitch, { label: I18nKey; hint: I18nKey }> = {
  userInstructions: { label: "accessUserInstructions", hint: "accessUserInstructionsHint" },
  projectInstructions: { label: "accessProjectInstructions", hint: "accessProjectInstructionsHint" },
};
const PROVIDER_LABEL: Record<string, I18nKey> = {
  "claude-code": "accessProviderClaudeCode", codex: "accessProviderCodex", "acp-opencode": "accessProviderOpencode", "acp-cursor": "accessProviderCursor",
};
const ORIGIN_LABEL: Record<"role" | Origin, I18nKey> = {
  role: "accessOrigin_role", global: "accessOrigin_global", project: "accessOrigin_project", section: "accessOrigin_section",
};
const RESET_LABEL: Record<"role" | Origin, I18nKey> = {
  role: "accessResetTo_role", global: "accessResetTo_global", project: "accessResetTo_project", section: "accessResetTo_section",
};
const COLUMNS = [...ACCESS_GROUPS, ...ACCESS_SWITCHES] as const;
const SHOWN_NAMES = 5;

/** «1 навык», «2 навыка», «5 навыков»: the form key follows the language's plural rule. */
function counted(n: number, base: "accessSkill" | "accessBbPlugin" | "accessCliPlugin"): string {
  const form = detectLocale() === "ru"
    ? (n % 10 === 1 && n % 100 !== 11 ? 1 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 2 : 5)
    : (n === 1 ? 1 : 2);
  return `${n} ${t(`${base}_${form}` as I18nKey)}`;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** The owner's own changes as the server stores them, rebuilt from what the view reports as «owner». */
function ownerAccess(role: RoleView, mandatory: AccessView["mandatory"]): RoleAccess {
  const out: RoleAccess = {};
  for (const group of ACCESS_GROUPS) {
    const view = role.groups[group];
    if (view.source !== "owner") continue;
    const locked = lockedNames(group, mandatory);
    out[group] = view.names === null ? { mode: "all" } : { mode: "allow", names: view.names.filter((name) => !locked.includes(name)) };
  }
  for (const sw of ACCESS_SWITCHES) {
    const view = role.switches[sw];
    if (view.source === "owner") out[sw] = view.include ? "include" : "leave_out";
  }
  return out;
}

function lockedNames(group: AccessGroup, mandatory: AccessView["mandatory"]): string[] {
  return group === "bbPlugins" ? mandatory.bbPlugins : group === "mcpServers" ? mandatory.mcpServers : [];
}

function isChanged(role: RoleView): boolean {
  return ACCESS_GROUPS.some((group) => role.groups[group].source === "owner") || ACCESS_SWITCHES.some((sw) => role.switches[sw].source === "owner");
}

/** One line for the collapsed card: only what the helper loads beyond the always-on core. */
function roleSummary(role: RoleView, mandatory: AccessView["mandatory"]): string {
  const parts: string[] = [];
  const extra = (group: AccessGroup) => (role.groups[group].names ?? []).filter((name) => !lockedNames(group, mandatory).includes(name)).length;
  const entries: Array<[AccessGroup, (n: number) => string]> = [
    ["skills", (n) => counted(n, "accessSkill")],
    ["bbPlugins", (n) => counted(n, "accessBbPlugin")],
    ["mcpServers", (n) => `${n} MCP`],
    ["nativePlugins", (n) => counted(n, "accessCliPlugin")],
  ];
  for (const [group, label] of entries) {
    if (role.groups[group].names === null) parts.push(`${t(GROUP_LABEL[group])}: ${t("accessAllShort")}`);
    else if (extra(group) > 0) parts.push(label(extra(group)));
  }
  if (role.switches.userInstructions.include) parts.push(t("accessUserOn"));
  if (!role.switches.projectInstructions.include) parts.push(t("accessProjectOff"));
  return parts.length ? parts.join(" · ") : t("accessNothingExtra");
}

function namesText(names: string[] | null, allowTrim: boolean): string {
  if (names === null) return t("accessEverything");
  if (!names.length) return t("accessNothing");
  if (!allowTrim || names.length <= SHOWN_NAMES + 1) return names.join(", ");
  const rest = names.length - SHOWN_NAMES;
  return `${names.slice(0, SHOWN_NAMES).join(", ")} +${rest}`;
}

type Suggestion = { name: string; label: string; detail?: string };

/** Chips of the chosen names (the always-on ones locked) and a search box over the catalog; free text when no catalog. */
function NameEditor({ chosen, locked, catalog, searchLabel, disabled, testId, onChange }: {
  chosen: string[]; locked: string[]; catalog: Suggestion[] | null; searchLabel: string; disabled: boolean; testId: string; onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const taken = new Set([...locked, ...chosen]);
  const needle = query.trim().toLowerCase();
  const matches = (catalog ?? []).filter((item) => !taken.has(item.name)
    && (!needle || item.name.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle) || (item.detail ?? "").toLowerCase().includes(needle)));
  // Exact name first, then names starting with the query, then names containing it, then description hits:
  // «ru-text» must not lose to a skill that only mentions ru-text in its description.
  const rank = (item: Suggestion) => {
    const name = item.name.toLowerCase(), bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    if (!needle) return 4;
    if (name === needle) return 0;
    if (bare === needle) return 0.5;
    if (name.startsWith(needle) || bare.startsWith(needle)) return 1;
    if (name.includes(needle) || item.label.toLowerCase().includes(needle)) return 2;
    return 3;
  };
  const shown = matches.map((item, index) => ({ item, index, r: rank(item) })).sort((a, b) => a.r - b.r || a.index - b.index).slice(0, 8).map((row) => row.item);
  const exact = (catalog ?? []).find((item) => item.name.toLowerCase() === needle);
  const custom = needle && !taken.has(query.trim()) && !exact ? query.trim() : null;
  const add = (name: string) => {
    const clean = name.trim();
    if (!clean || taken.has(clean)) return;
    onChange([...chosen, clean]);
    setQuery("");
  };
  const submit = () => {
    if (!needle) return;
    if (exact) return add(exact.name);
    if (catalog && matches.length === 1) return add(matches[0]!.name);
    add(query);
  };
  return (
    <div className="min-w-0 space-y-2" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {locked.map((name) => (
          <span key={`lock-${name}`} title={t("accessLocked")} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--lp-hairline)] bg-[var(--lp-well)] px-2 py-0.5 text-xs text-muted-foreground" data-chip="locked">
            <Icon name="Lock" className="size-3 shrink-0" /><span className="min-w-0 break-all">{name}</span>
          </span>
        ))}
        {chosen.map((name) => (
          <span key={name} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--lp-outline)] bg-[var(--lp-card)] py-0.5 pl-2 pr-0.5 text-xs" data-chip="chosen">
            <span className="min-w-0 break-all">{name}</span>
            <button type="button" aria-label={`${t("accessRemove")}: ${name}`} disabled={disabled} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--lp-well)] hover:text-foreground disabled:opacity-50" onClick={() => onChange(chosen.filter((item) => item !== name))}>
              <Icon name="X" className="size-3" />
            </button>
          </span>
        ))}
        {!chosen.length ? <span className="text-xs text-muted-foreground">{t("accessEmptyList")}</span> : null}
      </div>
      {/* The suggestions float over the page: in the flow they pushed the buttons below, and a click that blurred
          the field closed them, so the button jumped away under the pointer (found live on 0.1.78). */}
      <div className="relative min-w-0">
        <Input value={query} disabled={disabled} aria-label={searchLabel} placeholder={searchLabel} className="h-9 w-full min-w-0 text-sm"
          onChange={(event) => setQuery(event.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } if (event.key === "Escape") setQuery(""); }} />
        {focused && (shown.length || custom) ? (
          <div role="listbox" aria-label={searchLabel} className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 min-w-0 overflow-y-auto rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-1 shadow-lg">
            {shown.map((item) => (
              <button key={item.name} type="button" role="option" aria-selected={false} title={item.detail || item.label} className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--lp-well)]"
                onMouseDown={(event) => event.preventDefault()} onClick={() => add(item.name)}>
                <span className="block break-all">{item.name}</span>
                {item.label !== item.name ? <span className="block truncate text-xs text-muted-foreground">{item.label}</span> : item.detail ? <span className="block truncate text-xs text-muted-foreground">{item.detail}</span> : null}
              </button>
            ))}
            {custom ? (
              <button type="button" role="option" aria-selected={false} className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--lp-well)]"
                onMouseDown={(event) => event.preventDefault()} onClick={() => add(custom)}>
                {t("accessAddName")} <span className="break-all">«{custom}»</span>
              </button>
            ) : null}
            {!shown.length && !custom ? <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("accessNoMatches")}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AccessRow({ testId, label, hint, effective, origin, control, children }: {
  testId: string; label: string; hint?: string; effective: string; origin: "role" | Origin; control: ReactNode; children?: ReactNode;
}) {
  const { stackControls } = usePanelLayout();
  return (
    <div className="min-w-0 space-y-2 py-2" data-testid={testId} data-origin={origin}>
      <div className={stackControls ? "grid min-w-0 gap-1.5" : "grid min-w-0 gap-1.5 md:grid-cols-[minmax(0,1fr)_11rem] md:items-start md:gap-3"}>
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
          <div className="break-words text-xs text-muted-foreground" data-testid={`${testId}-effective`} title={effective}>
            {effective}<span> · </span><span className={origin === "role" ? "" : "text-foreground"} data-testid={`${testId}-origin`}>{t(ORIGIN_LABEL[origin])}</span>
          </div>
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function ModeSelect({ value, options, label, disabled, testId, onChange }: {
  value: string; options: Array<[string, I18nKey]>; label: string; disabled: boolean; testId: string; onChange: (next: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} data-testid={testId} className={`${CONTROL_H} w-full min-w-0`}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([id, key]) => <SelectItem key={id} value={id}>{t(key)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function RoleCard({ role, view, scope, below, open, busy, onToggle, onSave, onReset }: {
  role: RoleView; view: AccessView; scope: Origin; below: "role" | Origin; open: boolean; busy: boolean; onToggle: () => void;
  onSave: (role: RoleView, next: RoleAccess | null) => void; onReset: (role: RoleView) => void;
}) {
  const id = roleKey(role.role);
  const changed = isChanged(role);
  const origin: "role" | Origin = changed ? role.origin ?? scope : "role";
  const rowOrigin = (source: Source): "role" | Origin => source === "owner" ? role.origin ?? scope : "role";
  const current = ownerAccess(role, view.mandatory);
  const commit = (patch: RoleAccess) => {
    const next: RoleAccess = { ...current, ...patch };
    for (const key of Object.keys(next) as Array<keyof RoleAccess>) if (next[key] === undefined) delete next[key];
    onSave(role, Object.keys(next).length ? next : null);
  };
  const groupRow = (group: AccessGroup) => {
    const state = role.groups[group];
    const locked = lockedNames(group, view.mandatory);
    const mode = state.source === "role" ? "role" : state.names === null ? "all" : "allow";
    const chosen = (state.names ?? []).filter((name) => !locked.includes(name));
    const setMode = (next: string) => {
      if (next === mode) return;
      commit({ [group]: next === "role" ? undefined : next === "all" ? { mode: "all" } : { mode: "allow", names: chosen } });
    };
    const catalog: Suggestion[] | null = group === "bbPlugins"
      ? view.catalog.bbPlugins.map((plugin) => ({ name: plugin.id, label: plugin.name }))
      : group === "skills" ? view.catalog.skills.map((skill) => ({ name: skill.name, label: skill.name, detail: skill.description })) : null;
    const searchLabel = group === "bbPlugins" ? t("accessAddSearchPlugins") : group === "skills" ? t("accessAddSearchSkills") : t("accessAddTypeName");
    return (
      <AccessRow key={group} testId={`access-${id}-${group}`} label={t(GROUP_LABEL[group])} origin={rowOrigin(state.source)}
        effective={namesText(state.names, mode === "role")}
        control={<ModeSelect value={mode} label={t(GROUP_LABEL[group])} disabled={busy} testId={`access-${id}-${group}-mode`} onChange={setMode}
          options={[["role", "accessModeRole"], ["all", "accessModeAll"], ["allow", "accessModeAllow"]]} />}>
        {mode === "allow" ? (
          <NameEditor chosen={chosen} locked={locked} catalog={catalog} searchLabel={searchLabel} disabled={busy} testId={`access-${id}-${group}-editor`}
            onChange={(next) => { if (!sameList(next, chosen)) commit({ [group]: { mode: "allow", names: next } }); }} />
        ) : null}
      </AccessRow>
    );
  };
  const switchRow = (sw: AccessSwitch) => {
    const state = role.switches[sw];
    const mode = state.source === "role" ? "role" : state.include ? "include" : "leave_out";
    return (
      <AccessRow key={sw} testId={`access-${id}-${sw}`} label={t(SWITCH_LABEL[sw].label)} hint={t(SWITCH_LABEL[sw].hint)} origin={rowOrigin(state.source)}
        effective={t(state.include ? "accessIncluded" : "accessLeftOut")}
        control={<ModeSelect value={mode} label={t(SWITCH_LABEL[sw].label)} disabled={busy} testId={`access-${id}-${sw}-mode`}
          onChange={(next) => { if (next !== mode) commit({ [sw]: next === "role" ? undefined : next }); }}
          options={[["role", "accessModeRole"], ["include", "accessInclude"], ["leave_out", "accessLeaveOut"]]} />} />
    );
  };
  return (
    <div id={`access-card-${id}`} className="lp-card min-w-0 scroll-mt-3 overflow-hidden" data-testid={`access-role-${id}`} data-open={open} data-changed={changed} data-origin={origin}>
      <button type="button" aria-expanded={open} aria-controls={`access-body-${id}`} onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-2 p-3 text-left hover:bg-[var(--lp-well)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="ChevronRight" className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block text-sm font-medium">{t(`accessName_${id}` as I18nKey)}</span>
          <span className="block text-xs text-muted-foreground">{t(`accessPurpose_${id}` as I18nKey)}</span>
          <span className="block break-words text-xs" data-testid={`access-summary-${id}`}>{roleSummary(role, view.mandatory)}</span>
        </span>
        <Badge variant={changed ? "secondary" : "outline"} className="shrink-0" data-testid={`access-badge-${id}`}>{t(ORIGIN_LABEL[origin])}</Badge>
      </button>
      {open ? (
        <div id={`access-body-${id}`} className="min-w-0 divide-y divide-[var(--lp-hairline)] border-t border-[var(--lp-hairline)] px-3 pb-2">
          {ACCESS_GROUPS.map(groupRow)}
          {ACCESS_SWITCHES.map(switchRow)}
          {role.origin === scope && !role.inherited ? (
            <div className="pt-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onReset(role)}>
                <Icon name="RotateCcw" className="mr-1.5 size-3.5" />{t(RESET_LABEL[below])}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** «Claude Code и Codex: всё. OpenCode: всё, кроме плагинов CLI.» built from what each provider can narrow. */
function providerLines(providers: Record<string, string[]>): string[] {
  const join = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${t("accessAnd")} ${items.at(-1)}`;
  const byKind = new Map<string, { names: string[]; groups: string[]; switches: string[] }>();
  for (const [id, groups] of Object.entries(providers)) {
    const supported = (CORE_INSTRUCTION_SWITCHES as Record<string, readonly string[]>)[id] ?? [];
    const missing = ACCESS_SWITCHES.filter((sw) => !supported.includes(sw));
    const kind = `${[...groups].sort().join()}|${missing.join()}`;
    const row = byKind.get(kind) ?? { names: [], groups: [...groups], switches: missing };
    row.names.push(PROVIDER_LABEL[id] ? t(PROVIDER_LABEL[id]!) : id);
    byKind.set(kind, row);
  }
  return [...byKind.values()].map(({ names, groups, switches }) => {
    const absent = ACCESS_GROUPS.filter((group) => !groups.includes(group));
    const label = (group: string) => t(`accessGroupShort_${group}` as I18nKey);
    const what = !absent.length ? t("accessEverythingHonored")
      : absent.length === 1 ? `${t("accessExceptPrefix")} ${t(`accessExcept_${absent[0]!}` as I18nKey)}`
        : join(ACCESS_GROUPS.filter((group) => groups.includes(group)).map(label));
    const notes = [
      ...(names.some((name) => name === t("accessProviderCursor")) ? [t("accessCursorNote")] : []),
      ...switches.map((sw) => t(`accessSwitchNote_${sw}` as I18nKey)),
    ];
    return `${join(names)}: ${[what, ...notes].join("; ")}.`;
  });
}

function cellText(role: RoleView, column: (typeof COLUMNS)[number], mandatory: AccessView["mandatory"]): string {
  if (column === "userInstructions" || column === "projectInstructions") return role.switches[column].include ? "✓" : "—";
  const names = role.groups[column].names;
  if (names === null) return t("accessAllShort");
  const count = names.filter((name) => !lockedNames(column, mandatory).includes(name)).length;
  return count ? String(count) : "—";
}

/** One line per role, one column per kind of resource; the table scrolls inside its own box on a narrow screen. */
function AccessMatrix({ view, scope, onPick }: { view: AccessView; scope: Origin; onPick: (role: string) => void }) {
  const known = new Map(view.roles.map((role) => [role.role, role]));
  // On a narrow column the table packs tighter so most of it fits; what does not fit scrolls inside the box.
  const { stackControls: compact } = usePanelLayout();
  const cellPad = compact ? "px-0" : "px-1.5";
  return (
    <Surface testId="access-matrix">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("accessMatrixTitle")}</h2></SurfaceHeader>
      <SurfaceBody className="space-y-2">
        <p className="max-w-xl text-xs text-muted-foreground">{t("accessMatrixHint")}</p>
        <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--lp-hairline)]" data-testid="access-matrix-scroll">
          <table className={compact ? "w-full min-w-[21rem] table-fixed border-collapse text-[11px]" : "w-full min-w-[36rem] border-collapse text-xs"}>
            <thead>
              <tr className="bg-[var(--lp-well)] text-muted-foreground">
                <th scope="col" className={`sticky left-0 z-[1] bg-[var(--lp-well)] py-1.5 text-left font-medium ${compact ? "w-[6.5rem] px-1.5" : "min-w-[9.5rem] px-2"}`}>{t("accessMatrixRole")}</th>
                {COLUMNS.map((column) => <th key={column} scope="col" className={`${cellPad} py-1.5 text-center font-medium leading-tight ${compact ? "text-[9.5px]" : ""}`}>{t(`accessCol_${column}` as I18nKey)}</th>)}
              </tr>
            </thead>
            <tbody>
              {SECTIONS.map((section) => {
                const roles = section.roles.map((role) => known.get(role)).filter((role): role is RoleView => Boolean(role));
                if (!roles.length) return null;
                return [
                  <tr key={`h-${section.id}`}><th colSpan={COLUMNS.length + 1} scope="colgroup" className="sticky left-0 border-t border-[var(--lp-hairline)] bg-[var(--lp-card)] px-2 pb-0.5 pt-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(`accessGroup_${section.id}` as I18nKey)}</th></tr>,
                  ...roles.map((role) => {
                    const id = roleKey(role.role);
                    const changed = isChanged(role);
                    const origin: "role" | Origin = changed ? role.origin ?? scope : "role";
                    return (
                      <tr key={role.role} data-testid={`access-matrix-row-${id}`} data-origin={origin} className="cursor-pointer border-t border-[var(--lp-hairline)] hover:bg-[var(--lp-well)]" onClick={() => onPick(role.role)}>
                        <th scope="row" className={`sticky left-0 z-[1] bg-[var(--lp-card)] py-1 text-left font-normal ${compact ? "px-1.5" : "px-2"}`}>
                          <button type="button" className="block w-full break-words text-left text-[11px] font-medium leading-tight hover:underline sm:text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{t(`accessName_${id}` as I18nKey)}</button>
                          <Badge variant={changed ? "secondary" : "outline"} className="mt-0.5 px-1.5 py-0 text-[10px]" data-testid={`access-matrix-origin-${id}`}>{t(ORIGIN_LABEL[origin])}</Badge>
                        </th>
                        {COLUMNS.map((column) => {
                          const owner = (column === "userInstructions" || column === "projectInstructions" ? role.switches[column].source : role.groups[column].source) === "owner";
                          return <td key={column} data-testid={`access-matrix-${id}-${column}`} className={`${cellPad} py-1 text-center tabular-nums ${owner ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{cellText(role, column, view.mandatory)}</td>;
                        })}
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      </SurfaceBody>
    </Surface>
  );
}

/** The PM chat is not a helper: it loads everything on purpose and has nothing to set here. */
function PmCard() {
  return (
    <div className="lp-card min-w-0 space-y-1 p-3" data-testid="access-pm-card">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="text-sm font-medium">{t("accessPmTitle")}</span>
        <Badge variant="outline" className="shrink-0">{t("accessPmBadge")}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t("accessPmBody")}</p>
      <p className="text-xs text-muted-foreground">{t("accessPmNarrow")}</p>
    </div>
  );
}

/**
 * The «Agent access» tab: per kind of helper, what its session loads (BB plugins, skills, MCP servers, CLI plugins,
 * personal and project instructions), where each value comes from (role profile, global, project or section), and
 * the owner's per-role changes at the current level.
 */
export function AgentAccess({ projectId, sectionId, parentSectionId, modeControl, refreshKey }: {
  projectId: string; sectionId: string | null; parentSectionId?: string | null; modeControl: ReactNode; refreshKey: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const scope: Origin = projectId === GLOBAL_SETTINGS_PROJECT_ID ? "global" : sectionId ? "section" : "project";
  const [view, setView] = useState<AccessView | null>(null);
  // What each role falls back to when this level's change is removed: the origin seen one level up.
  const [below, setBelow] = useState<Record<string, Origin | null>>({});
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const parent = scope === "global" ? null
      : scope === "project" ? { projectId: GLOBAL_SETTINGS_PROJECT_ID }
        : { projectId, ...(parentSectionId ? { sectionId: parentSectionId } : {}) };
    try {
      const [next, up] = await Promise.all([
        rpc.call("helper_access_view", { projectId, ...(sectionId ? { sectionId } : {}) }) as Promise<AccessView>,
        parent ? (rpc.call("helper_access_view", parent) as Promise<AccessView>).catch(() => null) : Promise.resolve(null),
      ]);
      if (mine !== generation.current) return;
      setView(next);
      setBelow(Object.fromEntries((up?.roles ?? []).map((role) => [role.role, role.origin])));
      setFailed(false);
    } catch { if (mine === generation.current) setFailed(true); }
  }, [projectId, sectionId, parentSectionId, scope, rpc]);

  // The mode field lives on the page, so a change there refetches the view.
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { setOpen(new Set()); }, [projectId, sectionId]);

  const scoped = { projectId, ...(sectionId ? { sectionId } : {}) };
  const settle = async (task: () => Promise<{ ok: boolean; conflict: boolean }>, role: string) => {
    setBusy(role);
    try {
      const result = await task();
      if (!result.ok) toast.error(t(result.conflict ? "accessConflict" : "accessSaveFailed"));
    } catch (cause) {
      toast.error(t("accessSaveFailed"), { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      await load();
      setBusy(null);
    }
  };
  const save = (role: RoleView, value: RoleAccess | null) => settle(() => rpc.call("save_setting", { ...scoped, key: role.key, value, expectedVersion: role.version }), role.role);
  // Removing this level's row lets the level below show through; a stored null would hide it.
  const reset = (role: RoleView) => settle(() => rpc.call("reset_project_settings", { ...scoped, keys: [role.key], expectedVersions: { [role.key]: role.version } }), role.role);

  const toggle = (role: string) => setOpen((current) => { const next = new Set(current); if (next.has(role)) next.delete(role); else next.add(role); return next; });
  const reveal = (role: string) => {
    setOpen((current) => new Set(current).add(role));
    setTimeout(() => document.getElementById(`access-card-${roleKey(role)}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const known = new Map((view?.roles ?? []).map((role) => [role.role, role]));
  const roleModeOff = view !== null && view.mode !== "roles";

  return (
    <div className="min-w-0 space-y-4" data-testid="agent-access" data-scope={scope}>
      <Surface testId="access-mode">
        <SurfaceHeader><h2 className="text-sm font-medium">{t("tabAccess")}</h2></SurfaceHeader>
        <SurfaceBody className="space-y-3">
          <p className="max-w-xl text-xs text-muted-foreground">{t("accessIntro")}</p>
          <p className="max-w-xl text-xs text-muted-foreground" data-testid="access-scope-note">{t(scope === "global" ? "accessIntroGlobal" : "accessOrder")}</p>
          {modeControl}
          {view ? <p className="text-xs text-muted-foreground" data-testid="access-mode-origin">{t("accessModeSource")}: <span className="text-foreground">{t(view.modeOrigin ? ORIGIN_LABEL[view.modeOrigin] : "accessOrigin_default")}</span></p> : null}
          {roleModeOff ? <p className="rounded-lg border border-[var(--lp-hairline)] bg-[var(--lp-well)] px-3 py-2 text-xs lp-text-warning" role="note" data-testid="access-mode-off">{t("accessModeOff")}</p> : null}
        </SurfaceBody>
      </Surface>
      {failed && !view ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="access-failed">
          <span>{t("accessLoadFailed")}</span><Button size="sm" variant="outline" onClick={() => void load()}>{t("reload")}</Button>
        </div>
      ) : null}
      {!view && !failed ? <p className="text-xs text-muted-foreground" data-testid="access-loading">{t("accessLoading")}</p> : null}
      {view ? <PmCard /> : null}
      {view ? (
        <div className={roleModeOff ? "min-w-0 space-y-4 opacity-60" : "min-w-0 space-y-4"} data-testid="access-roles" data-inactive={roleModeOff}>
          <AccessMatrix view={view} scope={scope} onPick={reveal} />
          {SECTIONS.map((section) => {
            const roles = section.roles.map((role) => known.get(role)).filter((role): role is RoleView => Boolean(role));
            if (!roles.length) return null;
            return (
              <section key={section.id} className="min-w-0 space-y-2" data-testid={`access-section-${section.id}`}>
                <h3 className="text-sm font-medium">{t(`accessGroup_${section.id}` as I18nKey)}</h3>
                <div className="min-w-0 space-y-2">
                  {roles.map((role) => (
                    <RoleCard key={role.role} role={role} view={view} scope={scope} below={below[role.role] ?? "role"} open={open.has(role.role)} busy={busy === role.role}
                      onToggle={() => toggle(role.role)} onSave={(r, v) => void save(r, v)} onReset={(r) => void reset(r)} />
                  ))}
                </div>
              </section>
            );
          })}
          <section className="min-w-0 space-y-1 text-xs text-muted-foreground" data-testid="access-providers">
            <h3 className="text-sm font-medium text-foreground">{t("accessProvidersTitle")}</h3>
            {providerLines(view.providers).map((line) => <p key={line} className="break-words">{line}</p>)}
            <p>{t("accessNarrowNote")}</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
