import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Slider } from "../../components/ui/slider";
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
import { EXTERNAL_OPS_BY_ACTION } from "../constants";
import { ATTEMPT_STATES, RUN_STATES } from "../state-machine";

type ScreenPayload = {
  projectId: string;
  hostId: string | null;
  workspacePath: string | null;
  values: Record<string, unknown>;
  versions: Record<string, number>;
  importSource: { completed: boolean; at: number | null; routingPath: string | null; nightPath: string | null };
  runs: Array<{
    id: string;
    state: string;
    kind: string;
    created_at: number;
    updated_at: number;
    cliReceiptJson: string | null;
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
};

type StackDetectResult = {
  hostId: string;
  laneStack: { present:boolean; version:string|null; sourceSha:string|null };
  openCode: { present:boolean; version:string|null };
  workspace: { path:string; present:boolean };
  targetSha: string;
  matchesTarget: boolean;
  scenario: "S1"|"S2"|"S3";
};

const JEV_KEYS = new Set(["jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV"]);
const WRITER_PROVIDER = "writer.provider";
const WRITER_MODEL = "writer.model";
const WRITER_EFFORT = "writer.reasoning_effort";
const WRITER_SERVICE_TIER = "writer.service_tier";

function fieldKey(id: string): I18nKey {
  return `field_${id}` as I18nKey;
}
function reasonKey(id: string): I18nKey {
  return `reason_${id}` as I18nKey;
}
function sectionKey(section: string): I18nKey {
  return `section_${section}` as I18nKey;
}

function diagnosticRows(): CatalogRow[] {
  const rank: Record<CatalogRow["uiStatus"], number> = { editable: 3, readonly: 2, gap: 1, excluded: 0 };
  const byKey = new Map<string, CatalogRow>();
  for (const row of VISIBLE_CATALOG) {
    if (row.section === "night-review" || row.section === "jev" || JEV_KEYS.has(row.storageKey)) continue;
    if ([WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER].includes(row.storageKey)) continue;
    const current = byKey.get(row.storageKey);
    if (!current || rank[row.uiStatus] > rank[current.uiStatus]) byKey.set(row.storageKey, row);
  }
  return [...byKey.values()];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "on" || value === "true") return true;
  if (value === "0" || value === "off" || value === "false" || value === "no") return false;
  return fallback;
}

