import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import type { ErrandDefaultView, ScheduleView } from "../schedule/views";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { modelFieldsOf, withModelFields, type ModelFields } from "./schedule-model";
import { errorText, fill, fmtTime } from "./schedule-parts";
import { WhoLine, WhoPicker, defaultSeed } from "./schedule-who";

type Preview = { problems: string[]; warnings: string[]; conflicts: Array<{ name: string; machine: string; windowMinutes: number }>; nextFires: number[] };
type Hosts = Array<{ id: string; name: string; connected: boolean }>;
type Kind = "workflow" | "errand" | "script";

const PRESETS = [
  ["daily", "0 9 * * *"], ["weekdays", "0 9 * * 1-5"], ["hourly", "0 * * * *"], ["monthly", "0 9 1 * *"],
] as const;
const AREA = "min-h-20 w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-sm";
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const toLocalInput = (at: number) => { const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="min-w-0 space-y-1"><label className="block text-xs font-medium" htmlFor={htmlFor}>{label}</label>{children}</div>;
}

/** The manual create / edit form. Every change is checked by `schedule_preview`, which shows the next runs and what is wrong before anything is saved. */
export function ScheduleForm({ projectId, projects, hosts, existing, errandDefault, initialRunAt, locale, onSaved, onCancel }: {
  projectId: string | null; projects: ReadonlyArray<{ id: string; name: string }>; hosts: Hosts; existing?: ScheduleView | null; errandDefault?: ErrandDefaultView | undefined;
  /** A one-time task prefilled for this moment (a click on a calendar day). */
  initialRunAt?: number | null; locale: Locale; onSaved: () => void; onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const task = existing?.task;
  const [project, setProject] = useState(existing?.projectId ?? projectId ?? projects[0]?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<Kind>(task?.kind ?? "errand");
  const [workflowId, setWorkflowId] = useState(task?.kind === "workflow" ? task.workflowId : "");
  const [inputsText, setInputsText] = useState(task?.kind === "workflow" ? JSON.stringify(task.inputs) : "{}");
  const [errandText, setErrandText] = useState(task?.kind === "errand" ? task.task : "");
  const [authorized, setAuthorized] = useState(task?.kind === "errand" ? task.authorized : false);
  const [fields, setFields] = useState<ModelFields>(task?.kind === "errand" ? modelFieldsOf(task) : {});
  const [accounts, setAccounts] = useState(task?.kind === "errand" ? (task.accounts ?? []).join(", ") : "");
  const [hostId, setHostId] = useState(task?.kind === "script" ? task.hostId : hosts[0]?.id ?? "");
  const [command, setCommand] = useState(task?.kind === "script" ? task.command : "");
  const [cwd, setCwd] = useState(task?.kind === "script" ? task.cwd : "/tmp");
  const [whenType, setWhenType] = useState<"cron" | "once">(existing ? existing.when.type : initialRunAt ? "once" : "cron");
  const [cron, setCron] = useState(existing?.when.type === "cron" ? existing.when.cron : "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(existing?.when.type === "cron" ? existing.when.timezone : zone());
  const [runAt, setRunAt] = useState(existing?.when.type === "once" ? toLocalInput(existing.when.runAt) : toLocalInput(initialRunAt ?? Date.now() + 3_600_000));
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let live = true;
    void rpc.call("workflow_list", { projectId: project }).then((result) => {
      if (!live) return;
      const rows = result.workflows.filter((row) => row.status === "published" && !row.internal).map((row) => ({ id: row.id, name: row.name[locale] || row.id }));
      setWorkflows(rows);
      setWorkflowId((current) => current || rows[0]?.id || "");
    }).catch(() => { if (live) setWorkflows([]); });
    return () => { live = false; };
  }, [project, rpc, locale]);

  const built = useMemo((): { definition: Record<string, unknown> } | { error: string } => {
    if (!project) return { error: t("schFormNeedProject") };
    let taskBody: Record<string, unknown>;
    if (kind === "workflow") {
      let inputs: unknown;
      try { inputs = JSON.parse(inputsText || "{}"); } catch { return { error: t("schFormBadJson") }; }
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return { error: t("schFormBadJson") };
      taskBody = { ...(task?.kind === "workflow" ? task : {}), kind, workflowId, inputs };
    } else if (kind === "errand") {
      taskBody = withModelFields({ ...(task?.kind === "errand" ? task : {}), kind, task: errandText, authorized, accounts: accounts.split(",").map((item) => item.trim()).filter(Boolean) } as Extract<ScheduleView["task"], { kind: "errand" }>, fields) as Record<string, unknown>;
    } else {
      taskBody = { ...(task?.kind === "script" ? task : {}), kind, hostId, command, cwd };
    }
    const when = whenType === "cron" ? { type: "cron", cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) } : { type: "once", runAt: new Date(runAt).getTime() };
    const policies = existing ? { missed: existing.missed, missedLimit: existing.missedLimit, overlap: existing.overlap, timeoutSec: existing.timeoutSec, maxFailures: existing.maxFailures } : {};
    return { definition: { ...(existing ? { id: existing.id } : {}), projectId: project, name: name.trim(), ...(existing?.description ? { description: existing.description } : {}), task: taskBody, when, ...policies } };
  }, [project, kind, workflowId, inputsText, errandText, authorized, accounts, fields, hostId, command, cwd, whenType, cron, timezone, runAt, name, existing, task]);

  const definition = "definition" in built ? built.definition : null;
  const definitionKey = definition ? JSON.stringify(definition) : "";
  useEffect(() => {
    if (!definition || !name.trim()) { setPreview(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void rpc.call("schedule_preview", { definition, next: 5 }).then((result) => { if (live) setPreview(result); }).catch((cause) => { if (live) setPreview({ problems: [errorText(cause)], warnings: [], conflicts: [], nextFires: [] }); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [definitionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!definition) return;
    setBusy(true); setFailure(null);
    try {
      const result = await rpc.call("schedule_upsert", { definition });
      if (result.ok) onSaved();
      else setFailure(result.problems.join("; ") || t("schActionError").replace("{reason}", "?"));
    } catch (cause) { setFailure(fill(t("schActionError"), { reason: errorText(cause) })); } finally { setBusy(false); }
  };

  const problems = [...("error" in built ? [built.error] : []), ...(preview?.problems ?? [])];
  const canSave = !busy && definition !== null && name.trim().length > 0 && !(preview?.problems.length);
  const kindItems: Kind[] = ["errand", "workflow", "script"];

  return (
    <Surface testId="schedule-form">
      <SurfaceHeader><h2 className="text-sm font-medium">{existing ? t("schFormTitleEdit") : t("schFormTitleNew")}</h2></SurfaceHeader>
      <SurfaceBody>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (canSave) void save(); }}>
          {!projectId && !existing ? (
            <Field label={t("schFormProject")} htmlFor="sch-project">
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="sch-project" className="h-8 w-full text-sm" data-testid="sch-project"><SelectValue /></SelectTrigger>
                <SelectContent>{projects.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label={t("schFormName")} htmlFor="sch-name"><Input id="sch-name" className="h-8 text-sm" data-testid="sch-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t("schFormKind")}>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("schFormKind")}>
              {kindItems.map((item) => (
                <Button key={item} type="button" size="sm" role="radio" aria-checked={kind === item} variant={kind === item ? "secondary" : "outline"} className="h-8 px-3 text-sm" data-testid={`sch-kind-${item}`}
                  disabled={!!existing && existing.task.kind !== item} onClick={() => setKind(item)}>{t(`schKind_${item}` as I18nKey)}</Button>
              ))}
            </div>
          </Field>

          {kind === "workflow" ? <>
            <Field label={t("schFormWorkflow")} htmlFor="sch-workflow">
              {workflows.length === 0 && !workflowId ? <p className="text-xs text-muted-foreground" data-testid="sch-workflow-none">{t("schFormWorkflowNone")}</p> : (
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger id="sch-workflow" className="h-8 w-full text-sm" data-testid="sch-workflow"><SelectValue /></SelectTrigger>
                  <SelectContent>{(workflows.some((item) => item.id === workflowId) ? workflows : [...workflows, { id: workflowId, name: workflowId }]).map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t("schFormInputs")} htmlFor="sch-inputs"><textarea id="sch-inputs" className={`${AREA} font-mono`} rows={3} data-testid="sch-inputs" value={inputsText} onChange={(event) => setInputsText(event.target.value)} /></Field>
          </> : null}

          {kind === "errand" ? <>
            <Field label={t("schFormErrandText")} htmlFor="sch-errand"><textarea id="sch-errand" className={AREA} rows={4} data-testid="sch-errand" value={errandText} onChange={(event) => setErrandText(event.target.value)} /></Field>
            <Field label={t("schWhoTitle")}>
              {existing?.model ? <WhoLine model={existing.model} testId="sch-form-who-now" /> : null}
              <WhoPicker projectId={project || null} fields={fields} resolved={existing?.model ?? null} fallback={defaultSeed(errandDefault?.effective)} testId="sch-form-who" onChange={setFields} />
            </Field>
            <label className="flex items-center gap-2 text-sm"><Switch checked={authorized} onCheckedChange={setAuthorized} data-testid="sch-authorized" aria-label={t("schFormAuthorized")} />{t("schFormAuthorized")}</label>
            <Field label={t("schFormAccounts")} htmlFor="sch-accounts"><Input id="sch-accounts" className="h-8 font-mono text-sm" data-testid="sch-accounts" value={accounts} onChange={(event) => setAccounts(event.target.value)} /></Field>
          </> : null}

          {kind === "script" ? <>
            <Field label={t("schFormHost")} htmlFor="sch-host">
              <Select value={hostId} onValueChange={setHostId}>
                <SelectTrigger id="sch-host" className="h-8 w-full text-sm" data-testid="sch-host"><SelectValue /></SelectTrigger>
                <SelectContent>{hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.connected ? host.name : fill(t("schFormHostOffline"), { name: host.name })}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={t("schFormCommand")} htmlFor="sch-command"><textarea id="sch-command" className={`${AREA} font-mono`} rows={3} data-testid="sch-command" value={command} onChange={(event) => setCommand(event.target.value)} /></Field>
            <Field label={t("schFormCwd")} htmlFor="sch-cwd"><Input id="sch-cwd" className="h-8 font-mono text-sm" data-testid="sch-cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} /></Field>
          </> : null}

          <Field label={t("schFormWhen")}>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("schFormWhen")}>
              {(["cron", "once"] as const).map((item) => (
                <Button key={item} type="button" size="sm" role="radio" aria-checked={whenType === item} variant={whenType === item ? "secondary" : "outline"} className="h-8 px-3 text-sm" data-testid={`sch-when-${item}`}
                  onClick={() => setWhenType(item)}>{t(item === "cron" ? "schFormWhenCron" : "schFormWhenOnce")}</Button>
              ))}
            </div>
          </Field>
          {whenType === "cron" ? <>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(([id, value]) => <Button key={id} type="button" size="sm" variant={cron === value ? "secondary" : "ghost"} className="h-7 px-2 text-xs" data-testid={`sch-preset-${id}`} onClick={() => setCron(value)}>{t(`schFormPreset_${id}` as I18nKey)}</Button>)}
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label={t("schFormCron")} htmlFor="sch-cron"><Input id="sch-cron" className="h-8 font-mono text-sm" data-testid="sch-cron" value={cron} onChange={(event) => setCron(event.target.value)} /></Field>
              <Field label={t("schFormTimezone")} htmlFor="sch-tz"><Input id="sch-tz" className="h-8 text-sm" data-testid="sch-tz" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>
            </div>
          </> : (
            <Field label={t("schFormRunAt")} htmlFor="sch-runat"><Input id="sch-runat" type="datetime-local" className="h-8 text-sm" data-testid="sch-runat" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></Field>
          )}

          {problems.length ? <div role="alert" className="space-y-1 text-xs text-destructive-text" data-testid="sch-problems"><p className="font-medium">{t("schFormProblems")}</p><ul className="list-disc space-y-0.5 pl-4">{problems.map((line) => <li key={line} className="break-words">{line}</li>)}</ul></div> : null}
          {preview?.warnings.length || preview?.conflicts.length ? (
            <div className="space-y-1 text-xs" data-testid="sch-warnings"><p className="font-medium">{t("schFormWarnings")}</p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {preview.warnings.map((line) => <li key={line} className="break-words">{line}</li>)}
                {preview.conflicts.map((item) => <li key={`${item.name}:${item.machine}`} className="break-words">{fill(t("schCalConflict"), { machine: item.machine, n: item.windowMinutes })} ({item.name})</li>)}
              </ul>
            </div>
          ) : null}
          {preview?.nextFires.length ? <div className="space-y-1 text-xs" data-testid="sch-next-runs"><p className="font-medium">{t("schFormNextRuns")}</p><p className="font-mono text-muted-foreground">{preview.nextFires.map(fmtTime).join(" · ")}</p></div> : null}
          {failure ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="sch-save-error">{failure}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="lp-accent h-8 px-3 text-sm" disabled={!canSave} data-testid="sch-save">{busy ? t("schFormSaving") : t("schFormSave")}</Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-sm" onClick={onCancel} data-testid="sch-cancel">{t("schFormCancel")}</Button>
          </div>
        </form>
      </SurfaceBody>
    </Surface>
  );
}
