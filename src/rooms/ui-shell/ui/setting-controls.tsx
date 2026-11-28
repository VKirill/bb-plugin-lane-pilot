import { createContext, useContext, type ReactNode } from "react";
import { GLOBAL_SETTINGS_PROJECT_ID, type CatalogRow } from "@lane-pilot/settings-catalog";
import { t, type Locale, type LocalePreference } from "@lane-pilot/i18n";
import { settingHelp, settingLabel, settingUsesNumericControl } from "./setting-copy";
import { Badge, Button, Disclosure, HelpSup, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, usePanelLayout } from "@lane-pilot/ui-kit";
import { presentEnumLabel } from "./enum-labels";
import { Pill } from "./pill";
import { HELP_BY_KEY, ScreenPayload, asBoolean, numericUnit, reasonKey } from "./page-kit";

export function SettingsGroup({
  title,
  testId,
  help,
  more,
  moreSummary,
  moreTestId,
  children,
}: {
  title?: string;
  testId: string;
  help?: ReactNode;
  more?: ReactNode;
  moreSummary?: ReactNode;
  moreTestId?: string;
  children: ReactNode;
}) {
  return (
    <section className="lp-sys-fields" data-testid={testId}>
      {title || help ? <div className="lp-sys-fields-head">
        {title ? <h2>{title}</h2> : null}
        {help}
      </div> : null}
      <div className="lp-sys-rows">{children}</div>
      {more ? (
        <div className="lp-sys-more">
          <Disclosure compact testId={moreTestId} summary={moreSummary ?? t("consoleSettingsMore")}>
            <div className="space-y-4 pt-1">{more}</div>
          </Disclosure>
        </div>
      ) : null}
    </section>
  );
}

