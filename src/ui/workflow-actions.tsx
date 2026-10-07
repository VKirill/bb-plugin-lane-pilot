import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;
type Detail = NonNullable<Output<"workflow_get">["workflow"]>;
export type InputField = Detail["inputs"][number];
export type TrialCase = NonNullable<Output<"workflow_dry_run">["result"]>;
type RunRow = Output<"workflow_runs">["runs"][number];

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const pillOf = (status: string) => status === "succeeded" ? "lp-pill-success" : status === "running" || status === "waiting" ? "lp-pill-info" : status === "canceled" ? "lp-pill-muted" : "lp-pill-danger";
const STATUS_KEY = (status: string): I18nKey => (["running", "waiting", "succeeded", "failed", "blocked", "interrupted", "canceled"].includes(status) ? `wfRunStatus_${status}` : "wfRunStatus_failed") as I18nKey;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The inputs of a workflow as typed in a form → the value the engine takes; a message when a field cannot be read. */
export function readInputs(fields: InputField[], values: Record<string, string | boolean>): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input: Record<string, unknown> = {}, errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.type === "boolean") { if (raw !== undefined) input[field.name] = raw === true; continue; }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) { if (field.required && field.default === undefined) errors[field.name] = t("wfTrialRequired").replace("{name}", field.name); continue; }
    if (field.type === "string" || field.type === "enum") { input[field.name] = text; continue; }
    try { input[field.name] = JSON.parse(text); } catch { errors[field.name] = t("wfTrialBadJson").replace("{name}", field.name); }
  }
  return { input, errors };
}

