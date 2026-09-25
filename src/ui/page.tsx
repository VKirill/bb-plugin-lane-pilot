import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  experimental_Diff as Diff,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_SourceCode as SourceCode,
  experimental_useProviders as useProviders,
  useBbContext,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import {
  SECTION_ORDER,
  VISIBLE_CATALOG,
  type CatalogRow,
} from "../ui-catalog";
import { t, stateLabel, unappliedReason, validationMessage, setLocaleOverride, localeFromSources, detectLocale, detectLocaleHint, subscribeToLocaleHintChanges, type I18nKey, type Locale, type LocalePreference } from "../../i18n";
import { settingHelp, settingLabel, settingUnitKey, settingUsesNumericControl } from "../setting-copy";
import { agentPickerLabel } from "../agent-display";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Separator } from "../../components/ui/separator";
import { Icon } from "../../components/ui/icon";
import { EXTERNAL_OPS_BY_ACTION } from "../constants";
import { ATTEMPT_STATES, MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE, RUN_STATES } from "../state-machine";
import type { StageReceipt } from "../stages/contract";
import { QA_HOST_KEY, QA_WORKSPACE_KEY } from "../qa-host";
import { presentEnumLabel } from "../enum-labels";
import { OwnedSettings } from "./owned-settings";
import { userVisibleProjects } from "../project-scope";
import { inheritProjectValues, type LanePilotDefaults } from "../lp-defaults";

type ScreenPayload = {
  projectId: string;
  hostId: string | null;
  workspacePath: string | null;
  values: Record<string, unknown>;
  versions: Record<string, number>;
  explicitKeys: string[];
  importSource: { completed: boolean; at: number | null; routingPath: string | null; nightPath: string | null };
  runs: Array<{
    id: string;
    state: string;
    kind: string;
    created_at: number;
    updated_at: number;
    cliReceiptJson: string | null;
    stages?: StageReceipt[];
    attempts: Array<{
      id: string;
      state: string;
      attempt_no: number;
      thread_id: string | null;
      reason: string | null;
      task_id: string;
      cliReceiptJson: string | null;
    }>;
  }>;
  unapplied: Array<{ key: string; reason: string }>;
  cliPreview: { argv:string[]; env:Record<string, string>; applied:string[]; unapplied:Array<{ key:string; reason:string }> };
  lastSnapshotPath: string | null;
  lastReceiptJson: string | null;
  writerResultJson: string | null;
  writerResultPatch: string | null;
  cliReceiptJson: string | null;
  inheritedKeys?: string[];
  writerBinding?: {
    status: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable";
    hostId: string | null;
    path: string | null;
    source: "session" | "unique_source" | "explicit_override" | null;
    bindings: Array<{ id?: string; hostId: string; path: string; isDefault?: boolean }>;
  };
  qaHosts?: Array<{ id: string; name: string; status: string; connected: boolean }>;
  compiledMainAgent?: "supported" | "none";
  mainAgents?: Array<{ id: string; description: string }>;
  lastWriterTrace?: {
    providerId: string;
    model: string;
    requestedReasoningLevel: string;
    effectiveReasoningLevel: string;
    serviceTier: "default" | "fast" | null;
    fallbackReason: string | null;
    jevStatus: "ok" | "disabled" | "timeout" | "error";
    effortMode?: "automatic" | "manual";
    selectionSource?: {
      providerId: string;
      model: string;
      reasoningLevel: string;
      serviceTier: "default" | "fast" | null;
      reasoningLevelSource: "explicit" | "client-preference";
    };
  } | null;
};

type StackDetectResult = {
  hostId: string;
  laneStack: { present:boolean; version:string|null; sourceSha:string|null };
  openCode: { present:boolean; version:string|null };
  workspace: { path:string; present:boolean };
  targetSha: string;
  matchesTarget: boolean;
  scenario: "S1"|"S2"|"S3";
  coexistence?: {
    managers: Array<{
      manager: string; path: string; installed: boolean; configured: boolean; loaded: boolean | null;
      compatible: boolean | null; modified: boolean | null; version: string | null; sourceSha: string | null;
      sha256: string | null; owner: string; decision: string; missingCapabilities: string[];
      evidence: Array<{ kind: string; path: string | null; sha256: string | null; detail: string }>;
    }>;
  };
};

const JEV_KEYS = new Set(["jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV"]);
const COEXISTENCE_MANAGER_KEYS: Record<string, I18nKey> = {
  "agents-marker":"coexAgentsMarker", "managed-checkout":"coexManagedCheckout", "claude-cache":"coexClaudeCache",
  "claude-settings":"coexClaudeSettings", "opencode-config":"coexOpenCodeConfig", "opencode-plugin":"coexOpenCodePlugin",
};
const COEXISTENCE_VALUE_KEYS: Record<string, I18nKey> = {
  "lane-pilot":"coexOwnerLanePilot", user:"coexOwnerUser", upstream:"coexOwnerUpstream", unknown:"coexOwnerUnknown",
  reuse:"coexDecisionReuse", install:"coexDecisionInstall", upgrade:"coexDecisionUpgrade", conflict:"coexDecisionConflict",
  skip:"coexDecisionSkip", "disconnect-owned":"coexDecisionDisconnectOwned",
};
const WRITER_PROVIDER = "writer.provider";
const WRITER_MODEL = "writer.model";
const WRITER_EFFORT = "writer.reasoning_effort";
const WRITER_SERVICE_TIER = "writer.service_tier";
const MEMORY_PROVIDER = "memory.provider";
const MEMORY_MODEL = "memory.model";
const MEMORY_EFFORT = "memory.reasoning_effort";
const MEMORY_SERVICE_TIER = "memory.service_tier";
const NIGHT_PROVIDER = "night_review.provider";
const NIGHT_MODEL = "night_review.model";
const NIGHT_EFFORT = "night_review.reasoning_effort";
const NIGHT_SERVICE_TIER = "night_review.service_tier";
const DOCS_PROVIDER = "docs.provider";
const DOCS_MODEL = "docs.model";
const DOCS_EFFORT = "docs.reasoning_effort";
const DOCS_SERVICE_TIER = "docs.service_tier";
const ONBOARDING_PROVIDER = "onboarding.provider";
const ONBOARDING_MODEL = "onboarding.model";
const ONBOARDING_EFFORT = "onboarding.reasoning_effort";
const ONBOARDING_SERVICE_TIER = "onboarding.service_tier";
const PM_READ_PROVIDER = "pm_read.provider";
const PM_READ_MODEL = "pm_read.model";
const PM_READ_EFFORT = "pm_read.reasoning_effort";
const PM_READ_SERVICE_TIER = "pm_read.service_tier";
const PLAN_CRITIQUE_PROVIDER = "plan_critique.provider";
const PLAN_CRITIQUE_MODEL = "plan_critique.model";
const PLAN_CRITIQUE_EFFORT = "plan_critique.reasoning_effort";
const PLAN_CRITIQUE_SERVICE_TIER = "plan_critique.service_tier";
const CODE_CRITIQUE_PROVIDER = "code_critique.provider";
const CODE_CRITIQUE_MODEL = "code_critique.model";
const CODE_CRITIQUE_EFFORT = "code_critique.reasoning_effort";
const CODE_CRITIQUE_SERVICE_TIER = "code_critique.service_tier";

function fieldKey(id: string): I18nKey {
  return `field_${id}` as I18nKey;
}
function reasonKey(id: string): I18nKey {
  return `reason_${id}` as I18nKey;
}
function sectionKey(section: string): I18nKey {
  return `section_${section}` as I18nKey;
}

function stageTitle(stageId: string): string {
  const labels: Record<string, I18nKey> = {
    "plan-critique":"stagePlanCritique",
    "code-critique":"stageCodeCritique",
    "writer-agent":"stageWriterAgent",
    verification:"stageVerification",
    "acceptance-receipt":"stageAcceptanceReceipt",
    "browser-qa":"stageBrowserQa",
    "night-review":"stageNightReview",
    "workspace-status":"stageWorkspaceStatus",
    "opencode-telemetry":"stageOpenCodeTelemetry",
    "pm-read":"stagePmRead",
  };
  const key = labels[stageId];
  return key ? t(key) : stageId;
}

const PICKER_KEYS = new Set([
  WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER,
  MEMORY_PROVIDER, MEMORY_MODEL, MEMORY_EFFORT, MEMORY_SERVICE_TIER,
  NIGHT_PROVIDER, NIGHT_MODEL, NIGHT_EFFORT, NIGHT_SERVICE_TIER,
  DOCS_PROVIDER, DOCS_MODEL, DOCS_EFFORT, DOCS_SERVICE_TIER,
  ONBOARDING_PROVIDER, ONBOARDING_MODEL, ONBOARDING_EFFORT, ONBOARDING_SERVICE_TIER,
  PM_READ_PROVIDER, PM_READ_MODEL, PM_READ_EFFORT, PM_READ_SERVICE_TIER,
  PLAN_CRITIQUE_PROVIDER, PLAN_CRITIQUE_MODEL, PLAN_CRITIQUE_EFFORT, PLAN_CRITIQUE_SERVICE_TIER,
  CODE_CRITIQUE_PROVIDER, CODE_CRITIQUE_MODEL, CODE_CRITIQUE_EFFORT, CODE_CRITIQUE_SERVICE_TIER,
]);
const DEDICATED_KEYS = new Set([
  "night_review.enabled", "night_review.auto_merge", "night_review.max_fix_tasks",
  "pm_read.enabled", "pm_read.min_lines",
  "docs.enabled", "docs.maintain", "docs.page_cap", "docs.since", "docs.hour",
  "helper.placement", "helper.context_mode", "helper.skills", "helper.mcp_servers", "helper.bb_plugins", "helper.native_plugins",
  "plan_critique.enabled", "plan_critique.mode",
  "plan_critique.min_score", "plan_critique.min_write_tasks", "plan_critique.on_high_risk",
  "code_critique.enabled", "code_critique.mode",
  "code_critique.auto_fix", "code_critique.max_rounds",
]);
const SECTIONED_SETTING_KEYS = new Set([
  "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.search_engine",
  "memory.personal_bot", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
  "specialist.enabled", "specialist.when", "specialist.provider", "specialist.model", "specialist.reasoning_effort",
  "onboarding.depth", "ops.max_tasks", "adoc.040", "adoc.041", "adoc.042", "sandbox.backend",
  "browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
]);
const BASIC_SETTING_KEYS = new Set([
  "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
]);
const HELP_BY_KEY: Record<string, I18nKey> = {
  "pm_read.enabled": "largeFileReadHelp",
  "pm_read.min_lines": "largeFileThresholdHelp",
  "docs.maintain": "docsMaintainHelp",
  "docs.page_cap": "docsPageCap",
  "docs.since": "docsSince",
  "docs.hour": "docsHour",
  "adoc.040": "workspaceModeHelp",
  "adoc.041": "workspaceModeHelp",
  "adoc.042": "workspaceModeHelp",
  "browser_qa.enabled": "browserQaApproveHelp",
  "browser_qa.approve": "browserQaApproveHelp",
  "browser_qa.provider": "browserQaProviderLimit",
  "browser_qa.model": "browserQaProviderLimit",
  "browser_qa.backend": "browserQaProviderLimit",
  "browser_qa.reasoning_effort": "browserQaProviderLimit",
  "writer.agent": "writerAgentHelp",
  "helper.placement": "helperPlacementHelp",
  "plan_critique.enabled": "planCritiqueHelp",
  "plan_critique.mode": "planCritiqueHelp",
  "code_critique.enabled": "codeCritiqueHelp",
  "code_critique.mode": "codeCritiqueHelp",
  "code_critique.auto_fix": "codeCritiqueHelp",
  "code_critique.max_rounds": "codeCritiqueHelp",
  "helper.context_mode": "helperContextHelp",
  "helper.skills": "emptyAllowlist",
  "helper.mcp_servers": "emptyAllowlist",
  "helper.bb_plugins": "emptyAllowlist",
  "helper.native_plugins": "emptyAllowlist",
};

