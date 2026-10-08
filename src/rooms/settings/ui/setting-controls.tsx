import { createContext, useContext, type ReactNode } from "react";
import { type CatalogRow } from "@lane-pilot/settings-catalog";
import { t, type Locale, type LocalePreference } from "@lane-pilot/i18n";
import { settingHelp, settingLabel, settingUsesNumericControl } from "../setting-copy";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Label } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { Skeleton } from "@lane-pilot/ui-kit";
import { HelpSup } from "@lane-pilot/ui-kit";
import { presentEnumLabel } from "../enum-labels";
import { usePanelLayout } from "@lane-pilot/ui-kit";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { HELP_BY_KEY, JEV_KEYS, ScreenPayload, asBoolean, numericUnit, reasonKey } from "../../ui-shell/ui/page-model";

export function SettingsGroup({ title, testId, help, children }: { title?: string; testId: string; help?: ReactNode; children: ReactNode }) {
  return (
    <Surface testId={testId}>
      {title || help ? <SurfaceHeader>
        {title ? <h2 className="text-sm font-medium">{title}</h2> : null}
        {help}
      </SurfaceHeader> : null}
      <SurfaceBody className="space-y-4">{children}</SurfaceBody>
    </Surface>
  );
}

/** Rows shown with «Advanced»; kept in the DOM while hidden. */
export function AdvancedRows({ show, testId, children }: { show: boolean; testId?: string; children: ReactNode }) {
  return <div hidden={!show} data-testid={testId} className="min-w-0 space-y-2 border-l-2 border-[var(--lp-hairline)] pl-3">{children}</div>;
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

export function CheckGroup({
  title,
  testId,
  toggle,
  help,
  children,
}: {
  title: string;
  testId: string;
  toggle?: ReactNode;
  help?: string;
  children: ReactNode;
}) {
  return (
    <Surface testId={testId}>
      <SurfaceHeader className="justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {toggle}
      </SurfaceHeader>
      <SurfaceBody>
        {help ? <p className="max-w-xl text-xs text-muted-foreground">{help}</p> : null}
        {children}
      </SurfaceBody>
    </Surface>
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
  const control = JEV_KEYS.has(row.storageKey) ? "switch" : row.control;
  const label = settingLabel(row);
  if (control === "switch") {
    const checked = asBoolean(value, JEV_KEYS.has(row.storageKey) ? true : false);
    return (
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(JEV_KEYS.has(row.storageKey) ? (next ? "1" : "0") : next)}
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
    const numeric = typeof value === "number" ? value : Number(value ?? row.min ?? 0);
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

export function inheritanceSummary(storageKey: string, locale: Locale, data: ScreenPayload | null): string {
  if (data?.explicitKeys?.includes(storageKey)) return t("inheritSetHere");
  if (data?.inheritedKeys?.includes(storageKey)) return t("inheritedFromGlobal");
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
  const effective = inherited ? row.defaultValue : value;
  const controlValue = inherited ? row.defaultValue : value;
  return (
    <div
      data-testid={`field-${row.id}`}
      data-storage-key={row.storageKey}
      data-ui-status={row.uiStatus}
      className={stackControls
        ? "grid min-h-11 min-w-0 gap-1 py-1"
        : "grid min-h-11 min-w-0 gap-1 py-1 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center"}
    >
      <div className="min-w-0">
        <div className="flex min-h-8 flex-wrap items-center gap-x-1">
          <span><Label className="text-sm">{settingLabel(row)}</Label><SettingHelp row={row} /></span>
          {inheritance ? (
            <span className="text-xs text-muted-foreground">
              {inheritanceSummary(row.storageKey, inheritance.locale, inheritance.data)}
            </span>
          ) : null}
          {inheritance?.data?.explicitKeys?.includes(row.storageKey) ? (
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={disabled} onClick={() => inheritance.reset([row.storageKey])}>
              {t("inheritResetShort")}
            </Button>
          ) : null}
        </div>
        {row.min !== null && row.max !== null ? (
          <p className="text-xs text-muted-foreground">{t("fieldLimits")} {row.min}–{row.max} {t(numericUnit(row))}</p>
        ) : null}
        {disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null}
      </div>
      <FieldControl row={row} value={controlValue} disabled={disabled} onChange={onChange} onDraft={onDraft} />
    </div>
  );
}

export function StatusBadge({ status }: { status: CatalogRow["uiStatus"] }) {
  if (status === "editable") return <Badge variant="secondary">{t("editableBadge")}</Badge>;
  if (status === "gap") return <Badge variant="destructive">{t("gapBadge")}</Badge>;
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