/** One control per declared input: text, number, switch, a choice, or JSON for lists and objects. */
export function InputsForm({ fields, busy, submitLabel, onSubmit, onCancel }: { fields: InputField[]; busy: boolean; submitLabel: string; onSubmit: (input: Record<string, unknown>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.flatMap((field) =>
    field.default === undefined ? [] : [[field.name, field.type === "boolean" ? field.default === true : typeof field.default === "string" ? field.default : JSON.stringify(field.default)]])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (name: string, value: string | boolean) => setValues((current) => ({ ...current, [name]: value }));
  const submit = () => {
    const read = readInputs(fields, values);
    setErrors(read.errors);
    if (!Object.keys(read.errors).length) onSubmit(read.input);
  };
  return (
    <form className="space-y-3" data-testid="wf-inputs-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {fields.length ? null : <p className="text-xs text-muted-foreground">{t("wfTrialNoInputs")}</p>}
      {fields.map((field) => {
        const id = `wf-input-${field.name}`;
        const control: ReactNode = field.type === "boolean"
          ? <Switch id={id} checked={values[field.name] === true} onCheckedChange={(next) => set(field.name, next)} data-testid={id} aria-label={field.name} />
          : field.type === "enum" && field.values
            ? (
              <Select value={typeof values[field.name] === "string" ? values[field.name] as string : ""} onValueChange={(next) => set(field.name, next)}>
                <SelectTrigger id={id} className="h-8 w-full text-sm" data-testid={id}><SelectValue /></SelectTrigger>
                <SelectContent>{field.values.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            )
            : <Input id={id} className="h-8 text-sm" data-testid={id} value={typeof values[field.name] === "string" ? values[field.name] as string : ""} onChange={(event) => set(field.name, event.target.value)}
              placeholder={["array", "object", "json"].includes(field.type) ? "JSON" : field.type} aria-invalid={errors[field.name] ? true : undefined} />;
        return (
          <div key={field.name} className="min-w-0 space-y-1">
            <label className="block text-xs font-medium" htmlFor={id}>{field.name}{field.required ? " *" : ""} <span className="font-normal text-muted-foreground">{field.type}</span></label>
            {control}
            {errors[field.name] ? <p className="break-words text-xs text-destructive-text" role="alert">{errors[field.name]}</p>
              : field.note ? <p className="break-words text-xs text-muted-foreground">{field.note}</p> : null}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="lp-accent h-8 px-3 text-sm" disabled={busy} data-testid="wf-inputs-submit">{submitLabel}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 px-3 text-sm" disabled={busy} onClick={onCancel} data-testid="wf-inputs-cancel">{t("wfTrialCancel")}</Button>
      </div>
    </form>
  );
}

/** What a trial run did: how it ended, the path it took, what was answered by stubs, the output, and what failed. */
export function TrialResult({ result, stubbed, onOpenRun }: { result: TrialCase; stubbed: string[]; onOpenRun?: (runId: string) => void }) {
  return (
    <div className="space-y-2 text-xs" data-testid="wf-trial-result">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`${result.green ? "lp-pill-success" : "lp-pill-danger"} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid="wf-trial-green">{result.green ? t("wfTrialGreen") : t("wfTrialRed")}</span>
        <span>{t("wfTrialStatus").replace("{status}", result.status)}</span>
        {result.reason ? <span className="break-words text-muted-foreground">{result.reason}</span> : null}
        {result.runId && onOpenRun ? <Button type="button" size="sm" variant="outline" className="lp-raised ml-auto h-7 px-2 text-xs" data-testid="wf-trial-open-run" onClick={() => onOpenRun(result.runId!)}>{t("wfTrialOpenRun")}</Button> : null}
      </div>
      {result.error ? <p className="break-words text-destructive-text" role="alert">{result.error}</p> : null}
      {result.path.length ? <p className="break-words"><span className="font-medium">{t("wfTrialPath")}: </span><span className="font-mono">{result.path.join(" > ")}</span></p> : null}
      {stubbed.length ? <p className="break-words"><span className="font-medium">{t("wfTrialStubbed")}: </span><span className="font-mono">{stubbed.join(", ")}</span></p> : null}
      {result.failures.length ? <div><p className="font-medium">{t("wfTrialFailures")}</p><ul className="list-disc space-y-0.5 pl-4 text-destructive-text">{result.failures.map((line) => <li key={line} className="break-words">{line}</li>)}</ul></div> : null}
      {result.output ? <div><p className="font-medium">{t("wfTrialOutput")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 font-mono text-[11px] leading-4">{JSON.stringify(result.output, null, 2)}</pre></div> : null}
    </div>
  );
}

type Panel = { kind: "dry" } | { kind: "tests" } | { kind: "requires" } | null;

/**
 * «Try it»: a dry run (the owner fills the workflow's inputs, every outside action is stubbed) and the tests of the workflow
 * with their receipt. A run on stubs is journaled under its own id; «Open this run» shows it in the graph.
 */
export function WorkflowTrials({ detail, projectId, onOpenRun, onChanged, extra }: {
  detail: Detail; projectId: string | null; onOpenRun: (runId: string) => void; onChanged: () => void; extra?: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dry, setDry] = useState<Output<"workflow_dry_run"> | null>(null);
  const [tests, setTests] = useState<Output<"workflow_run_tests"> | null>(null);
  const [needs, setNeeds] = useState<Output<"workflow_preflight"> | null>(null);
  const scope = projectId ? { projectId } : {};

  const runDry = async (input: Record<string, unknown>) => {
    setBusy(true); setError(null); setDry(null);
    try {
      const result = await rpc.call("workflow_dry_run", { id: detail.id, ...scope, input });
      if (!result.found) setError(t("wfTrialNotFound")); else setDry(result);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const runTests = async () => {
    setPanel({ kind: "tests" }); setBusy(true); setError(null); setTests(null);
    try {
      const result = await rpc.call("workflow_run_tests", { id: detail.id, ...scope });
      if (!result.found) setError(t("wfTrialNotFound")); else { setTests(result); onChanged(); }
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };

  const checkRequires = async () => {
    setPanel({ kind: "requires" }); setBusy(true); setError(null); setNeeds(null);
    try { setNeeds(await rpc.call("workflow_preflight", { id: detail.id, ...scope })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };

  return (
    <Surface testId="wf-trials">
      <SurfaceHeader className="flex-wrap justify-between">
        <h3 className="text-sm font-medium">{t("wfActionsHeading")}</h3>
        <div className="flex flex-wrap gap-2">
          {extra}
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={busy} data-testid="wf-dry-run"
            onClick={() => { setPanel({ kind: "dry" }); setDry(null); setError(null); }}>{t("wfDryRun")}</Button>
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={busy} data-testid="wf-check-requires" onClick={() => void checkRequires()}>
            {busy && panel?.kind === "requires" ? t("wfCheckingRequires") : t("wfCheckRequires")}
          </Button>
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={busy} data-testid="wf-run-tests" onClick={() => void runTests()}>
            {busy && panel?.kind === "tests" ? t("wfRunningTests") : t("wfRunTests")}
          </Button>
        </div>
      </SurfaceHeader>
      <SurfaceBody>
        <p className="text-xs text-muted-foreground">{t("wfDryRunHint")} {t("wfRunTestsHint")}</p>
      </SurfaceBody>
      {panel || error ? (
        <SurfaceBody>
          {error ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="wf-trial-error">{t("wfTrialError").replace("{error}", error)}</p> : null}
          {panel?.kind === "dry" ? (
            <>
              <p className="text-xs text-muted-foreground">{t("wfDryRunHint")}</p>
              {dry?.result ? <TrialResult result={dry.result} stubbed={dry.stubbed} onOpenRun={onOpenRun} />
                : busy ? <p className="text-xs text-muted-foreground" role="status">{t("wfDryRunning")}</p>
                  : <InputsForm fields={detail.inputs} busy={busy} submitLabel={t("wfTrialStart")} onSubmit={(input) => void runDry(input)} onCancel={() => setPanel(null)} />}
              {dry?.result ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPanel(null)}>{t("wfTrialCancel")}</Button> : null}
            </>
          ) : null}
          {panel?.kind === "requires" ? (
            <div className="space-y-2 text-xs" data-testid="wf-requires-result">
              <p className="font-medium">{t("wfRequiresHeading")}</p>
              {busy ? <p className="text-muted-foreground" role="status">{t("wfCheckingRequires")}</p> : null}
              {needs && !needs.issues.length ? <p>{t("wfRequiresOk")}</p> : null}
              {(["missing", "unverified"] as const).map((level) => {
                const rows = needs?.issues.filter((issue) => issue.level === level) ?? [];
                return rows.length ? (
                  <div key={level}>
                    <p className={level === "missing" ? "font-medium text-destructive-text" : "font-medium"}>{level === "missing" ? t("wfRequiresMissing") : t("wfRequiresUnverified")}</p>
                    <ul className="list-disc space-y-0.5 pl-4">{rows.map((issue) => <li key={`${issue.kind}:${issue.name}`} className="break-words" data-testid={`wf-requires-${level}-${issue.name}`}>{issue.message}</li>)}</ul>
                  </div>
                ) : null;
              })}
              {needs?.envRequests.length ? <p className="text-muted-foreground">{t("wfRequiresEnvHint")}</p> : null}
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPanel(null)}>{t("wfTrialCancel")}</Button>
            </div>
          ) : null}
          {panel?.kind === "tests" ? (
            <div className="space-y-2" data-testid="wf-tests-result">
              {busy ? <p className="text-xs text-muted-foreground" role="status">{t("wfRunningTests")}</p> : null}
              {tests ? <p className="text-xs">{t("wfTrialTestsResult").replace("{result}", tests.green ? t("wfTrialGreen") : t("wfTrialRed")).replace("{status}", tests.status ? t(`wfStatus_${tests.status}` as I18nKey) : "")}</p> : null}
              {tests?.cases.map((row) => (
                <div key={row.caseId} className="space-y-1 rounded-lg border border-[var(--lp-hairline)] p-2">
                  <p className="text-xs font-medium">{t("wfTrialCase").replace("{id}", row.caseId)}</p>
                  <TrialResult result={row} stubbed={row.stubbedCalls} onOpenRun={onOpenRun} />
                </div>
              ))}
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPanel(null)}>{t("wfTrialCancel")}</Button>
            </div>
          ) : null}
        </SurfaceBody>
      ) : null}
    </Surface>
  );
}

/** The workflow's runs, newest first, a page at a time; a click opens the run in the graph. */
export function RunHistory({ id, projectId, shownRunId, signature, onPick }: { id: string; projectId: string | null; shownRunId: string | null; signature: string; onPick: (runId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const scope = projectId ? { projectId } : {};

  const first = useCallback(async () => {
    try {
      const page = await rpc.call("workflow_runs", { id, ...scope, limit: 20 });
      setRows(page.runs); setMore(page.hasMore);
    } catch { /* the next signal reads again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectId, rpc]);
  useEffect(() => { void first(); }, [first, signature]);

  const older = async () => {
    const last = rows?.at(-1);
    if (!last) return;
    setLoading(true);
    try {
      const page = await rpc.call("workflow_runs", { id, ...scope, limit: 20, before: last.createdAt });
      setRows((current) => [...(current ?? []), ...page.runs]); setMore(page.hasMore);
    } catch { /* keep what is shown */ } finally { setLoading(false); }
  };

  return (
    <Surface testId="wf-history">
      <SurfaceHeader><h3 className="text-sm font-medium">{t("wfHistoryHeading")}</h3></SurfaceHeader>
      <SurfaceBody>
        {rows && !rows.length ? <p className="text-xs text-muted-foreground" data-testid="wf-history-none">{t("wfHistoryNone")}</p> : null}
        {rows?.length ? (
          <ul className="divide-y divide-border/60">
            {rows.map((row) => (
              <li key={row.id}>
                <button type="button" className={`flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${row.id === shownRunId ? "bg-state-hover" : ""}`}
                  data-testid={`wf-history-${row.id}`} aria-label={t("wfHistoryOpen")} onClick={() => onPick(row.id)}>
                  <span className={`${pillOf(row.status)} rounded-full px-2 py-0.5 text-[11px] font-medium`}>{t(STATUS_KEY(row.status))}</span>
                  <span>{when(row.createdAt)}</span>
                  <span className="text-muted-foreground">{t("wfHistorySteps").replace("{n}", String(row.stepsUsed))}</span>
                  {row.mode ? <span className="text-muted-foreground">{t("wfHistoryMode").replace("{mode}", row.mode)}</span> : null}
                  {row.costUsd > 0 ? <span className="text-muted-foreground">${row.costUsd.toFixed(2)}</span> : null}
                  {row.reason ? <span className="min-w-0 break-words text-muted-foreground">{row.reason}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {more ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={loading} data-testid="wf-history-more" onClick={() => void older()}>{t("wfHistoryMore")}</Button> : null}
      </SurfaceBody>
    </Surface>
  );
}