function uniqueByStorage(rows: CatalogRow[]): CatalogRow[] {
  const rank: Record<CatalogRow["uiStatus"], number> = { editable: 3, readonly: 2, gap: 1, excluded: 0 };
  const byKey = new Map<string, CatalogRow>();
  for (const row of rows) {
    const current = byKey.get(row.storageKey);
    if (!current || rank[row.uiStatus] > rank[current.uiStatus]) byKey.set(row.storageKey, row);
  }
  return [...byKey.values()];
}

function isCompatibilityAlias(row: CatalogRow): boolean {
  return row.storageKey.startsWith("adoc.") && row.channel === "NONE";
}

function diagnosticRows(): CatalogRow[] {
  const settingsKeys = new Set(extraSettingRows().map((row) => row.storageKey));
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => {
    if (row.storageKey === "writer.agent") return false;
    if (row.storageKey.endsWith(".agent")) return true;
    if (row.section === "jev" || JEV_KEYS.has(row.storageKey)) return false;
    if (PICKER_KEYS.has(row.storageKey) && row.storageKey !== "writer.fast_mode") return false;
    if (DEDICATED_KEYS.has(row.storageKey)) return false;
    if (SECTIONED_SETTING_KEYS.has(row.storageKey)) return false;
    if (settingsKeys.has(row.storageKey)) return false;
    if (isCompatibilityAlias(row)) return false;
    return true;
  }));
}

function compatibilityAliasRows(): CatalogRow[] {
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => isCompatibilityAlias(row)));
}

function isDiagnosticOnlySetting(row: CatalogRow): boolean {
  return row.storageKey.startsWith("install.")
    || row.storageKey === "ui.language"
    || (row.storageKey.startsWith("ops.") && row.storageKey !== "ops.max_tasks")
    || row.storageKey === "run.gate";
}

function extraSettingRows(): CatalogRow[] {
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => (
    row.uiStatus === "editable"
    && !JEV_KEYS.has(row.storageKey)
    && !PICKER_KEYS.has(row.storageKey)
    && !DEDICATED_KEYS.has(row.storageKey)
    && !row.storageKey.endsWith(".agent")
    && !SECTIONED_SETTING_KEYS.has(row.storageKey)
    && !isDiagnosticOnlySetting(row)
  )));
}

function numericUnit(row: CatalogRow): I18nKey {
  return settingUnitKey(row) ?? (row.storageKey.includes("score") ? "fieldUnitScore" : "fieldUnitTasks");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "on" || value === "true") return true;
  if (value === "0" || value === "off" || value === "false" || value === "no") return false;
  return fallback;
}

function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={label}>
          <Icon name="CircleQuestion" className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-w-sm text-xs text-muted-foreground">{children}</PopoverContent>
    </Popover>
  );
}

