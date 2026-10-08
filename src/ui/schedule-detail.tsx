import { useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { ErrandDefaultView, ScheduleView } from "../schedule/views";
import { Pill } from "./pill";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";
import { definitionWithTask, machineName, modelFieldsOf, withModelFields, type ModelFields } from "./schedule-model";
import { errorText, fill, whenText } from "./schedule-parts";
import { StepModels, WhoLine, WhoPicker, costText, defaultSeed } from "./schedule-who";

/**
 * One scheduled task in full, in place: what is sent to the agent (the whole errand text, or a script's command with its machine and
 * folder), who runs it and what that costs, and where it runs. The text, the command, the machine, the folder and the model are editable;
 * Save sends the same definition `schedule_upsert` always takes, with the id, so the schedule keeps its history and its place.
 */
type Hosts = Array<{ id: string; name: string; connected: boolean }>;
type Draft = { text: string; command: string; hostId: string; cwd: string; fields: ModelFields };

const AREA = "w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-sm";

function baseOf(schedule: ScheduleView): Draft {
  const task = schedule.task;
  return {
    text: task.kind === "errand" ? task.task : "", command: task.kind === "script" ? task.command : "", hostId: task.kind === "script" ? task.hostId : "",
    cwd: task.kind === "script" ? task.cwd : "", fields: modelFieldsOf(task),
  };
}

function taskOf(schedule: ScheduleView, draft: Draft): ScheduleView["task"] {
  const task = schedule.task;
  if (task.kind === "errand") return withModelFields({ ...task, task: draft.text }, draft.fields);
  if (task.kind === "script") return { ...task, command: draft.command, hostId: draft.hostId, cwd: draft.cwd };
  return task;
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-2" data-testid={testId}><h3 className="text-sm font-medium">{title}</h3>{children}</section>;
}

export function ScheduleDetail({ schedule, hosts, errandDefault, onBack, onEdit, onHistory, onChanged }: {
  schedule: ScheduleView; hosts: Hosts; errandDefault: ErrandDefaultView | undefined; onBack: () => void; onEdit: () => void; onHistory: () => void; onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useMemo(() => baseOf(schedule), [schedule]);
  const [edited, setEdited] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const draft = edited ?? base;
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(base);
  const change = (patch: Partial<Draft>) => { setSaved(false); setEdited({ ...draft, ...patch }); };
  const { task, where } = schedule;

  const save = async () => {
    setBusy(true); setFailure(null);
    try {
      const result = await rpc.call("schedule_upsert", { definition: definitionWithTask(schedule, taskOf(schedule, draft)) });
      if (result.ok) { setEdited(null); setSaved(true); onChanged(); }
      else setFailure(result.problems.join("; ") || fill(t("schActionError"), { reason: "?" }));
    } catch (cause) { setFailure(fill(t("schActionError"), { reason: errorText(cause) })); } finally { setBusy(false); }
  };

  const machines = hosts.some((host) => host.id === draft.hostId) ? hosts : [...hosts, { id: draft.hostId, name: draft.hostId, connected: false }];
  const place = where?.sectionName ? fill(t("schWhereSection"), { name: where.sectionName, path: where.sectionPath ?? "" }) : t("schWhereSectionNone");

  return (
    <Surface testId="schedule-detail">
      <SurfaceHeader className="flex-wrap justify-between gap-2">
        <h2 className="min-w-0 break-words text-sm font-medium">{fill(t("schDetailTitle"), { name: schedule.name })}</h2>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="sch-detail-edit" onClick={onEdit}>{t("schEdit")}</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="sch-detail-history" onClick={onHistory}>{t("schHistory")}</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="sch-detail-back" onClick={onBack}>‹ {t("schBack")}</Button>
        </div>
      </SurfaceHeader>
      <SurfaceBody>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill tone="muted" testId="sch-detail-kind">{t(`schKind_${task.kind}` as I18nKey)}</Pill>
          <span className="min-w-0 break-words" data-testid="sch-detail-when">{whenText(schedule.when)}</span>
        </div>

        {task.kind === "errand" ? (
          <Section title={t("schWhatTitle")} testId="sch-what">
            <textarea className={AREA} rows={Math.min(16, Math.max(5, draft.text.split("\n").length + 1))} data-testid="sch-what-text" aria-label={t("schWhatTitle")} value={draft.text}
              disabled={busy} onChange={(event) => change({ text: event.target.value })} />
          </Section>
        ) : null}
        {task.kind === "script" ? (
          <Section title={t("schWhatScriptTitle")} testId="sch-what">
            <textarea className={`${AREA} font-mono`} rows={Math.min(16, Math.max(4, draft.command.split("\n").length + 1))} data-testid="sch-what-command" aria-label={t("schFormCommand")} value={draft.command}
              disabled={busy} onChange={(event) => change({ command: event.target.value })} />
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <span className="block text-xs font-medium" id="sch-what-host-label">{t("schFormHost")}</span>
                <Select value={draft.hostId} disabled={busy} onValueChange={(value) => change({ hostId: value })}>
                  <SelectTrigger aria-labelledby="sch-what-host-label" className="h-8 w-full text-sm" data-testid="sch-what-host"><SelectValue /></SelectTrigger>
                  <SelectContent>{machines.map((host) => <SelectItem key={host.id} value={host.id}>{host.connected ? host.name : fill(t("schFormHostOffline"), { name: host.name })}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1">
                <label className="block text-xs font-medium" htmlFor="sch-what-cwd">{t("schFormCwd")}</label>
                <Input id="sch-what-cwd" className="h-8 font-mono text-sm" data-testid="sch-what-cwd" value={draft.cwd} disabled={busy} onChange={(event) => change({ cwd: event.target.value })} />
              </div>
            </div>
          </Section>
        ) : null}
        {task.kind === "workflow" ? (
          <Section title={t("schWhatWorkflowTitle")} testId="sch-what">
            <p className="text-xs text-muted-foreground">{t("schWhatWorkflowNote")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 font-mono text-[11px] leading-4" data-testid="sch-what-workflow">{task.workflowId}{"\n"}{JSON.stringify(task.inputs, null, 2)}</pre>
          </Section>
        ) : null}

        <Section title={t("schWhoTitle")} testId="sch-who-section">
          {task.kind === "errand" ? <>
            {schedule.model ? <WhoLine model={schedule.model} testId="sch-who-now" /> : null}
            <WhoPicker projectId={schedule.projectId} fields={draft.fields} resolved={schedule.model} fallback={defaultSeed(errandDefault?.effective)} disabled={busy} onChange={(fields) => change({ fields })} />
            {schedule.cost ? <p className="break-words text-sm" data-testid="sch-cost">{costText(schedule.cost)}</p> : null}
          </> : null}
          {task.kind === "script" ? <p className="text-sm text-muted-foreground" data-testid="sch-who-script">{t("schWhoScript")}</p> : null}
          {task.kind === "workflow" ? <>
            <p className="text-sm text-muted-foreground" data-testid="sch-who-workflow">{t("schWhoWorkflow")}</p>
            <StepModels workflowId={task.workflowId} projectId={schedule.projectId} />
          </> : null}
        </Section>

        <Section title={t("schWhereTitle")} testId="sch-where">
          <ul className="space-y-0.5 text-sm">
            <li className="break-words" data-testid="sch-where-project">{fill(t("schWhereProject"), { name: where?.projectName ?? schedule.projectId })}</li>
            <li className="break-words" data-testid="sch-where-section">{place}</li>
            <li className="break-words" data-testid="sch-where-host">{machineName(where) ? fill(t("schWhereHost"), { name: machineName(where)! }) : t("schWhereHostNone")}</li>
            {where?.cwd ? <li className="break-all font-mono text-xs" data-testid="sch-where-cwd">{fill(t("schWhereCwd"), { path: where.cwd })}</li> : null}
          </ul>
          {task.kind !== "script" ? <p className="text-xs text-muted-foreground">{t("schWhereFixed")}</p> : null}
        </Section>

        {failure ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="sch-detail-error">{failure}</p> : null}
        {saved && !dirty ? <p className="text-xs text-muted-foreground" role="status" data-testid="sch-detail-saved">{t("schDetailSaved")}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" className="lp-accent h-8 px-3 text-sm" disabled={!dirty || busy} data-testid="sch-detail-save" onClick={() => void save()}>{busy ? t("schFormSaving") : t("schDetailSave")}</Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-sm" disabled={!dirty || busy} data-testid="sch-detail-revert" onClick={() => { setEdited(null); setFailure(null); }}>{t("schDetailRevert")}</Button>
          {dirty ? <span className="text-xs text-muted-foreground" data-testid="sch-detail-dirty">{t("schDetailDirty")}</span> : null}
        </div>
      </SurfaceBody>
    </Surface>
  );
}
