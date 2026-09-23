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
  WRITER_EFFORT_CHOICES_BY_PROVIDER,
  type CatalogRow,
} from "../ui-catalog";
import { t, stateLabel, unappliedReason, validationMessage, setLocaleOverride, localeFromSources, detectLocale, detectLocaleHint, type I18nKey, type Locale, type LocalePreference } from "../../i18n";
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
import { specFor } from "../channels";
import { EXTERNAL_OPS_BY_ACTION } from "../constants";
import { ATTEMPT_STATES, RUN_STATES } from "../state-machine";
import { normalizeWriterEffort } from "../setting-validation";

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
  lastSnapshotPath: string | null;
  lastReceiptJson: string | null;
  writerResultJson: string | null;
  writerResultPatch: string | null;
  cliReceiptJson: string | null;
};

const JEV_KEYS = new Set(["jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV"]);
const WRITER_PROVIDER = "writer.provider";
const WRITER_MODEL = "writer.model";
const WRITER_EFFORT = "writer.reasoning_effort";

function fieldKey(id: string): I18nKey {
  return `field_${id}` as I18nKey;
}
function reasonKey(id: string): I18nKey {
  return `reason_${id}` as I18nKey;
}
function sectionKey(section: string): I18nKey {
  return `section_${section}` as I18nKey;
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
  const [projectChoice, setProjectChoice] = useState("");
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(null);
  const [openingProject, setOpeningProject] = useState(false);
  const projectId = routeProjectId ?? (subPath || openedProjectId || null);
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
  const [resultPatch, setResultPatch] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [localePreference, setLocalePreference] = useState<LocalePreference>("auto");

  useEffect(() => {
    if (projectId) return;
    let current = true;
    void rpc.call("list_projects", {}).then((result) => {
      if (current) { setProjects(result.projects); setProjectsLoaded(true); if (result.lastProjectId) setProjectChoice(result.lastProjectId); }
    }).catch(() => { if (current) setProjectListError(true); });
    return () => { current = false; };
  }, [projectId, rpc]);

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

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const section of SECTION_ORDER) map.set(section, []);
    for (const row of VISIBLE_CATALOG) {
      const section = JEV_KEYS.has(row.storageKey) ? "jev" : row.section;
      const list = map.get(section) ?? [];
      list.push(row);
      map.set(section, list);
    }
    return SECTION_ORDER.filter((section) => (map.get(section) ?? []).length > 0)
      .map((section) => ({ section, rows: map.get(section) ?? [] }));
  }, []);

  const save = async (row: CatalogRow, value: unknown) => {
    if (!projectId || !data) return false;
    if (row.storageKey === WRITER_PROVIDER || row.storageKey === WRITER_EFFORT) {
      const provider = String(row.storageKey === WRITER_PROVIDER ? value : data.values[WRITER_PROVIDER] ?? "");
      const currentEffort = row.storageKey === WRITER_PROVIDER ? data.values[WRITER_EFFORT] : value;
      const normalized = row.storageKey === WRITER_PROVIDER ? normalizeWriterEffort(provider, currentEffort) : null;
      const changes = row.storageKey === WRITER_PROVIDER
        ? [{ key: WRITER_PROVIDER, value: provider }, { key: WRITER_EFFORT, value: normalized!.effort }]
        : [{ key: WRITER_EFFORT, value }, { key: WRITER_PROVIDER, value: provider }];
      const saved = await saveSettings(changes);
      if (saved && normalized?.changed) {
        toast.info(<span data-bb-ru-skip>{t("writerEffortAdjusted").replace("{from}", String(currentEffort ?? "")).replace("{to}", normalized.effort).replace("{provider}", provider)}</span>);
      }
      return saved;
    }
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

  const saveSettings = async (changes: Array<{ key:string; value:unknown }>) => {
    if (!projectId || !data) return false;
    const result = await rpc.call("save_settings", {
      projectId,
      changes: changes.map(({ key, value }) => ({
        key,
        value,
        expectedVersion: data.versions[key] ?? 0,
      })),
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
  };

  const hostId = data?.hostId;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;

  const runStack = async (op: "detect" | "install" | "connect" | "rollback", confirm = false) => {
    if (!projectId) return;
    try {
      if (op === "detect") await rpc.call("stack_detect", { projectId });
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
      if (!result.closed) toast.error(t("finishRunBlocked"));
      else toast.success(t("runClosed"));
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("toastError"));
    } finally { setFinishing(false); }
  };

  if (!projectId) {
    return <div className="space-y-3 p-4" data-testid="project-picker" data-locale={locale} data-bb-ru-skip>
      <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{t("selectProject")}</p><LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} /></div>
      {projectListError ? <p role="alert" className="text-sm text-destructive">{t("projectListError")}</p> : null}
      {!projectsLoaded && !projectListError ? <p className="text-sm text-muted-foreground">{t("loadingProjects")}</p> : null}
      {projectsLoaded && projects.length === 0 && !projectListError ? <p className="text-sm text-muted-foreground">{t("noProjects")}</p> : null}
      <select aria-label={t("selectProject")} value={projectChoice} onChange={(event) => setProjectChoice(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
        <option value="">{t("selectProject")}</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <Button size="sm" onClick={() => {
        if (!projectChoice || openingProject) return;
        setOpeningProject(true);
        void rpc.call("remember_project", { projectId: projectChoice }).then(() => setOpenedProjectId(projectChoice))
          .catch(() => setProjectListError(true)).finally(() => setOpeningProject(false));
      }} disabled={!projectChoice || openingProject}>{openingProject ? t("loadingProjects") : t("openProject")}</Button>
    </div>;
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5" data-locale={locale} data-bb-ru-skip>
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="flex justify-end"><LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} /></div>
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
          </TabsList>

          <TabsContent value="settings" forceMount={true} className="space-y-6" hidden={tab !== "settings"} data-testid="settings-panel">
            <p className="text-xs text-muted-foreground">{t("projectIsolation")}</p>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">{t("importSource")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground">
                {data?.importSource.completed ? (
                  <>
                    <p>{t("importRouting")}: {data.importSource.routingPath ?? "—"}</p>
                    <p>{t("importNight")}: {data.importSource.nightPath ?? "—"}</p>
                  </>
                ) : <p>{t("importNone")}</p>}
              </CardContent>
            </Card>

            <section className="space-y-2" data-testid="writer-picker">
              <h2 className="text-sm font-medium">{t("writerPicker")}</h2>
              {pickerValue.providerId || (providers.providers?.length ?? 0) > 0 ? (
                <ProviderModelPicker
                  value={pickerValue.providerId ? pickerValue : {
                    providerId: providers.providers?.[0]?.id ?? "none",
                    model: "",
                    reasoningLevel: "none",
                  }}
                  routing={routing}
                  onChange={(next) => {
                    const normalized = normalizeWriterEffort(next.providerId, next.reasoningLevel);
                    if (!normalized.effort) return;
                    void saveSettings([
                      { key: WRITER_PROVIDER, value: next.providerId },
                      { key: WRITER_MODEL, value: next.model },
                      { key: WRITER_EFFORT, value: normalized.effort },
                    ]).then((saved) => {
                      if (saved && normalized.changed) {
                        toast.info(<span data-bb-ru-skip>{t("writerEffortAdjusted").replace("{from}", String(next.reasoningLevel)).replace("{to}", normalized.effort).replace("{provider}", next.providerId)}</span>);
                      }
                    });
                  }}
                />
              ) : null}
            </section>

            {grouped.map(({ section, rows }) => (
              <section key={section} className="space-y-3">
                <h2 className="text-sm font-medium">{t(sectionKey(section))}</h2>
                <div className="space-y-3">
                  {rows.map((row) => {
                    const disabled = row.uiStatus !== "editable";
                    const value = data?.values[row.storageKey];
                    return (
                      <div
                        key={row.id}
                        data-testid={`field-${row.id}`}
                        data-ui-status={row.uiStatus}
                        className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-[minmax(0,1fr)_220px] md:items-center"
                      >
                        <div className="space-y-1">
                          <Label htmlFor={row.id} className="text-sm">{t(fieldKey(row.id))}</Label>
                          <p className="text-xs text-muted-foreground">{row.area}</p>
                          <div className="flex flex-wrap gap-2">
                            <StatusBadge status={row.uiStatus} />
                            {disabled ? <span className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</span> : null}
                            {specFor(row.storageKey)?.positiveOnly ? (
                              <span className="text-xs text-muted-foreground" data-testid={`channel-limitation-${row.id}`}>{t("channelOffLimitation")}</span>
                            ) : null}
                            <span className="text-xs text-muted-foreground">{t("casVersion")} {data?.versions[row.storageKey] ?? 0}</span>
                          </div>
                        </div>
                        <FieldControl
                          row={row}
                          value={value}
                          disabled={disabled}
                          options={row.storageKey === WRITER_EFFORT ? WRITER_EFFORT_CHOICES_BY_PROVIDER[String(data?.values[WRITER_PROVIDER] ?? "")] : undefined}
                          onChange={(next) => { if (!disabled) void save(row, next); }}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
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
                            {run.cliReceiptJson ? t("openReceipt") : null}
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
                        {(attempt.cliReceiptJson ?? run.cliReceiptJson) ? t("openReceipt") : null}
                      </TableCell>
                    </TableRow>
                    ));
                  })}
                </TableBody>
              </Table>
            )}
            <div data-testid="cli-receipt" className="space-y-3">
              {data?.runs.flatMap((run) => {
                const seen = new Set<string>();
                const items: Array<{ id: string; json: string }> = [];
                for (const attempt of run.attempts) {
                  if (!attempt.cliReceiptJson || seen.has(attempt.cliReceiptJson)) continue;
                  seen.add(attempt.cliReceiptJson);
                  items.push({ id: attempt.id, json: attempt.cliReceiptJson });
                }
                if (run.cliReceiptJson && !seen.has(run.cliReceiptJson)) {
                  items.push({ id: run.id, json: run.cliReceiptJson });
                }
                return items.map((item) => (
                  <div key={item.id} className="space-y-2" data-testid={`cli-receipt-${item.id}`}>
                    <h2 className="text-sm font-medium">{t("cliReceipt")} {item.id}</h2>
                    <SourceCode content={item.json} path={`cli-receipt-${item.id}.json`} overflow="scroll" />
                    <span className="sr-only">{item.json}</span>
                  </div>
                ));
              })}
            </div>
            <div>
              <h2 className="text-sm font-medium">{t("unapplied")}</h2>
              {data?.unapplied.length ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                  {data.unapplied.map((item) => <li key={item.key}>{item.key}: {unappliedReason(item.reason)}</li>)}
                </ul>
              ) : <p className="text-xs text-muted-foreground">{t("noUnapplied")}</p>}
            </div>
            {(resultPatch || resultSource) ? (
              <div className="space-y-2" data-testid="writer-result">
                <h2 className="text-sm font-medium">{t("result")}</h2>
                {resultPatch ? <Diff patch={resultPatch} path="writer-output.txt" view="unified" /> : null}
                {resultSource ? <SourceCode content={resultSource} path="acceptance.json" overflow="scroll" /> : null}
                {resultSource ? <span className="sr-only">{resultSource}</span> : null}
              </div>
            ) : null}
            {data?.cliReceiptJson && !data.runs.some((run) => run.cliReceiptJson || run.attempts.some((attempt) => attempt.cliReceiptJson)) ? (
              <div className="space-y-2">
                <h2 className="text-sm font-medium">{t("cliReceipt")}</h2>
                <SourceCode content={data.cliReceiptJson} path="cli-receipt.json" overflow="scroll" />
                <span className="sr-only">{data.cliReceiptJson}</span>
              </div>
            ) : null}
            <p className="sr-only">{[...RUN_STATES, ...ATTEMPT_STATES].join(" ")}</p>
          </TabsContent>

          <TabsContent value="install" forceMount={true} className="space-y-3" hidden={tab !== "install"} data-testid="install-panel">
            {!data?.hostId ? <p className="text-sm text-muted-foreground">{t("hostMissing")}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void runStack("detect")}>{t("detect")}</Button>
              <Button size="sm" data-testid="install-stack" onClick={() => { setPendingOp("install"); setConfirmOpen(true); }}>{t("install")}</Button>
              <Button size="sm" variant="outline" onClick={() => { setPendingOp("connect"); setConfirmOpen(true); }}>{t("connectOpencode")}</Button>
              <Button size="sm" variant="destructive" onClick={() => { setPendingOp("rollback"); setConfirmOpen(true); }}>{t("rollback")}</Button>
            </div>
            <div className="space-y-1">
              <Label>{t("snapshotPath")}</Label>
              <Input value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)} />
            </div>
            {data?.lastReceiptJson ? (
              <div className="space-y-2" data-testid="install-receipt">
                <h2 className="text-sm font-medium">{t("installReceipt")}</h2>
                <SourceCode content={data.lastReceiptJson} path="install-receipt.json" overflow="scroll" />
                <span className="sr-only">{data.lastReceiptJson}</span>
              </div>
            ) : null}
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
      </div>
    </div>
  );
}