function SettingsGroup({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h2 className="text-sm font-medium">{title}</h2>
      <Separator />
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function FieldControl({
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
        <SelectTrigger aria-label={`${label}: ${selectedLabel}`}>
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

function settingHelpText(row: CatalogRow): string {
  const mapped = HELP_BY_KEY[row.storageKey];
  return settingHelp(row, mapped ? t(mapped) : t("fieldHelpGeneric"));
}

function SettingHelp({ row }: { row: CatalogRow }) {
  const title = settingLabel(row);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("settingHelp")}
          data-testid={`help-${row.storageKey}`}
        >?</Button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid={`help-dialog-${row.storageKey}`} aria-label={title}>
        <p className="text-sm text-foreground">{settingHelpText(row)}</p>
      </PopoverContent>
    </Popover>
  );
}

const InheritanceContext = createContext<{ locale: Locale; data: ScreenPayload | null; reset: (keys: string[]) => void } | null>(null);

function inheritanceSummary(storageKey: string, locale: Locale, data: ScreenPayload | null): string {
  if (data?.explicitKeys?.includes(storageKey)) return locale === "ru" ? "Задано в этом проекте" : "Set on this project";
  if (data?.inheritedKeys?.includes(storageKey)) return t("inheritedFromGlobal");
  return t("inheritDefaultShort");
}

function SettingField({
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
  const inherited = value == null || value === "";
  const effective = inherited ? row.defaultValue : value;
  const controlValue = inherited ? row.defaultValue : value;
  return (
    <div
      data-testid={`field-${row.id}`}
      data-storage-key={row.storageKey}
      data-ui-status={row.uiStatus}
      className="grid min-h-12 gap-1 border-b border-border py-1.5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center"
    >
      <div className="min-w-0">
        <div className="flex min-h-8 items-center gap-1">
          <Label className="text-sm">{settingLabel(row)}</Label>
          <SettingHelp row={row} />
          {inheritance ? (
            <span className="truncate text-xs text-muted-foreground">
              {inheritanceSummary(row.storageKey, inheritance.locale, inheritance.data)}
            </span>
          ) : null}
          {inheritance?.data?.explicitKeys?.includes(row.storageKey) ? (
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={disabled} onClick={() => inheritance.reset([row.storageKey])}>
              {inheritance.locale === "ru" ? "Наследовать" : "Reset to inherited"}
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

function StatusBadge({ status }: { status: CatalogRow["uiStatus"] }) {
  if (status === "editable") return <Badge variant="secondary">{t("editableBadge")}</Badge>;
  if (status === "gap") return <Badge variant="destructive">{t("gapBadge")}</Badge>;
  return <Badge variant="outline">{t("readonlyBadge")}</Badge>;
}

function LocaleControls({ preference, onChange }: { preference: LocalePreference; onChange: (next: LocalePreference) => void }) {
  return <div className="flex items-center gap-1" aria-label={t("language")}>
    <span className="mr-1 text-xs text-muted-foreground">{t("language")}</span>
    <Button size="sm" variant={preference === "auto" ? "default" : "outline"} aria-pressed={preference === "auto"} onClick={() => onChange("auto")}>{t("automatic")}</Button>
    <Button size="sm" variant={preference === "en" ? "default" : "outline"} aria-pressed={preference === "en"} onClick={() => onChange("en")}>EN</Button>
    <Button size="sm" variant={preference === "ru" ? "default" : "outline"} aria-pressed={preference === "ru"} onClick={() => onChange("ru")}>RU</Button>
  </div>;
}

function runTone(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "accepted" || state === "passed") return "default";
  if (state === "failed" || state === "blocked" || state === "provider_error" || state === "validation_failed") return "destructive";
  if (state === "running" || state === "pending") return "secondary";
  return "outline";
}

type MonitorRun = ScreenPayload["runs"][number];
type MonitorAttempt = MonitorRun["attempts"][number];

function canCancelAttempt(run: MonitorRun, attempt: MonitorAttempt): boolean {
  return (run.state === "pending" || run.state === "running")
    && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state)
    && (attempt.state === "queued" || Boolean(attempt.thread_id));
}

function canRetryAttempt(run: MonitorRun, attempt: MonitorAttempt): boolean {
  return (run.state === "pending" || run.state === "running")
    && RETRY_ELIGIBLE.some((state) => state === attempt.state)
    && run.attempts.filter((item) => item.task_id === attempt.task_id).length < MAIN_ATTEMPT_LIMIT;
}

export function LanePilotPage({ subPath = "", scope = "projects" }: { subPath?: string; scope?: "projects" | "globals" | "agents" }) {
  const [activeScope, setActiveScope] = useState(scope);
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId, threadId: routeThreadId } = useBbContext();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projectId = selectedProjectId ?? routeProjectId ?? (subPath || null);
  const [projects, setProjects] = useState<Array<{ id:string; name:string; kind?:string }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectListError, setProjectListError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const providers = useProviders();
  const [tab, setTab] = useState("settings");
  const [data, setData] = useState<ScreenPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ kind: "cas" } | { kind: "validation"; code: "invalid_choice" | "incompatible_setting" | "setup_required" | "writer_binding_ambiguous" | "writer_host_offline" | "catalog_unavailable"; params: string[] } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingOp, setPendingOp] = useState<"install" | "connect" | "rollback" | null>(null);
  const [snapshotPath, setSnapshotPath] = useState("");
  const [detectResult, setDetectResult] = useState<StackDetectResult | null>(null);
  const [resultPatch, setResultPatch] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [localePreference, setLocalePreference] = useState<LocalePreference>("auto");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsDepth, setSettingsDepth] = useState<"basic" | "advanced">("basic");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const dataRef = useRef<ScreenPayload | null>(null);
  const draftsRef = useRef<Record<string, unknown>>({});
  const saveTailRef = useRef<Record<string, Promise<unknown>>>({});
  const writerDraftRef = useRef<ExperimentalProviderModelPickerValue | null>(null);
  const [writerDraft, setWriterDraft] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [selectedBinding, setSelectedBinding] = useState<{ hostId: string; path: string } | null>(null);
  const writerSaveTail = useRef(Promise.resolve());
  const projectCache = useRef(new Map<string, { data: ScreenPayload; drafts: Record<string, unknown>; writer: ExperimentalProviderModelPickerValue | null }>());
  const loadGeneration = useRef(0);


  useEffect(() => {
    let current = true;
    void rpc.call("list_projects", {}).then((result) => {
      if (current) {
        setProjects(userVisibleProjects(result.projects));
        setProjectsLoaded(true);
        if (!routeProjectId && !subPath) {
          const visible = userVisibleProjects(result.projects);
          const preferred = visible.find((project) => project.id === result.lastProjectId)?.id ?? visible[0]?.id ?? null;
          if (preferred) setSelectedProjectId((current) => current ?? preferred);
        }
      }
    }).catch(() => { if (current) setProjectListError(true); });
    return () => { current = false; };
  }, [routeProjectId, subPath, rpc]);

  useEffect(() => {
    let current = true;
    const suggestedLocale = detectLocaleHint();
    void rpc.call("get_preferences", { suggestedLocale }).then((result) => {
      if (!current) return;
      setLocalePreference(result.preference);
      setLocaleOverride(result.preference === "auto" ? null : result.preference);
      setLocale(result.locale);
    });
    const onLocale = (event: Event) => {
      const next = (event as CustomEvent<Locale>).detail;
      if (next === "en" || next === "ru") { setLocaleOverride(next); setLocale(next); }
    };
    globalThis.addEventListener?.("lane-pilot-locale", onLocale);
    return () => { current = false; globalThis.removeEventListener?.("lane-pilot-locale", onLocale); };
  }, [rpc]);

  useEffect(() => {
    if (localePreference !== "auto") return;
    return subscribeToLocaleHintChanges((next) => {
      setLocaleOverride(null);
      setLocale(next);
      globalThis.dispatchEvent?.(new CustomEvent("lane-pilot-locale", { detail: next }));
    });
  }, [localePreference]);

  const chooseLocale = async (next: LocalePreference) => {
    const suggestedLocale = detectLocaleHint();
    const resolved = next === "auto" ? suggestedLocale : next;
    setLocalePreference(next);
    setLocaleOverride(next === "auto" ? null : next);
    setLocale(resolved);
    globalThis.dispatchEvent?.(new CustomEvent("lane-pilot-locale", { detail: resolved }));
    await rpc.call("set_locale", { locale: next, suggestedLocale });
  };

  dataRef.current = data;
  draftsRef.current = drafts;

  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++loadGeneration.current;
    const cached = projectCache.current.get(projectId);
    if (cached) { setData(cached.data); dataRef.current = cached.data; setDrafts(cached.drafts); draftsRef.current = cached.drafts; setWriterDraft(cached.writer); writerDraftRef.current = cached.writer; return; }
    setError(null);
    setData(null);
    draftsRef.current = {};
    setDrafts({});
    writerDraftRef.current = null;
    setWriterDraft(null);
    try {
      const next = await rpc.call("get_screen", { projectId }) as ScreenPayload;
      if (generation !== loadGeneration.current) return;
      setData(next);
      if (next.lastSnapshotPath) setSnapshotPath(next.lastSnapshotPath);
      setResultSource(next.writerResultJson);
      setResultPatch(next.writerResultPatch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId, rpc]);

  useEffect(() => { void load(); }, [load]);

  const diagnosticsGrouped = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const section of SECTION_ORDER) map.set(section, []);
    for (const row of diagnosticRows()) {
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return SECTION_ORDER.filter((section) => (map.get(section) ?? []).length > 0)
      .map((section) => ({ section, rows: map.get(section) ?? [] }));
  }, []);

  const extrasGrouped = useMemo(() => {
    const query = settingsQuery.trim().toLowerCase();
    const map = new Map<string, CatalogRow[]>();
    for (const section of SECTION_ORDER) map.set(section, []);
    for (const row of extraSettingRows()) {
      if (!query && settingsDepth === "basic" && !BASIC_SETTING_KEYS.has(row.storageKey)) continue;
      if (query) {
        const haystack = [settingLabel(row), t(sectionKey(row.section)), row.storageKey].join(" ").toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return SECTION_ORDER.filter((section) => (map.get(section) ?? []).length > 0)
      .map((section) => ({ section, rows: map.get(section) ?? [] }));
  }, [settingsQuery, settingsDepth, locale]);

  const cardVisible = (...keys: I18nKey[]) => {
    const query = settingsQuery.trim().toLowerCase();
    if (!query) return true;
    return keys.some((key) => t(key).toLowerCase().includes(query));
  };

  const chooseProject = (next: string) => {
    if (dataRef.current) projectCache.current.set(dataRef.current.projectId, { data: dataRef.current, drafts: { ...draftsRef.current }, writer: writerDraftRef.current });
    setActiveScope("projects");
    setSelectedProjectId(next);
    setProjectListError(false);
    void rpc.call("remember_project", { projectId: next }).catch(() => setProjectListError(true));
  };

  const writeDraft = (key: string, value: unknown) => {
    draftsRef.current = { ...draftsRef.current, [key]: value };
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  const save = async (row: CatalogRow, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const expectedVersion = snapshot.versions[row.storageKey] ?? 0;
    const result = await rpc.call("save_setting", {
      projectId,
      key: row.storageKey,
      value,
      expectedVersion,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [row.storageKey]: result.value },
          versions: { ...current.versions, [row.storageKey]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [row.storageKey]: result.value },
        versions: { ...current.versions, [row.storageKey]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, row.storageKey])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const saveKey = async (key: string, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_setting", {
      projectId, key, value, expectedVersion: snapshot.versions[key] ?? 0,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [key]: result.value },
          versions: { ...current.versions, [key]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [key]: result.value },
        versions: { ...current.versions, [key]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, key])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const applySetting = async (row: CatalogRow, value: unknown) => {
    writeDraft(row.storageKey, value);
    const key = row.storageKey;
    const queued = (saveTailRef.current[key] ?? Promise.resolve()).then(async () => {
      const latest = draftsRef.current[key];
      if (latest === undefined) return true;
      const ok = await save(row, latest);
      if (ok && Object.is(draftsRef.current[key], latest)) {
        const next = { ...draftsRef.current };
        delete next[key];
        draftsRef.current = next;
        setDrafts((current) => {
          if (!Object.is(current[key], latest)) return current;
          const copy = { ...current };
          delete copy[key];
          return copy;
        });
      }
      return ok;
    });
    saveTailRef.current[key] = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const resetInherited = async (keys: string[]) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot || snapshot.projectId !== projectId) return;
    try {
      const result = await rpc.call("reset_project_settings", { projectId, keys, expectedVersions: Object.fromEntries(keys.map((key) => [key, snapshot.versions[key] ?? 0])) });
      if (dataRef.current?.projectId !== projectId) return;
      if (!result.ok) { setSaveError(result.validation ? { kind: "validation", code: result.validation.code, params: result.validation.params } : { kind: "cas" }); return; }
      const next = await rpc.call("get_screen", { projectId }) as ScreenPayload;
      if (dataRef.current?.projectId !== projectId) return;
      setData(next); dataRef.current = next;
      const remaining = { ...draftsRef.current }; for (const key of keys) delete remaining[key];
      setDrafts(remaining); draftsRef.current = remaining;
      if (keys.includes(WRITER_PROVIDER)) { setWriterDraft(null); writerDraftRef.current = null; }
      setSaveError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const displayedValue = (key: string) => (
    Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : data?.values[key]
  );

  const persistWriterSelection = async (selection: ExperimentalProviderModelPickerValue) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_writer_selection", {
      projectId,
      threadId: routeThreadId ?? null,
      ...(selectedBinding ? { selectedBinding } : {}),
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel,
      serviceTier: selection.serviceTier ?? null,
      expectedVersions: {
        "writer.provider": snapshot.versions[WRITER_PROVIDER] ?? 0,
        "writer.model": snapshot.versions[WRITER_MODEL] ?? 0,
        "writer.reasoning_effort": snapshot.versions[WRITER_EFFORT] ?? 0,
        "writer.service_tier": snapshot.versions[WRITER_SERVICE_TIER] ?? 0,
      },
    });
    const applyScreen = (values: Record<string, unknown>, versions: Record<string, number>, markExplicit = false) => {
      const current = dataRef.current;
      if (!current) return;
      const next = {
        ...current,
        values: { ...current.values, ...values },
        versions: { ...current.versions, ...versions },
        explicitKeys: markExplicit
          ? [...new Set([...current.explicitKeys, WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER])]
          : current.explicitKeys,
      };
      dataRef.current = next;
      setData(next);
    };
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      applyScreen(result.values, result.versions);
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    applyScreen(result.values, result.versions, true);
    return true;
  };

  const saveWriterSelection = (selection: ExperimentalProviderModelPickerValue) => {
    writerDraftRef.current = selection;
    setWriterDraft(selection);
    writerSaveTail.current = writerSaveTail.current
      .catch(() => undefined)
      .then(async () => {
        const latest = writerDraftRef.current;
        if (!latest) return;
        const ok = await persistWriterSelection(latest);
        if (ok && writerDraftRef.current === latest) {
          writerDraftRef.current = null;
          setWriterDraft(null);
        }
      })
      .then(() => undefined, () => undefined);
  };

  const saveMemorySelection = async (selection: ExperimentalProviderModelPickerValue) => {
    if (!projectId || !data) return false;
    const result = await rpc.call("save_memory_selection", {
      projectId, providerId:selection.providerId, model:selection.model,
      reasoningLevel:selection.reasoningLevel, serviceTier:selection.serviceTier ?? null,
      expectedVersions:{
        "memory.provider":data.versions[MEMORY_PROVIDER] ?? 0,
        "memory.model":data.versions[MEMORY_MODEL] ?? 0,
        "memory.reasoning_effort":data.versions[MEMORY_EFFORT] ?? 0,
        "memory.service_tier":data.versions[MEMORY_SERVICE_TIER] ?? 0,
      },
    });
    if (result.conflict) { setSaveError({kind:"cas"}); await load(); return false; }
    if (!result.ok) {
      if (result.validation) setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});
      else setSaveError({kind:"cas"});
      return false;
    }
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const saveNightReviewSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_night_review_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[NIGHT_PROVIDER]:data.versions[NIGHT_PROVIDER]??0,[NIGHT_MODEL]:data.versions[NIGHT_MODEL]??0,[NIGHT_EFFORT]:data.versions[NIGHT_EFFORT]??0,[NIGHT_SERVICE_TIER]:data.versions[NIGHT_SERVICE_TIER]??0},
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const saveDocsSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_docs_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[DOCS_PROVIDER]:data.versions[DOCS_PROVIDER]??0,[DOCS_MODEL]:data.versions[DOCS_MODEL]??0,[DOCS_EFFORT]:data.versions[DOCS_EFFORT]??0,[DOCS_SERVICE_TIER]:data.versions[DOCS_SERVICE_TIER]??0},
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const savePmReadSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_pm_read_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[PM_READ_PROVIDER]:data.versions[PM_READ_PROVIDER]??0,[PM_READ_MODEL]:data.versions[PM_READ_MODEL]??0,[PM_READ_EFFORT]:data.versions[PM_READ_EFFORT]??0,[PM_READ_SERVICE_TIER]:data.versions[PM_READ_SERVICE_TIER]??0},
    });
    if(result.conflict){
      setSaveError({kind:"cas"});
      setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
      return false;
    }
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const saveOnboardingSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_onboarding_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[ONBOARDING_PROVIDER]:data.versions[ONBOARDING_PROVIDER]??0,[ONBOARDING_MODEL]:data.versions[ONBOARDING_MODEL]??0,[ONBOARDING_EFFORT]:data.versions[ONBOARDING_EFFORT]??0,[ONBOARDING_SERVICE_TIER]:data.versions[ONBOARDING_SERVICE_TIER]??0},
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const savePlanCritiqueSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_plan_critique_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[PLAN_CRITIQUE_PROVIDER]:data.versions[PLAN_CRITIQUE_PROVIDER]??0,[PLAN_CRITIQUE_MODEL]:data.versions[PLAN_CRITIQUE_MODEL]??0,[PLAN_CRITIQUE_EFFORT]:data.versions[PLAN_CRITIQUE_EFFORT]??0,[PLAN_CRITIQUE_SERVICE_TIER]:data.versions[PLAN_CRITIQUE_SERVICE_TIER]??0},
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const saveCodeCritiqueSelection = async (selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const result=await rpc.call("save_code_critique_selection",{
      projectId,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,serviceTier:selection.serviceTier??null,
      expectedVersions:{[CODE_CRITIQUE_PROVIDER]:data.versions[CODE_CRITIQUE_PROVIDER]??0,[CODE_CRITIQUE_MODEL]:data.versions[CODE_CRITIQUE_MODEL]??0,[CODE_CRITIQUE_EFFORT]:data.versions[CODE_CRITIQUE_EFFORT]??0,[CODE_CRITIQUE_SERVICE_TIER]:data.versions[CODE_CRITIQUE_SERVICE_TIER]??0},
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };

  const savedPickerValue: ExperimentalProviderModelPickerValue = {
    providerId: String(data?.values[WRITER_PROVIDER] ?? ""),
    model: String(data?.values[WRITER_MODEL] ?? ""),
    reasoningLevel: (String(data?.values[WRITER_EFFORT] ?? "none") || "none") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider) => provider.id === String(data?.values[WRITER_PROVIDER] ?? ""))?.serviceTiers?.length
      ? { serviceTier: data?.values[WRITER_SERVICE_TIER] === "fast" ? "fast" : "default" }
      : {}),
  };
  const pickerValue = writerDraft ?? savedPickerValue;

  const memoryProviderId=String(data?.values[MEMORY_PROVIDER] ?? data?.values[WRITER_PROVIDER] ?? "");
  const memoryPickerValue:ExperimentalProviderModelPickerValue={
    providerId:memoryProviderId,
    model:String(data?.values[MEMORY_MODEL] ?? data?.values[WRITER_MODEL] ?? ""),
    reasoningLevel:(String(data?.values[MEMORY_EFFORT] ?? data?.values[WRITER_EFFORT] ?? "none")||"none") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===memoryProviderId)?.serviceTiers?.length
      ? {serviceTier:data?.values[MEMORY_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const nightProviderId=String(data?.values[NIGHT_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const nightPickerValue:ExperimentalProviderModelPickerValue={
    providerId:nightProviderId,
    model:String(data?.values[NIGHT_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[NIGHT_EFFORT]??"high")||"high") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===nightProviderId)?.serviceTiers?.length?{serviceTier:data?.values[NIGHT_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const docsProviderId=String(data?.values[DOCS_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const docsPickerValue:ExperimentalProviderModelPickerValue={
    providerId:docsProviderId,
    model:String(data?.values[DOCS_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[DOCS_EFFORT]??data?.values[WRITER_EFFORT]??"medium")||"medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===docsProviderId)?.serviceTiers?.length?{serviceTier:data?.values[DOCS_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const onboardingProviderId=String(data?.values[ONBOARDING_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const onboardingPickerValue:ExperimentalProviderModelPickerValue={
    providerId:onboardingProviderId,
    model:String(data?.values[ONBOARDING_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[ONBOARDING_EFFORT]??"medium")||"medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===onboardingProviderId)?.serviceTiers?.length?{serviceTier:data?.values[ONBOARDING_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const pmReadProviderId=String(data?.values[PM_READ_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const pmReadPickerValue:ExperimentalProviderModelPickerValue={
    providerId:pmReadProviderId,
    model:String(data?.values[PM_READ_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[PM_READ_EFFORT]??"low")||"low") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===pmReadProviderId)?.serviceTiers?.length?{serviceTier:data?.values[PM_READ_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const planCritiqueProviderId=String(data?.values[PLAN_CRITIQUE_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const planCritiquePickerValue:ExperimentalProviderModelPickerValue={
    providerId:planCritiqueProviderId,
    model:String(data?.values[PLAN_CRITIQUE_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[PLAN_CRITIQUE_EFFORT]??data?.values[WRITER_EFFORT]??"medium")||"medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===planCritiqueProviderId)?.serviceTiers?.length?{serviceTier:data?.values[PLAN_CRITIQUE_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };
  const codeCritiqueProviderId=String(data?.values[CODE_CRITIQUE_PROVIDER]??data?.values[WRITER_PROVIDER]??"");
  const codeCritiquePickerValue:ExperimentalProviderModelPickerValue={
    providerId:codeCritiqueProviderId,
    model:String(data?.values[CODE_CRITIQUE_MODEL]??data?.values[WRITER_MODEL]??""),
    reasoningLevel:(String(data?.values[CODE_CRITIQUE_EFFORT]??data?.values[WRITER_EFFORT]??"medium")||"medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider)=>provider.id===codeCritiqueProviderId)?.serviceTiers?.length?{serviceTier:data?.values[CODE_CRITIQUE_SERVICE_TIER]==="fast"?"fast":"default"}:{}),
  };

  const catalogRow = (key: string) => VISIBLE_CATALOG.find((item) => item.storageKey === key);

  const hostId = data?.hostId;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  const modelPicker = (value: ExperimentalProviderModelPickerValue, onChange: (next: ExperimentalProviderModelPickerValue) => void) => (
    value.providerId || (providers.providers?.length ?? 0) > 0
      ? <ProviderModelPicker value={value.providerId ? value : { providerId: providers.providers?.[0]?.id ?? "none", model: "", reasoningLevel: "none" }} routing={routing} onChange={onChange} />
      : <p className="text-sm text-muted-foreground">{providers.status === "loading" ? t("writerCatalogLoading") : t("writerCatalogUnavailable")}</p>
  );
  const inheritReset = (keys: string[]) => (
    <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={!keys.some((key) => data?.explicitKeys.includes(key))} onClick={() => void resetInherited(keys)}>{t("inheritChoice")}</Button>
  );

  const runStack = async (op: "detect" | "install" | "connect" | "rollback", confirm = false) => {
    if (!projectId) return;
    try {
      if (op === "detect") setDetectResult(await rpc.call("stack_detect", { projectId }) as StackDetectResult);
      if (op === "install") await rpc.call("stack_install", { projectId, confirmExternalOps: confirm });
      if (op === "connect") await rpc.call("stack_connect", { projectId, confirmExternalOps: confirm });
      if (op === "rollback") await rpc.call("stack_rollback", { projectId, ...(snapshotPath || data?.lastSnapshotPath ? { snapshotPath:snapshotPath || data?.lastSnapshotPath || undefined } : {}) });
      toast.success(<span data-bb-ru-skip>{t("toastOk")}</span>);
      await load();
    } catch (cause) {
      toast.error(<span data-bb-ru-skip>{cause instanceof Error ? cause.message : t("toastError")}</span>);
    }
  };

  const finishRuns = async (runId: string) => {
    if (!projectId || finishing) return;
    setFinishing(true);
    try {
      const result = await rpc.call("finish_run", { projectId, runId });
      if (!result.closed) toast.error(<span data-bb-ru-skip>{t("finishRunBlocked")}</span>);
      else toast.success(<span data-bb-ru-skip>{t("runClosed")}</span>);
      await load();
    } catch (cause) {
      toast.error(<span data-bb-ru-skip>{cause instanceof Error ? cause.message : t("toastError")}</span>);
    } finally { setFinishing(false); }
  };

  const jevRows = useMemo(() => {
    const seen = new Set<string>();
    return VISIBLE_CATALOG.filter((row) => JEV_KEYS.has(row.storageKey) && !seen.has(row.storageKey) && Boolean(seen.add(row.storageKey)));
  }, []);
  const selectedProjectName = projects.find((item) => item.id === projectId)?.name ?? projectId;
  const applyGlobalDefaults = (defaults: LanePilotDefaults) => {
    const reconcile = (payload: ScreenPayload): ScreenPayload => {
      const explicit = { ...payload.values };
      for (const key of payload.inheritedKeys ?? []) delete explicit[key];
      const inherited = inheritProjectValues(explicit, defaults);
      const next = { ...payload, values: inherited.values, inheritedKeys: inherited.inherited };
      projectCache.current.set(payload.projectId, { ...projectCache.current.get(payload.projectId), data: next, drafts: projectCache.current.get(payload.projectId)?.drafts ?? {}, writer: projectCache.current.get(payload.projectId)?.writer ?? null });
      return next;
    };
    setData((current) => { const next = current ? reconcile(current) : current; dataRef.current = next; return next; });
    for (const [id, cached] of projectCache.current) projectCache.current.set(id, { ...cached, data: reconcile(cached.data) });
  };

  const mobileNavValue = activeScope === "projects" ? (projectId ? `project:${projectId}` : "projects") : activeScope;

  return (
    <InheritanceContext.Provider value={{ locale, data, reset: (keys) => void resetInherited(keys) }}><div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row" data-testid="project-picker" data-locale={locale} data-bb-ru-skip>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2 md:hidden">
        <div className="flex items-center gap-2">
          <Select
            value={mobileNavValue}
            onValueChange={(next) => {
              if (next === "globals" || next === "agents") setActiveScope(next);
              else if (next.startsWith("project:")) chooseProject(next.slice("project:".length));
            }}
          >
            <SelectTrigger aria-label={t("scopeNav")} className="min-h-11 min-w-0 flex-1" data-testid="scope-nav-mobile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="globals">{t("navGlobals")}</SelectItem>
              <SelectItem value="agents">{t("navAgents")}</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={`project:${project.id}`}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
        </div>
        <div className="-mx-2 flex gap-1 overflow-x-auto px-2 pb-1" role="navigation" aria-label={t("scopeNav")}>
          <Button type="button" size="sm" aria-pressed={activeScope === "globals"} variant={activeScope === "globals" ? "secondary" : "ghost"} className="min-h-11 shrink-0 justify-center px-2.5" onClick={() => setActiveScope("globals")}>{t("navGlobals")}</Button>
          <Button type="button" size="sm" aria-pressed={activeScope === "agents"} variant={activeScope === "agents" ? "secondary" : "ghost"} className="min-h-11 shrink-0 justify-center px-2.5" onClick={() => setActiveScope("agents")}>{t("navAgents")}</Button>
        </div>
      </div>
      <nav className="hidden w-[13.5rem] shrink-0 flex-col border-r border-border bg-background md:flex" aria-label={t("scopeNav")} data-testid="scope-rail">
        <div className="flex flex-col gap-0.5 border-b border-border p-2" data-testid="scope-nav">
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "globals"} variant={activeScope === "globals" ? "secondary" : "ghost"} className="h-8 w-full justify-start px-2" onClick={() => setActiveScope("globals")}>{t("navGlobals")}</Button>
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "agents"} variant={activeScope === "agents" ? "secondary" : "ghost"} className="h-8 w-full justify-start px-2" onClick={() => setActiveScope("agents")}>{t("navAgents")}</Button>
        </div>
        <div className="p-2"><span className="text-xs font-medium text-muted-foreground">{t("projects")}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {projectListError ? <p role="alert" className="px-2 text-xs text-destructive">{t("projectListError")}</p> : null}
          {!projectsLoaded && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("loadingProjects")}</p> : null}
          {projectsLoaded && projects.length === 0 && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("noProjects")}</p> : null}
          <div className="flex flex-col gap-0.5">
            {projects.map((project) => <Button
              key={project.id}
              type="button"
              size="sm"
              variant={activeScope === "projects" && project.id === projectId ? "secondary" : "ghost"}
              aria-current={activeScope === "projects" && project.id === projectId ? "page" : undefined}
              data-testid={`project-item-${project.id}`}
              className="h-auto w-full justify-start px-2 py-1.5 text-left"
              onClick={() => chooseProject(project.id)}
            ><span className="min-w-0 truncate text-sm">{project.name}</span></Button>)}
          </div>
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="hidden items-center justify-end border-b border-border px-4 py-2 md:flex">
          <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-5">
        <OwnedSettings scope={activeScope} locale={locale} onDefaultsSaved={applyGlobalDefaults} />
        <main hidden={activeScope !== "projects"} className="space-y-6" data-testid="project-settings">
        {!projectId ? <p className="text-sm text-muted-foreground" data-testid="project-settings-empty">{t("noProjectSelected")}</p> : <>
        <div>
          <p className="text-xs text-muted-foreground">{t("selectedProject")}</p>
          <h1 className="break-words text-xl font-medium">{selectedProjectName}</h1>
        </div>
        <div className="grid gap-2 border-b border-border py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center" data-testid="main-agent">
          <div className="space-y-1">
            <Label className="text-sm">{t("mainAgent")}</Label>
            <p className="text-xs text-muted-foreground">{t("mainAgentHelp")}</p>
            {data?.compiledMainAgent === "none" && displayedValue("main.agent") ? <p className="text-xs text-muted-foreground">{t("mainAgentUnavailable")}</p> : null}
          </div>
          <Select
            value={String(displayedValue("main.agent") ?? "") || "__default__"}
            onValueChange={(next) => {
              const value = next === "__default__" ? "" : next;
              writeDraft("main.agent", value);
              void rpc.call("save_setting", { projectId: projectId!, key: "main.agent", value, expectedVersion: data?.versions["main.agent"] ?? 0 }).then((result) => {
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
            <SelectTrigger aria-label={t("mainAgent")} className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{t("mainAgentDefault")}</SelectItem>
              {(data?.mainAgents ?? []).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentPickerLabel(agent, t)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("loadError")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {saveError ? (
          <Alert variant="destructive" data-testid={saveError.kind === "cas" ? "cas-conflict" : "setting-validation-error"}>
            <AlertTitle>{saveError.kind === "cas" ? t("casConflict") : validationMessage(saveError.code, saveError.params)}</AlertTitle>
            <AlertDescription>
              {saveError.kind === "validation" && (saveError.code === "setup_required" || saveError.code === "writer_binding_ambiguous")
                ? null
                : <Button size="sm" variant="outline" onClick={() => void load()}>{t("reload")}</Button>}
            </AlertDescription>
          </Alert>
        ) : null}
        {data?.writerBinding ? (
          <Card data-testid="writer-binding">
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t("projectMachineFolder")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data.writerBinding.status === "resolved" ? (
                <p>
                  {data.writerBinding.hostId} · {data.writerBinding.path}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {data.writerBinding.source === "session" ? t("inheritedFromSession")
                      : data.writerBinding.source === "explicit_override" ? t("inheritedFromProject")
                        : t("inheritedFromProject")}
                  </span>
                </p>
              ) : null}
              {data.writerBinding.status === "ambiguous" ? (
                <Select onValueChange={(next) => {
                  const [hostId, path] = next.split("\u0000");
                  if (hostId && path) setSelectedBinding({ hostId, path });
                }}>
                  <SelectTrigger data-testid="writer-binding-select" aria-label={t("projectMachineFolder")}>
                    <SelectValue placeholder={t("bindingAmbiguous")} />
                  </SelectTrigger>
                  <SelectContent>
                    {data.writerBinding.bindings.map((row) => (
                      <SelectItem key={`${row.hostId}:${row.path}`} value={`${row.hostId}\u0000${row.path}`}>
                        {row.hostId} · {row.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {data.writerBinding.status === "setup_required" ? <p>{t("bindingSetupRequired")}</p> : null}
              {data.writerBinding.status === "offline" ? <p>{t("bindingOffline")}</p> : null}
              {data.writerBinding.status === "catalog_unavailable" ? <p>{t("writerCatalogUnavailable")}</p> : null}
              {(data.inheritedKeys ?? []).length ? <p className="text-xs text-muted-foreground">{t("inheritedFromGlobal")}</p> : null}
            </CardContent>
          </Card>
        ) : null}

        <Tabs value={tab} onValueChange={setTab}>
          {/* Keep the plugin's own EN/RU labels out of BB's DOM-based Russianizer. */}
          <TabsList data-bb-ru-skip>
            <TabsTrigger value="settings" data-testid="tab-settings">{t("tabSettings")}</TabsTrigger>
            <TabsTrigger value="checks" data-testid="tab-checks">{t("tabChecks")}</TabsTrigger>
            <TabsTrigger value="monitor" data-testid="tab-monitor">{t("tabMonitor")}</TabsTrigger>
            <TabsTrigger value="install" data-testid="tab-install">{t("tabInstall")}</TabsTrigger>
            <TabsTrigger value="diagnostics" data-testid="tab-diagnostics">{t("tabDiagnostics")}</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" forceMount={true} className="space-y-6" hidden={tab !== "settings"} data-testid="settings-panel">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor="settings-search">{t("settingsSearch")}</Label>
                <Input
                  id="settings-search"
                  data-testid="settings-search"
                  value={settingsQuery}
                  placeholder={t("settingsSearchPlaceholder")}
                  onChange={(event) => setSettingsQuery(event.target.value)}
                />
              </div>
              <div className="flex gap-1" data-testid="settings-depth" aria-label={t("settingsAdvanced")}>
                <Button size="sm" variant={settingsDepth === "basic" ? "default" : "outline"} aria-pressed={settingsDepth === "basic"} onClick={() => setSettingsDepth("basic")}>{t("settingsBasic")}</Button>
                <Button size="sm" variant={settingsDepth === "advanced" ? "default" : "outline"} aria-pressed={settingsDepth === "advanced"} onClick={() => setSettingsDepth("advanced")}>{t("settingsAdvanced")}</Button>
              </div>
            </div>
            {cardVisible("writerPicker", "writerPickerHelp", "writerEffortMode", "jevSettings", "jevOpencode") ? <SettingsGroup title={t("sectionExecution")} testId="settings-execution">
              <section className="space-y-2" data-testid="writer-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("writerPicker")}</h3>
                    <HelpTip label={t("writerPickerTechnical")}><p>{t("writerPickerTechnical")}</p></HelpTip>
                  </div>
                  {inheritReset([WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER])}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("writerPickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(pickerValue, (next) => { saveWriterSelection(next); })}</div>
                {(() => {
                  const effortRow = jevRows.find((row) => row.storageKey === "jev.LANE_JEV_EFFORT");
                  const automaticEffort = asBoolean(displayedValue("jev.LANE_JEV_EFFORT"), true);
                  return effortRow ? <details className="space-y-2" data-testid="writer-effort-mode">
                    <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                    <div className="flex items-center justify-between gap-2 pt-2">
                      <Label className="text-sm" htmlFor="writer-effort-mode">{t("writerEffortMode")}</Label>
                      <Select value={automaticEffort ? "automatic" : "manual"} onValueChange={(next) => void applySetting(effortRow, next === "automatic" ? "1" : "0")}>
                        <SelectTrigger id="writer-effort-mode" aria-label={t("writerEffortMode")} className="w-[11rem]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="automatic">{t("writerEffortAutomatic")}</SelectItem>
                          <SelectItem value="manual">{t("writerEffortManual")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="max-w-xl text-xs text-muted-foreground">{automaticEffort ? t("writerEffortFallbackNote") : t("writerEffortManualNote")}</p>
                    <div className="space-y-2" data-testid="jev-settings">
                      {jevRows.filter((row) => row.storageKey !== "jev.LANE_JEV_EFFORT").map((row) => {
                        const label = t("jevOpencode");
                        return <div key={row.storageKey} className="flex items-center justify-between gap-2">
                          <Label className="text-sm" htmlFor={row.id}>{label}</Label>
                          <Switch id={row.id} checked={asBoolean(displayedValue(row.storageKey), true)} aria-label={label}
                            onCheckedChange={(next) => void applySetting(row, next ? "1" : "0")} />
                        </div>;
                      })}
                    </div>
                    {(["writer.agent","sandbox.backend"] as const).map((key) => {
                      const row = catalogRow(key);
                      return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                        onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                    })}
                  </details> : null;
                })()}
              </section>
              <section className="space-y-2" data-testid="settings-group-workspace">
                {(() => { const row = catalogRow("adoc.040"); return row ? <SettingField row={row} value={displayedValue("adoc.040")} disabled={false}
                  onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("adoc.040", next)} /> : null; })()}
                <details className="space-y-2" open={settingsDepth === "advanced"}>
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(["adoc.041","adoc.042","ops.max_tasks"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </details>
              </section>
            </SettingsGroup> : null}

            {cardVisible("memoryPicker", "docsPicker", "onboardingPicker", "largeFileRead", "groupDocs") ? <SettingsGroup title={t("sectionMemoryDocs")} testId="settings-memory-docs">
              {cardVisible("memoryPicker", "memoryPickerHelp", "settingMemoryEnabled") ? <section className="space-y-2" data-testid="memory-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("settingMemoryEnabled")}</h3>
                    <HelpTip label={t("memoryPickerTechnical")}><p>{t("memoryPickerTechnical")}</p></HelpTip>
                  </div>
                  <div className="flex items-center gap-2">
                    {inheritReset([MEMORY_PROVIDER, MEMORY_MODEL, MEMORY_EFFORT, MEMORY_SERVICE_TIER])}
                    {(() => { const row = catalogRow("memory.enabled"); return row ? <Switch checked={asBoolean(displayedValue("memory.enabled"), false)} aria-label={t("settingMemoryEnabled")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                  </div>
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("memoryPickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(memoryPickerValue, (next) => { void saveMemorySelection(next); })}</div>
                <details className="space-y-2" data-testid="memory-advanced" open={settingsDepth === "advanced"}>
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(["memory.maintain","memory.inject","memory.audience","memory.search_engine","memory.personal_bot","memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </details>
              </section> : null}
              {cardVisible("docsPicker", "docsPickerHelp", "docsMaintain", "groupDocs") ? <section className="space-y-2" data-testid="docs-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("groupDocs")}</h3>
                    <HelpTip label={t("docsPickerTechnical")}><p>{t("docsPickerTechnical")}</p></HelpTip>
                  </div>
                  {(() => { const row = catalogRow("docs.enabled"); return row ? <Switch checked={asBoolean(displayedValue("docs.enabled"), false)} aria-label={t("groupDocs")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("docsPickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(docsPickerValue, (next) => { void saveDocsSelection(next); })}</div>
                <details className="space-y-2">
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(["docs.maintain","docs.page_cap","docs.since","docs.hour"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </details>
              </section> : null}
              {cardVisible("onboardingPicker", "onboardingPickerHelp") ? <section className="space-y-2" data-testid="onboarding-picker">
                <div className="flex min-w-0 items-center gap-1">
                  <h3 className="text-sm font-medium">{t("onboardingPicker")}</h3>
                  <HelpTip label={t("onboardingPickerHelp")}><p>{t("onboardingConstraint")}</p></HelpTip>
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingPickerHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingConstraint")}</p>
                <div className="max-w-xl">{modelPicker(onboardingPickerValue, (next) => { void saveOnboardingSelection(next); })}</div>
                <details className="space-y-2" open={settingsDepth === "advanced"}>
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(() => { const row = catalogRow("onboarding.depth"); return row ? <SettingField row={row} value={displayedValue("onboarding.depth")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("onboarding.depth", next)} /> : null; })()}
                </details>
              </section> : null}
              {cardVisible("largeFileRead", "largeFileReadHelp", "largeFilePicker") ? <section className="space-y-2" data-testid="pm-read-settings">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("largeFileRead")}</h3>
                    <HelpTip label={t("largeFileReadTechnical")}><p>{t("largeFileReadTechnical")}</p></HelpTip>
                  </div>
                  {(() => { const row = catalogRow("pm_read.enabled"); return row ? <Switch checked={asBoolean(displayedValue("pm_read.enabled"), false)} aria-label={t("largeFileRead")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadConstraint")}</p>
                <div className="max-w-xl">{modelPicker(pmReadPickerValue, (next) => { void savePmReadSelection(next); })}</div>
                <details className="space-y-2">
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(() => { const row = catalogRow("pm_read.min_lines"); return row ? <SettingField row={row} value={displayedValue("pm_read.min_lines")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("pm_read.min_lines", next)} /> : null; })()}
                </details>
              </section> : null}
            </SettingsGroup> : null}

            {cardVisible("helperContext", "helperContextHelp") ? <SettingsGroup title={t("sectionHelperContext")} testId="settings-helper-context">
              <section className="space-y-2" data-testid="helper-context-settings">
                <div className="flex min-w-0 items-center gap-1">
                  <h3 className="text-sm font-medium">{t("helperContext")}</h3>
                  <HelpTip label={t("helperContextTechnical")}><p>{t("helperContextTechnical")}</p><p className="mt-1">{t("helperContextNoneNote")}</p></HelpTip>
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextConstraint")}</p>
                {(() => { const row = catalogRow("helper.placement"); return row ? <SettingField row={row} value={displayedValue("helper.placement")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("helper.placement", next)} /> : null; })()}
                <details className="space-y-2">
                  <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                  {(["helper.context_mode","helper.skills","helper.mcp_servers","helper.bb_plugins","helper.native_plugins"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </details>
              </section>
            </SettingsGroup> : null}
            {extrasGrouped.filter((group) => group.section !== "night-review" && group.section !== "browser-qa").map(({ section, rows }) => (
              <section key={section} className="space-y-2" data-testid={`settings-group-${section}`}>
                <h3 className="text-sm font-medium">{t(sectionKey(section))}</h3>
                <div className="space-y-2">
                  {rows.map((row) => (
                    <SettingField
                      key={row.storageKey}
                      row={row}
                      value={displayedValue(row.storageKey)}
                      disabled={false}
                      onChange={(next) => void applySetting(row, next)}
                      onDraft={(next) => writeDraft(row.storageKey, next)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {settingsQuery.trim() && extrasGrouped.filter((group) => group.section !== "night-review" && group.section !== "browser-qa").length === 0 && !cardVisible("writerPicker", "memoryPicker", "jevSettings", "docsPicker", "onboardingPicker", "largeFileRead", "helperContext") ? (
              <p className="text-sm text-muted-foreground">{t("noMatchingSettings")}</p>
            ) : null}
          </TabsContent>

          <TabsContent value="checks" forceMount={true} className="space-y-6" hidden={tab !== "checks"} data-testid="checks-panel">
            <section className="space-y-2" data-testid="plan-critique-settings">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t("stagePlanCritique")}</h2>
                {(() => { const row = catalogRow("plan_critique.enabled"); return row ? <Switch checked={asBoolean(displayedValue("plan_critique.enabled"), true)} aria-label={t("stagePlanCritique")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
              </div>
              <p className="max-w-xl text-xs text-muted-foreground">{t("planCritiqueHelp")}</p>
              <div className="max-w-xl">{modelPicker(planCritiquePickerValue, (next) => { void savePlanCritiqueSelection(next); })}</div>
              <details className="space-y-2">
                <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                {(["plan_critique.mode","plan_critique.min_score","plan_critique.min_write_tasks","plan_critique.on_high_risk"] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </details>
            </section>
            <section className="space-y-2" data-testid="code-critique-settings">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t("stageCodeCritique")}</h2>
                {(() => { const row = catalogRow("code_critique.enabled"); return row ? <Switch checked={asBoolean(displayedValue("code_critique.enabled"), false)} aria-label={t("stageCodeCritique")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
              </div>
              <p className="max-w-xl text-xs text-muted-foreground">{t("codeCritiqueHelp")}</p>
              <div className="max-w-xl">{modelPicker(codeCritiquePickerValue, (next) => { void saveCodeCritiqueSelection(next); })}</div>
              <details className="space-y-2">
                <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                {(["code_critique.mode","code_critique.auto_fix","code_critique.max_rounds"] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </details>
            </section>
            <section className="space-y-2" data-testid="specialist-settings">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t("specialistReview")}</h2>
                {(() => { const row = catalogRow("specialist.enabled"); return row ? <Switch checked={asBoolean(displayedValue("specialist.enabled"), false)} aria-label={t("specialistReview")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
              </div>
              <p className="max-w-xl text-xs text-muted-foreground">{t("settingSpecialistEnabledHelp")}</p>
              <details className="space-y-2" open={settingsDepth === "advanced"}>
                <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                {(["specialist.when","specialist.provider","specialist.model","specialist.reasoning_effort"] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </details>
            </section>
            <section className="space-y-2" data-testid="night-review-settings">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t(sectionKey("night-review"))}</h2>
                <Switch id="night-review-enabled" checked={asBoolean(displayedValue("night_review.enabled"),false)} aria-label={t("nightReviewEnabled")}
                  onCheckedChange={(next)=>{const row=VISIBLE_CATALOG.find((item)=>item.storageKey==="night_review.enabled");if(row)void applySetting(row,next);}} />
              </div>
              <p className="max-w-xl text-xs text-muted-foreground">{t("nightReviewEnabled")}</p>
              <div className="max-w-xl">{modelPicker(nightPickerValue, (next) => { void saveNightReviewSelection(next); })}</div>
              <details className="space-y-2">
                <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                <div className="flex items-center justify-between gap-2 pt-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <Label className="text-sm" htmlFor="night-review-auto-merge">{t("nightReviewAutoMerge")}</Label>
                    <HelpTip label={t("nightReviewAutoMergeHelp")}><p>{t("nightReviewAutoMergeHelp")}</p></HelpTip>
                  </div>
                  <Switch id="night-review-auto-merge" checked={asBoolean(displayedValue("night_review.auto_merge"),false)} aria-label={t("nightReviewAutoMerge")}
                    onCheckedChange={(next)=>{const row=VISIBLE_CATALOG.find((item)=>item.storageKey==="night_review.auto_merge");if(row)void applySetting(row,next);}} />
                </div>
                {(() => { const row = catalogRow("night_review.max_fix_tasks"); return row ? <SettingField row={row} value={displayedValue("night_review.max_fix_tasks")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("night_review.max_fix_tasks", next)} /> : null; })()}
              </details>
            </section>
            <section className="space-y-2" data-testid="browser-qa-host">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t("globalQaHost")}</h2>
                {(() => { const row = catalogRow("browser_qa.enabled"); return row ? <Switch checked={asBoolean(displayedValue("browser_qa.enabled"), false)} aria-label={t("globalQaHost")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
              </div>
              <p className="max-w-xl text-xs text-muted-foreground">{t("browserQaHostHelp")}</p>
              {(() => {
                const options = data?.qaHosts ?? [];
                const current = String(displayedValue(QA_HOST_KEY) ?? "");
                const known = options.some((host) => host.id === current);
                if (!options.length) return <p className="text-sm text-muted-foreground">{t("browserQaHostNone")}</p>;
                return <Select value={known ? current : current ? current : "__inherit__"} onValueChange={(next) => { if (next === "__inherit__") void resetInherited([QA_HOST_KEY]); else void saveKey(QA_HOST_KEY, next); }}>
                  <SelectTrigger aria-label={t("globalQaHost")} data-testid="browser-qa-host-select" className="max-w-xl">
                    <SelectValue placeholder={t("inheritChoice")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__inherit__">{t("inheritChoice")}</SelectItem>
                    {options.map((host) => (
                      <SelectItem key={host.id} value={host.id}>{host.name} · {host.connected ? t("hostConnected") : t("hostOffline")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>;
              })()}
              {displayedValue(QA_HOST_KEY) && !(data?.qaHosts ?? []).some((host) => host.id === displayedValue(QA_HOST_KEY)) ? <p className="text-xs text-muted-foreground">{t("hostUnavailable")}</p> : null}
              <details className="space-y-2">
                <summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary>
                <Label htmlFor="browser-qa-workspace">{t("browserQaWorkspace")}</Label>
                <Input
                  id="browser-qa-workspace"
                  data-testid="browser-qa-workspace"
                  value={String(displayedValue(QA_WORKSPACE_KEY) ?? "")}
                  placeholder={data?.workspacePath ?? "/"}
                  onChange={(event) => writeDraft(QA_WORKSPACE_KEY, event.target.value)}
                  onBlur={(event) => void saveKey(QA_WORKSPACE_KEY, event.target.value)}
                />
                {extrasGrouped.filter((group) => group.section === "browser-qa").flatMap((group) => group.rows.filter((row) => row.storageKey !== "browser_qa.enabled")).map((row) => (
                  <SettingField
                    key={row.storageKey}
                    row={row}
                    value={displayedValue(row.storageKey)}
                    disabled={false}
                    onChange={(next) => void applySetting(row, next)}
                    onDraft={(next) => writeDraft(row.storageKey, next)}
                  />
                ))}
              </details>
            </section>
          </TabsContent>

          <TabsContent value="monitor" forceMount={true} className="space-y-4" data-testid="run-monitor" hidden={tab !== "monitor"}>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => projectId && void rpc.call("resume_runs", { projectId }).then(load)}>
                {t("resume")}
              </Button>
            </div>
            {!data?.runs.length ? (
              <p className="text-sm text-muted-foreground">{t("emptyRuns")}</p>
            ) : (
              <>
              <div className="space-y-3 sm:hidden" data-testid="run-monitor-mobile">
                {data.runs.flatMap((run) => run.attempts.length ? run.attempts.map((attempt, index) => {
                  const hasOpenAttempt = run.attempts.some((item) => ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(item.state));
                  return <Card key={attempt.id} data-testid={`mobile-attempt-${attempt.id}`}>
                    <CardContent className="space-y-2 p-3">
                      <div className="break-all font-mono text-xs">{t("runId")}: {run.id}</div>
                      <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t("kind")}: {run.kind}</span><Badge variant={runTone(run.state === "closed" ? run.state : attempt.state)}>{stateLabel(run.state === "closed" ? run.state : attempt.state)}</Badge></div>
                      <div className="text-xs text-muted-foreground">{t("attempt")}: {attempt.attempt_no || "—"}</div>
                      <div className="flex flex-wrap gap-2">
                        {index === 0 && run.state !== "closed" && !hasOpenAttempt ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                        {canCancelAttempt(run, attempt) ?
                          <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId:attempt.id }).then(load)}>{t("cancel")}</Button>
                          : null}
                        {canRetryAttempt(run, attempt) ?
                          <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId:attempt.id }).then(load)}>{t("retry")}</Button>
                          : null}
                      </div>
                    </CardContent>
                  </Card>;
                }) : [<Card key={run.id} data-testid={`mobile-run-${run.id}`}><CardContent className="space-y-2 p-3">
                  <div className="break-all font-mono text-xs">{t("runId")}: {run.id}</div>
                  <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t("kind")}: {run.kind}</span><Badge variant={runTone(run.state)}>{stateLabel(run.state)}</Badge></div>
                  {run.state !== "closed" ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                </CardContent></Card>])}
              </div>
              <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("runId")}</TableHead>
                    <TableHead>{t("kind")}</TableHead>
                    <TableHead>{t("state")}</TableHead>
                    <TableHead>{t("attempt")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.runs.flatMap((run) => {
                    if (!run.attempts.length) {
                      return [(
                        <TableRow key={run.id} data-testid={`run-${run.id}`}>
                          <TableCell className="font-mono text-xs">{run.id}</TableCell>
                          <TableCell>{run.kind}</TableCell>
                          <TableCell>
                            <Badge variant={runTone(run.state)}>{stateLabel(run.state)}</Badge>
                          </TableCell>
                          <TableCell>—</TableCell>
                          <TableCell className="space-x-2">
                            {run.state !== "closed" ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                          </TableCell>
                        </TableRow>
                      )];
                    }
                    const hasOpenAttempt = run.attempts.some((attempt) => ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state));
                    return run.attempts.map((attempt, index) => (
                    <TableRow key={attempt.id} data-testid={`attempt-${attempt.id}`}>
                      <TableCell className="font-mono text-xs">{run.id}</TableCell>
                      <TableCell>{run.kind}</TableCell>
                      <TableCell>
                        <Badge variant={runTone(run.state === "closed" ? run.state : attempt.state)}>{stateLabel(run.state === "closed" ? run.state : attempt.state)}</Badge>
                      </TableCell>
                      <TableCell>{attempt.attempt_no || "—"}</TableCell>
                      <TableCell className="space-x-2">
                        {index === 0 && run.state !== "closed" && !hasOpenAttempt ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                        {canCancelAttempt(run, attempt) ?
                            <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId: attempt.id }).then(load)}>
                              {t("cancel")}
                            </Button>
                          : null}
                        {canRetryAttempt(run, attempt) ?
                            <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId: attempt.id }).then(load)}>
                              {t("retry")}
                            </Button>
                          : null}
                      </TableCell>
                    </TableRow>
                    ));
                  })}
                </TableBody>
              </Table>
              </div>
              </>
            )}
            {data?.runs.filter((run) => run.stages?.length).map((run) => (
              <Card key={`stages-${run.id}`} data-testid={`stage-receipts-${run.id}`}>
                <CardHeader className="pb-2"><CardTitle className="break-all font-mono text-xs font-medium">{t("stageReceipts")} · {run.id}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {run.stages?.map((stage) => (
                    <div key={`${stage.taskId}-${stage.stageId}`} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">{stageTitle(stage.stageId)}</span>
                        <Badge variant={runTone(stage.state)}>{stateLabel(stage.state)}</Badge>
                      </div>
                      <div className="break-all font-mono text-xs text-muted-foreground">{stage.taskId} · SHA-256 {stage.inputSha256.slice(0, 12)}{stage.outputSha256 ? ` / ${stage.outputSha256.slice(0, 12)}` : ""}</div>
                      {stage.reason ? <p className="text-xs text-muted-foreground">{t("stageReason")}: {stage.reason}</p> : null}
                      {stage.result != null ? <SourceCode content={JSON.stringify(stage.result, null, 2)} path={`${stage.stageId}-receipt.json`} overflow="scroll" /> : null}
                      {stage.result == null && !stage.reason ? <p className="text-xs text-muted-foreground">{t("stageNoEvidence")}</p> : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
            <p className="sr-only">{[...RUN_STATES, ...ATTEMPT_STATES].join(" ")}</p>
          </TabsContent>

          <TabsContent value="diagnostics" forceMount={true} className="space-y-5" hidden={tab !== "diagnostics"} data-testid="diagnostics-panel">
            <p className="text-sm text-muted-foreground">{t("diagnosticsIntro")}</p>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t("importDetails")}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground" data-testid="import-diagnostics">
                {data?.importSource.completed ? <>
                  <p>{t("importRouting")}: {data.importSource.routingPath ?? "—"}</p>
                  <p>{t("importNight")}: {data.importSource.nightPath ?? "—"}</p>
                </> : <p>{t("importNone")}</p>}
                <p>{t("detectWorkspace")}: {data?.workspacePath ?? "—"}</p>
                {data?.lastSnapshotPath ? <p>{t("snapshotBackupFolder")}: {data.lastSnapshotPath}</p> : null}
              </CardContent>
            </Card>

            <section className="space-y-2" data-testid="writer-trace">
              <h2 className="text-sm font-medium">{t("writerTrace")}</h2>
              {data?.lastWriterTrace ? <div className="space-y-1 text-xs">
                <p data-testid="writer-trace-execution">{data.lastWriterTrace.providerId}/{data.lastWriterTrace.model} · {data.lastWriterTrace.effectiveReasoningLevel} · {data.lastWriterTrace.serviceTier ?? "default"}</p>
                <p>{t("writerTraceMode")}: {data.lastWriterTrace.effortMode === "manual" ? t("writerEffortManual") : t("writerEffortAutomatic")}</p>
                <p>{t("writerTraceRequested")}: {data.lastWriterTrace.requestedReasoningLevel}</p>
                {data.lastWriterTrace.fallbackReason ? <p>{t("writerTraceReason")}: {data.lastWriterTrace.fallbackReason}</p> : null}
                {data.lastWriterTrace.selectionSource ? <p>{t("writerTraceSource")}: {data.lastWriterTrace.selectionSource.reasoningLevelSource}</p> : null}
              </div> : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
            </section>
            <section className="space-y-2" data-testid="cli-preview">
              <h2 className="text-sm font-medium">{t("cliPreview")}</h2>
              {data?.cliPreview ? <pre className="max-h-80 max-w-full overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground"><code>{JSON.stringify(data.cliPreview, null, 2)}</code></pre>
                : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
            </section>

            <details className="space-y-2" data-testid="restore-previous-install">
              <summary className="cursor-pointer text-sm font-medium">{t("restorePreviousInstall")}</summary>
              <p className="max-w-xl text-xs text-muted-foreground">{t("snapshotBackupHelp")}</p>
              <Label htmlFor="snapshot-path">{t("snapshotBackupFolder")}</Label>
              <Input id="snapshot-path" value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)} />
            </details>

            <section className="space-y-2">
              <h2 className="text-sm font-medium">{t("unapplied")}</h2>
              {data?.unapplied.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {data.unapplied.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {unappliedReason(item.reason)}</li>)}
              </ul> : <p className="text-xs text-muted-foreground">{t("noUnapplied")}</p>}
            </section>

            {diagnosticsGrouped.map(({ section, rows }) => <section key={section} className="space-y-3">
              <h2 className="text-sm font-medium">{t(sectionKey(section))}</h2>
              <div className="space-y-2">
                {rows.map((row) => {
                  const disabled = row.uiStatus !== "editable";
                  const value = data?.values[row.storageKey];
                  return <div key={row.storageKey} data-testid={`field-${row.id}`} data-storage-key={row.storageKey}
                    data-ui-status={row.uiStatus} className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
                    <div className="space-y-1">
                      <Label className="text-sm">{row.storageKey === "writer.fast_mode" ? t("legacyFastMode") : settingLabel(row)}</Label>
                      {row.storageKey === "writer.fast_mode" ? <p className="text-xs text-muted-foreground">{t("legacyFastModeExplanation")}</p> : (
                        disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null
                      )}
                      <StatusBadge status={row.uiStatus} />
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">{t("fieldTechnicalDetails")}</summary>
                        <p className="mt-1">{row.area} · {row.location}</p>
                        <p>{t("casVersion")} {data?.versions[row.storageKey] ?? 0}</p>
                      </details>
                    </div>
                    {row.storageKey === "writer.fast_mode" ? <code className="text-xs">{String(value ?? "unset")}</code> : (
                      disabled ? <code className="text-xs">{String(value ?? "unset")}</code> : <FieldControl
                        row={row} value={displayedValue(row.storageKey) ?? value} disabled={disabled}
                        onDraft={(next) => { if (!disabled) writeDraft(row.storageKey, next); }}
                        onChange={(next) => { if (!disabled) void applySetting(row, next); }} />
                    )}
                  </div>;
                })}
              </div>
            </section>)}

            <details className="rounded-md border border-border p-3" data-testid="compat-aliases">
              <summary className="cursor-pointer text-sm font-medium">{t("compatTitle")}</summary>
              <p className="mt-2 text-xs text-muted-foreground">{t("compatIntro")}</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {compatibilityAliasRows().map((row) => (
                  <li key={row.id} data-storage-key={row.storageKey} data-testid={`compat-${row.storageKey}`}>
                    {row.storageKey} · {row.setting}
                  </li>
                ))}
              </ul>
            </details>

            <section className="space-y-3" data-testid="cli-receipt">
              <h2 className="text-sm font-medium">{t("cliReceipt")}</h2>
              {data?.runs.flatMap((run) => {
                const seen = new Set<string>();
                const items: Array<{ id:string; json:string }> = [];
                for (const attempt of run.attempts) if (attempt.cliReceiptJson && !seen.has(attempt.cliReceiptJson)) {
                  seen.add(attempt.cliReceiptJson); items.push({ id:attempt.id, json:attempt.cliReceiptJson });
                }
                if (run.cliReceiptJson && !seen.has(run.cliReceiptJson)) items.push({ id:run.id, json:run.cliReceiptJson });
                return items.map((item) => <div key={item.id} data-testid={`cli-receipt-${item.id}`}>
                  <h3 className="mb-2 text-xs font-medium">{t("cliReceipt")} {item.id}</h3>
                  <SourceCode content={item.json} path={`cli-receipt-${item.id}.json`} overflow="scroll" />
                </div>);
              })}
              {data?.cliReceiptJson && !data.runs.some((run) => run.cliReceiptJson || run.attempts.some((attempt) => attempt.cliReceiptJson))
                ? <SourceCode content={data.cliReceiptJson} path="cli-receipt.json" overflow="scroll" /> : null}
            </section>

            {(resultPatch || resultSource) ? <section className="space-y-2" data-testid="writer-result">
              <h2 className="text-sm font-medium">{t("result")}</h2>
              {resultPatch ? <Diff patch={resultPatch} path="writer-output.txt" view="unified" /> : null}
              {resultSource ? <SourceCode content={resultSource} path="acceptance.json" overflow="scroll" /> : null}
            </section> : null}
            {data?.lastReceiptJson ? <section className="space-y-2" data-testid="install-receipt">
              <h2 className="text-sm font-medium">{t("installReceipt")}</h2>
              <SourceCode content={data.lastReceiptJson} path="install-receipt.json" overflow="scroll" />
            </section> : null}
          </TabsContent>

          <TabsContent value="install" forceMount={true} className="space-y-3" hidden={tab !== "install"} data-testid="install-panel">
            {!data?.hostId ? <p className="text-sm text-muted-foreground">{t("hostMissing")}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-testid="stack-detect" onClick={() => void runStack("detect")}>{t("detect")}</Button>
              <Button size="sm" data-testid="install-stack" onClick={() => { setPendingOp("install"); setConfirmOpen(true); }}>{t("install")}</Button>
              <Button size="sm" variant="outline" onClick={() => { setPendingOp("connect"); setConfirmOpen(true); }}>{t("connectOpencode")}</Button>
              <Button size="sm" variant="destructive" onClick={() => { setPendingOp("rollback"); setConfirmOpen(true); }}>{t("rollback")}</Button>
            </div>
            {detectResult ? <Card data-testid="stack-detect-result">
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t("detectResult")}</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
                <div><span className="text-muted-foreground">{t("detectScenario")}:</span> {detectResult.scenario}</div>
                <div><span className="text-muted-foreground">{t("detectTargetMatch")}:</span> {detectResult.matchesTarget ? t("yes") : t("no")} ({t("targetMatchInformational")})</div>
                <div><span className="text-muted-foreground">{t("detectLaneStack")}:</span> {detectResult.laneStack.present ? detectResult.laneStack.version ?? t("unknown") : t("no")}</div>
                <div><span className="text-muted-foreground">{t("detectOpenCode")}:</span> {detectResult.openCode.present ? `${t("yes")} (${detectResult.openCode.version ?? t("unknown")})` : t("no")}</div>
              </CardContent>
            </Card> : null}
            {detectResult?.coexistence ? <Card data-testid="coexistence-inventory">
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t("coexInventory")}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {detectResult.coexistence.managers.map((manager) => (
                  <div key={`${manager.manager}-${manager.path}`} className="space-y-2 rounded-md border p-3" data-testid={`coex-${manager.manager}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{t(COEXISTENCE_MANAGER_KEYS[manager.manager] ?? "coexUnknownManager")}</span>
                      <Badge variant={manager.compatible === false ? "destructive" : manager.decision === "reuse" ? "default" : "outline"}>{t(COEXISTENCE_VALUE_KEYS[manager.decision] ?? "coexDecisionUnknown")}</Badge>
                    </div>
                    <div className="break-all font-mono text-xs">{manager.path}</div>
                    <div className="grid gap-1 text-xs sm:grid-cols-2">
                      <span>{t("coexInstalled")}: {manager.installed ? t("yes") : t("no")}</span>
                      <span>{t("coexConfigured")}: {manager.configured ? t("yes") : t("no")}</span>
                      <span>{t("coexLoaded")}: {manager.loaded === null ? t("coexRuntimeUnverified") : manager.loaded ? t("yes") : t("no")}</span>
                      <span>{t("coexCompatible")}: {manager.compatible === null ? t("unknown") : manager.compatible ? t("yes") : t("no")}</span>
                      <span>{t("coexModified")}: {manager.modified === null ? t("unknown") : manager.modified ? t("yes") : t("no")}</span>
                      <span>{t("coexOwner")}: {t(COEXISTENCE_VALUE_KEYS[manager.owner] ?? "coexOwnerUnknown")}</span>
                      {manager.version ? <span>{t("version")}: {manager.version}</span> : null}
                    </div>
                    {manager.missingCapabilities.length ? <p className="text-xs text-destructive">{t("coexMissingCapabilities")}: {manager.missingCapabilities.join(", ")}</p> : null}
                    <details className="text-xs"><summary className="cursor-pointer">{t("coexEvidence")} ({manager.evidence.length})</summary>
                      <ul className="mt-2 space-y-1">{manager.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`} className="break-words">{evidence.detail}{evidence.sha256 ? ` · SHA-256 ${evidence.sha256.slice(0, 12)}` : ""}</li>)}</ul>
                    </details>
                  </div>
                ))}
              </CardContent>
            </Card> : null}
          </TabsContent>
        </Tabs>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            data-testid="external-ops-dialog"
            className="box-border !left-4 !right-4 !top-1/2 !w-[min(359px,calc(100vw-2rem))] !max-w-[359px] min-w-0 !translate-x-0 !-translate-y-1/2 max-h-[min(80vh,100dvh)] overflow-y-auto overflow-x-hidden p-4 sm:rounded-lg sm:!max-w-[359px]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="text-wrap break-words">{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription className="max-w-full overflow-x-hidden text-left text-wrap break-words">
                {t("confirmList")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pendingOp === "install" ? (
              <ul className="mt-2 max-w-full list-disc overflow-x-hidden pl-4 text-left text-sm">
                {EXTERNAL_OPS_BY_ACTION.install.map((op) => (
                  <li key={op} className="break-all">{op}</li>
                ))}
              </ul>
            ) : null}
            {pendingOp === "connect" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmConnectOps")}</p>
            ) : null}
            {pendingOp === "rollback" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmRollbackOps")}</p>
            ) : null}
            <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmBody")}</p>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const op = pendingOp;
                  setConfirmOpen(false);
                  if (op) void runStack(op, true);
                }}
              >
                {t("confirmContinue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </>}
        </main>
        </div>
        </div>
      </div>
    </div></InheritanceContext.Provider>
  );
}