function FieldControl({
  row,
  value,
  disabled,
  options: optionOverride,
  onChange,
}: {
  row: CatalogRow;
  value: unknown;
  disabled: boolean;
  options?: string[];
  onChange: (next: unknown) => void;
}) {
  const control = JEV_KEYS.has(row.storageKey) ? "switch" : row.control;
  const label = t(fieldKey(row.id));
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
    const options = optionOverride ?? row.options;
    if (options.length === 0) return <Input disabled value={String(value ?? "")} aria-label={label} />;
    const current = String(value ?? options[0] ?? "");
    return (
      <Select value={current} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (control === "slider" && row.min !== null && row.max !== null) {
    const numeric = typeof value === "number" ? value : Number(value ?? row.min);
    return (
      <Slider
        min={row.min}
        max={row.max}
        step={1}
        disabled={disabled}
        value={[Number.isFinite(numeric) ? numeric : row.min]}
        onValueChange={(next) => onChange(next[0])}
        aria-label={label}
      />
    );
  }
  return (
    <Input
      type={control === "number" ? "number" : "text"}
      disabled={disabled}
      value={value == null ? "" : String(value)}
      onChange={(event) => onChange(control === "number" ? Number(event.target.value) : event.target.value)}
      aria-label={label}
    />
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
  if (state === "accepted") return "default";
  if (state === "blocked" || state === "provider_error" || state === "validation_failed") return "destructive";
  if (state === "running" || state === "pending") return "secondary";
  return "outline";
}

export function LanePilotPage({ subPath = "" }: { subPath?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId } = useBbContext();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projectId = selectedProjectId ?? routeProjectId ?? (subPath || null);
  const [projects, setProjects] = useState<Array<{ id:string; name:string }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectListError, setProjectListError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const providers = useProviders();
  const [tab, setTab] = useState("settings");
  const [data, setData] = useState<ScreenPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ kind: "cas" } | { kind: "validation"; code: "invalid_choice" | "incompatible_setting"; params: string[] } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingOp, setPendingOp] = useState<"install" | "connect" | "rollback" | null>(null);
  const [snapshotPath, setSnapshotPath] = useState("");
  const [detectResult, setDetectResult] = useState<StackDetectResult | null>(null);
  const [resultPatch, setResultPatch] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [localePreference, setLocalePreference] = useState<LocalePreference>("auto");

  useEffect(() => {
    let current = true;
    void rpc.call("list_projects", {}).then((result) => {
      if (current) {
        setProjects(result.projects);
        setProjectsLoaded(true);
        if (!routeProjectId && !subPath) {
          const preferred = result.lastProjectId ?? result.projects[0]?.id ?? null;
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

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    setData(null);
    try {
      const next = await rpc.call("get_screen", { projectId }) as ScreenPayload;
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

  const chooseProject = (next: string) => {
    setSelectedProjectId(next);
    setProjectListError(false);
    void rpc.call("remember_project", { projectId: next }).catch(() => setProjectListError(true));
  };

  const save = async (row: CatalogRow, value: unknown) => {
    if (!projectId || !data) return false;
    const expectedVersion = data.versions[row.storageKey] ?? 0;
    const result = await rpc.call("save_setting", {
      projectId,
      key: row.storageKey,
      value,
      expectedVersion,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      await load();
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => current ? {
      ...current,
      values: { ...current.values, [row.storageKey]: result.value },
      versions: { ...current.versions, [row.storageKey]: result.version },
    } : current);
    return true;
  };

  const saveWriterSelection = async (selection: ExperimentalProviderModelPickerValue) => {
    if (!projectId || !data) return false;
    const result = await rpc.call("save_writer_selection", {
      projectId,
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel,
      serviceTier: selection.serviceTier ?? null,
      expectedVersions: {
        "writer.provider": data.versions[WRITER_PROVIDER] ?? 0,
        "writer.model": data.versions[WRITER_MODEL] ?? 0,
        "writer.reasoning_effort": data.versions[WRITER_EFFORT] ?? 0,
        "writer.service_tier": data.versions[WRITER_SERVICE_TIER] ?? 0,
      },
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      await load();
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => current ? {
      ...current,
      values: { ...current.values, ...result.values },
      versions: { ...current.versions, ...result.versions },
    } : current);
    return true;
  };

  const pickerValue: ExperimentalProviderModelPickerValue = {
    providerId: String(data?.values[WRITER_PROVIDER] ?? ""),
    model: String(data?.values[WRITER_MODEL] ?? ""),
    reasoningLevel: (String(data?.values[WRITER_EFFORT] ?? "none") || "none") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider) => provider.id === String(data?.values[WRITER_PROVIDER] ?? ""))?.serviceTiers?.length
      ? { serviceTier: data?.values[WRITER_SERVICE_TIER] === "fast" ? "fast" : "default" }
      : {}),
  };

  const hostId = data?.hostId;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;

  const runStack = async (op: "detect" | "install" | "connect" | "rollback", confirm = false) => {
    if (!projectId) return;
    try {
      if (op === "detect") setDetectResult(await rpc.call("stack_detect", { projectId }) as StackDetectResult);
      if (op === "install") await rpc.call("stack_install", { projectId, confirmExternalOps: confirm });
      if (op === "connect") await rpc.call("stack_connect", { projectId, confirmExternalOps: confirm });
      if (op === "rollback") await rpc.call("stack_rollback", { projectId, snapshotPath });
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

  return (
    <div className="h-full overflow-auto p-3 md:p-5" data-testid="project-picker" data-locale={locale} data-bb-ru-skip>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 md:flex-row md:items-start md:gap-6">
        <aside className="w-full shrink-0 space-y-3 md:sticky md:top-0 md:w-56" data-testid="project-rail">
          <div>
            <h1 className="text-sm font-semibold">{t("projects")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{t("projectRailHint")}</p>
          </div>
          {projectListError ? <p role="alert" className="text-xs text-destructive">{t("projectListError")}</p> : null}
          {!projectsLoaded && !projectListError ? <p className="text-sm text-muted-foreground">{t("loadingProjects")}</p> : null}
          {projectsLoaded && projects.length === 0 && !projectListError ? <p className="text-sm text-muted-foreground">{t("noProjects")}</p> : null}
          {projects.length ? <nav aria-label={t("projects")} className="grid max-h-44 gap-1 overflow-y-auto rounded-md border border-border p-1 md:max-h-[calc(100vh-13rem)]">
            {projects.map((project) => <Button
              key={project.id}
              type="button"
              size="sm"
              variant={project.id === projectId ? "secondary" : "ghost"}
              aria-current={project.id === projectId ? "page" : undefined}
              data-testid={`project-item-${project.id}`}
              className="justify-start truncate"
              onClick={() => chooseProject(project.id)}
            >{project.name}</Button>)}
          </nav> : null}
          <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
        </aside>

        <main className="min-w-0 flex-1 space-y-5" data-testid="project-settings">
        {!projectId ? <Card data-testid="project-settings-empty"><CardContent className="p-5 text-sm text-muted-foreground">{t("noProjectSelected")}</CardContent></Card> : <>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-xs text-muted-foreground">{t("selectedProject")}</p><h1 className="break-words text-lg font-semibold">{selectedProjectName}</h1></div>
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
              <Button size="sm" variant="outline" onClick={() => void load()}>{t("reload")}</Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <Tabs value={tab} onValueChange={setTab}>
          {/* Keep the plugin's own EN/RU labels out of BB's DOM-based Russianizer. */}
          <TabsList data-bb-ru-skip>
            <TabsTrigger value="settings" data-testid="tab-settings">{t("tabSettings")}</TabsTrigger>
            <TabsTrigger value="monitor" data-testid="tab-monitor">{t("tabMonitor")}</TabsTrigger>
            <TabsTrigger value="install" data-testid="tab-install">{t("tabInstall")}</TabsTrigger>
            <TabsTrigger value="diagnostics" data-testid="tab-diagnostics">{t("tabDiagnostics")}</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" forceMount={true} className="space-y-5" hidden={tab !== "settings"} data-testid="settings-panel">
            <Card data-testid="writer-picker">
              <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">{t("writerPicker")}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">{t("writerPickerHelp")}</p>
              {pickerValue.providerId || (providers.providers?.length ?? 0) > 0 ? (
                <ProviderModelPicker
                  value={pickerValue.providerId ? pickerValue : {
                    providerId: providers.providers?.[0]?.id ?? "none",
                    model: "",
                    reasoningLevel: "none",
                  }}
                  routing={routing}
                  onChange={(next) => {
                    void saveWriterSelection(next);
                  }}
                />
              ) : <p className="text-sm text-muted-foreground">{providers.status === "loading" ? t("writerCatalogLoading") : t("writerCatalogUnavailable")}</p>}
              </CardContent>
            </Card>

            <section className="space-y-3" data-testid="jev-settings">
              <h2 className="text-sm font-medium">{t("jevSettings")}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {jevRows.map((row) => {
                  const label = t(row.storageKey === "jev.LANE_JEV_EFFORT" ? "jevEffort" : "jevOpencode");
                  return <div key={row.storageKey} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                    <Label className="text-sm" htmlFor={row.id}>{label}</Label>
                    <Switch id={row.id} checked={asBoolean(data?.values[row.storageKey], true)} aria-label={label}
                      onCheckedChange={(next) => void save(row, next ? "1" : "0")} />
                  </div>;
                })}
              </div>
            </section>

            <Card data-testid="night-review-unsupported">
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t(sectionKey("night-review"))}</CardTitle></CardHeader>
              <CardContent className="text-sm text-muted-foreground">{t("nightReviewUnavailable")}</CardContent>
            </Card>
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
                        {attempt.thread_id ? <>
                          <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId:attempt.id }).then(load)}>{t("cancel")}</Button>
                          <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId:attempt.id }).then(load)}>{t("retry")}</Button>
                        </> : null}
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
                        {attempt.thread_id ? (
                          <>
                            <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId: attempt.id }).then(load)}>
                              {t("cancel")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId: attempt.id }).then(load)}>
                              {t("retry")}
                            </Button>
                          </>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    ));
                  })}
                </TableBody>
              </Table>
              </div>
              </>
            )}
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
                <p>{t("snapshotPath")}: {snapshotPath || data?.lastSnapshotPath || "—"}</p>
              </CardContent>
            </Card>

            <section className="space-y-2" data-testid="cli-preview">
              <h2 className="text-sm font-medium">{t("cliPreview")}</h2>
              {data?.cliPreview ? <SourceCode content={JSON.stringify(data.cliPreview, null, 2)} path="cli-preview.json" overflow="scroll" />
                : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
            </section>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t("snapshotPath")}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="snapshot-path">{t("snapshotPath")}</Label>
                <Input id="snapshot-path" value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)} />
              </CardContent>
            </Card>

            <section className="space-y-2">
              <h2 className="text-sm font-medium">{t("unapplied")}</h2>
              {data?.unapplied.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {data.unapplied.map((item) => <li key={item.key}>{item.key}: {unappliedReason(item.reason)}</li>)}
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
                      <Label className="text-sm">{row.storageKey === "writer.fast_mode" ? t("legacyFastMode") : t(fieldKey(row.id))}</Label>
                      {row.storageKey === "writer.fast_mode" ? <p className="text-xs text-muted-foreground">{t("legacyFastModeExplanation")}</p> : <>
                        <p className="text-xs text-muted-foreground">{row.area} · {row.location}</p>
                        {disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null}
                      </>}
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <StatusBadge status={row.uiStatus} />
                        <span>{t("casVersion")} {data?.versions[row.storageKey] ?? 0}</span>
                      </div>
                    </div>
                    {row.storageKey === "writer.fast_mode" ? <code className="text-xs">{String(value ?? "unset")}</code> : <FieldControl
                      row={row} value={value} disabled={disabled} onChange={(next) => { if (!disabled) void save(row, next); }} />}
                  </div>;
                })}
              </div>
            </section>)}

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
                <div><span className="text-muted-foreground">{t("detectTargetMatch")}:</span> {detectResult.matchesTarget ? t("yes") : t("no")}</div>
                <div><span className="text-muted-foreground">{t("detectLaneStack")}:</span> {detectResult.laneStack.present ? detectResult.laneStack.version ?? t("unknown") : t("no")}</div>
                <div><span className="text-muted-foreground">{t("detectOpenCode")}:</span> {detectResult.openCode.present ? `${t("yes")} (${detectResult.openCode.version ?? t("unknown")})` : t("no")}</div>
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
  );
}