/** One line of the Overview checklist: done, needs attention, or a plain step. */
export function StatusRow({ state, title, detail, action, testId }: { state: "ok" | "todo" | "info"; title: string; detail: ReactNode; action?: ReactNode; testId?: string }) {
  const mark = state === "ok" ? "✓" : state === "todo" ? "!" : "→";
  const tone = state === "ok" ? "lp-text-success" : state === "todo" ? "lp-text-warning" : "text-muted-foreground";
  return (
    <div className="flex min-w-0 items-start gap-3" data-testid={testId} data-state={state}>
      <span className={`lp-tile size-8 text-sm font-semibold ${tone}`} aria-hidden>{mark}</span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="break-words text-xs text-muted-foreground">{detail}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function FieldControl({
  row,
  value,
  disabled,
  options: optionOverride,
  onChange,
  onDraft,
}: {
  row: CatalogRow;
  value: unknown;
  disabled: boolean;
  options?: string[];
  onChange: (next: unknown) => void;
  onDraft?: (next: unknown) => void;
}) {
  const control = row.control;
  const label = settingLabel(row);
  if (control === "switch") {
    const checked = asBoolean(value, false);
    return (
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next)}
        aria-label={label}
      />
    );
  }
  if (control === "select") {
    const options = [...new Set(optionOverride ?? row.options)];
    if (options.length === 0) return <Input disabled value={String(value ?? "")} aria-label={label} />;
    const current = String(value ?? options[0] ?? "");
    const listed = options.includes(current) ? options : [...options, current];
    const selectedLabel = presentEnumLabel(row.storageKey, current);
    return (
      <Select value={current} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={`${label}: ${selectedLabel}`} className="min-w-0 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {listed.map((option) => (
            <SelectItem key={option} value={option}>{presentEnumLabel(row.storageKey, option)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (control === "slider" || control === "number" || settingUsesNumericControl(row)) {
    // An empty value (no limit, not set) stays empty: «0» would read as «zero attempts».
    const numeric = typeof value === "number" ? value : value === "" ? Number.NaN : Number(value ?? row.min ?? 0);
    const parsed = (raw: string) => raw === "" ? "" : Number(raw);
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Input
          type="number"
          disabled={disabled}
          min={row.min ?? undefined}
          max={row.max ?? undefined}
          step={1}
          value={Number.isFinite(numeric) ? numeric : ""}
          onChange={(event) => (onDraft ?? onChange)(parsed(event.target.value))}
          onBlur={(event) => onChange(parsed(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter") onChange(parsed((event.target as HTMLInputElement).value));
          }}
          aria-label={label}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{t(numericUnit(row))}</span>
      </div>
    );
  }
  return (
    <Input
      type="text"
      disabled={disabled}
      value={value == null ? "" : String(value)}
      onChange={(event) => (onDraft ?? onChange)(event.target.value)}
      onBlur={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onChange((event.target as HTMLInputElement).value);
      }}
      aria-label={label}
    />
  );
}

export function settingHelpText(row: CatalogRow): string {
  const mapped = HELP_BY_KEY[row.storageKey];
  return settingHelp(row, mapped ? t(mapped) : t("fieldHelpGeneric"));
}

export function SettingHelp({ row }: { row: CatalogRow }) {
  return (
    <HelpSup label={t("settingHelp")} testId={`help-${row.storageKey}`} contentTestId={`help-dialog-${row.storageKey}`}>
      <p>{settingHelpText(row)}</p>
    </HelpSup>
  );
}

export const InheritanceContext = createContext<{ locale: Locale; data: ScreenPayload | null; reset: (keys: string[]) => void } | null>(null);

export function inheritanceSummary(storageKey: string, _locale: Locale, data: ScreenPayload | null): string {
  if (data?.explicitKeys?.includes(storageKey)) return t("inheritSetHere");
  if (data?.inheritedKeys?.includes(storageKey)) {
    if (data.sectionId) return t("consoleSettingsInheritedFromProject");
    if (data.projectId && data.projectId !== GLOBAL_SETTINGS_PROJECT_ID) return t("consoleSettingsInheritedFromSystem");
    return t("inheritedFromGlobal");
  }
  return t("inheritDefaultShort");
}

export function SettingField({
  row,
  value,
  disabled,
  onChange,
  onDraft,
}: {
  row: CatalogRow;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
  onDraft?: (next: unknown) => void;
}) {
  const inheritance = useContext(InheritanceContext);
  const { stackControls } = usePanelLayout();
  const inherited = value == null || value === "";
  const controlValue = inherited ? row.defaultValue : value;
  const explicit = Boolean(inheritance?.data?.explicitKeys?.includes(row.storageKey));
  return (
    <div
      data-testid={`field-${row.id}`}
      data-storage-key={row.storageKey}
      data-ui-status={row.uiStatus}
      className={stackControls ? "lp-sys-field" : "lp-sys-field lp-sys-field-wide"}
    >
      <div className="min-w-0">
        <div className="flex min-h-8 flex-wrap items-center gap-x-1">
          <span><Label className="text-[13px] font-[550] text-[var(--lp-ink)]">{settingLabel(row)}</Label><SettingHelp row={row} /></span>
        </div>
        {row.min !== null && row.max !== null ? (
          <p className="text-xs text-muted-foreground">{t("fieldLimits")} {row.min}–{row.max} {t(numericUnit(row))}</p>
        ) : null}
        {disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null}
      </div>
      <FieldControl row={row} value={controlValue} disabled={disabled} onChange={onChange} onDraft={onDraft} />
      {inheritance ? (
        <div className="lp-sys-field-meta">
          <Pill tone={explicit ? "info" : "muted"}>{inheritanceSummary(row.storageKey, inheritance.locale, inheritance.data)}</Pill>
          {explicit ? (
            <button type="button" className="lp-sys-link" disabled={disabled} onClick={() => inheritance.reset([row.storageKey])}>
              {t("inheritResetShort")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: CatalogRow["uiStatus"] }) {
  if (status === "editable") return <Badge variant="secondary">{t("editableBadge")}</Badge>;
  return <Badge variant="outline">{t("readonlyBadge")}</Badge>;
}

export function LocaleControls({ preference, onChange }: { preference: LocalePreference; onChange: (next: LocalePreference) => void }) {
  return <div className="flex items-center gap-2" aria-label={t("language")}>
    <span className="text-xs text-muted-foreground">{t("language")}</span>
    <div className="lp-seg">
      {(["auto", "en", "ru"] as const).map((option) => (
        <Button key={option} variant="ghost" size="sm" className="lp-seg-item h-7 px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)] aria-pressed:hover:bg-[var(--lp-card)]" aria-pressed={preference === option} onClick={() => onChange(option)}>{option === "auto" ? t("automatic") : option.toUpperCase()}</Button>
      ))}
    </div>
  </div>;
}

export function OverviewLoading() {
  return <div data-testid="overview-loading" aria-busy="true" className="space-y-3">
    <p className="text-sm text-muted-foreground">{t("overviewLoading")}</p>
    <Skeleton className="h-28 w-full" />
    <Skeleton className="h-16 w-full" />
    <Skeleton className="h-16 w-full" />
  </div>;
}
