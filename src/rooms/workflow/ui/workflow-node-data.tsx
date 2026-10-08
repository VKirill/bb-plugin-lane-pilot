import { useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import type { ViewEdge, ViewNode } from "../view";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { pickRun, runView, stepStatus, type NodeRun, type RunSnapshot, type RunStep } from "./workflow-run";

/**
 * The panel of a selected step, in the way n8n shows one: «Parameters» (what the step is and, in the editor, its form), «Inputs» and «Outputs» (the data
 * the step was given and gave in the latest run, or the fields it is declared to take and give while there has been none), and «Last run» (how it went).
 */
type Call = (method: string, input: unknown) => Promise<unknown>;

const STEP_PILL: Record<string, string> = { pending: "lp-pill-muted", running: "lp-pill-info", waiting: "lp-pill-neutral", done: "lp-pill-success", failed: "lp-pill-danger", skipped: "lp-pill-muted" };
const NODE_KEY: Record<string, I18nKey> = { pending: "wfNode_pending", running: "wfNode_running", waiting: "wfNode_waiting", done: "wfNode_done", failed: "wfNode_failed", skipped: "wfNode_skipped" };
const when = (at: number | null) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");

/** The latest run a workflow has had, read for the panel when no run is on screen: the statuses and steps by canvas key, and which run it is. */
export type LatestRun = { runId: string; at: number; states: ReadonlyMap<string, NodeRun> };

export function useLatestRun(workflowId: string | null, projectId: string | null, signature: string): LatestRun | null {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [latest, setLatest] = useState<LatestRun | null>(null);
  useEffect(() => {
    if (!workflowId) { setLatest(null); return; }
    let live = true;
    void (async () => {
      try {
        const detail = (await rpc.call("workflow_get", { id: workflowId, ...(projectId ? { projectId } : {}) })) as { workflow: { runs: Array<{ id: string; status: string; createdAt: number }> } | null };
        const pick = detail.workflow ? pickRun(detail.workflow.runs) : null;
        if (!pick) { if (live) setLatest(null); return; }
        const shot = (await rpc.call("workflow_run_snapshot", { runId: pick.id })) as { snapshot: RunSnapshot | null };
        if (live) setLatest(shot.snapshot ? { runId: pick.id, at: pick.createdAt, states: runView(shot.snapshot).runs } : null);
      } catch { if (live) setLatest(null); }
    })();
    return () => { live = false; };
  }, [rpc, workflowId, projectId, signature]);
  return latest;
}

// ------------------------------------------------------------------ values

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_INLINE = 90;

/** One value of a step's data: short ones inline, the rest in a scrolling block. A value the server cut to a preview says so. */
function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="lp-wf-data-value" data-empty="1">–</span>;
  if (isRecord(value) && value.truncated === true && typeof value.preview === "string") {
    return <div className="lp-wf-data-value"><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 text-[11px] leading-4">{value.preview}</pre><p className="mt-0.5 text-muted-foreground">{t("wfNodeOutputTruncated")}</p></div>;
  }
  if (typeof value === "string" && value.length <= MAX_INLINE && !value.includes("\n")) return <span className="lp-wf-data-value">{value || "''"}</span>;
  if (typeof value === "number" || typeof value === "boolean") return <span className="lp-wf-data-value">{String(value)}</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="lp-wf-data-value max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 text-[11px] leading-4">{text}</pre>;
}

function Rows({ rows, testId }: { rows: ReadonlyArray<readonly [string, unknown]>; testId: string }) {
  return (
    <ul className="lp-wf-data" data-testid={testId}>
      {rows.map(([key, value]) => (
        <li key={key} className="lp-wf-data-row" data-testid={`${testId}-${key}`}>
          <span className="lp-wf-data-key">{key}</span>
          <ValueCell value={value} />
        </li>
      ))}
    </ul>
  );
}

const Note = ({ children, testId }: { children: ReactNode; testId?: string }) => <p className="text-xs text-muted-foreground" data-testid={testId}>{children}</p>;
const Heading = ({ children }: { children: ReactNode }) => <p className="mb-1 text-xs font-medium">{children}</p>;

// ------------------------------------------------------------------ the tabs

export type NodeDataProps = {
  node: ViewNode;
  /** The connections that come into this step: what they carry is what it is given. */
  incoming: readonly ViewEdge[];
  /** How the step went in the run on screen, or in the latest run (`from` says which). */
  run: NodeRun | null;
  from: { runId: string; at: number } | null;
  definitionOnly: boolean;
  onOpenThread: (threadId: string) => void;
  rerun?: { busy: boolean; error: string | null; onRerun: () => void };
};

function pickStep(run: NodeRun | null, visit: number | null): RunStep | null {
  if (!run || !run.steps.length) return null;
  return run.steps.find((step) => step.visit === visit) ?? run.steps[run.steps.length - 1]!;
}

/** The visit chooser: a step that ran several times (a loop) shows the data of the one picked, the last by default. */
function Visits({ run, visit, onVisit }: { run: NodeRun; visit: number | null; onVisit: (visit: number) => void }) {
  const visits = [...new Set(run.steps.map((step) => step.visit))];
  if (visits.length < 2) return null;
  const shown = visit ?? visits[visits.length - 1];
  return (
    <div className="lp-seg" role="group" aria-label={t("wfDataVisits")} data-testid="wf-data-visits">
      {visits.map((number) => <button key={number} type="button" className="lp-seg-item px-2 py-0.5 text-xs" aria-pressed={shown === number} data-testid={`wf-data-visit-${number}`} onClick={() => onVisit(number)}>{t("wfDataVisit").replace("{n}", String(number))}</button>)}
    </div>
  );
}

const Provenance = ({ from }: { from: NodeDataProps["from"] }) => (from ? <Note testId="wf-data-from">{t("wfDataFromRun").replace("{when}", when(from.at))}</Note> : null);

function InputsTab({ incoming, run, from, definitionOnly, visit, onVisit }: NodeDataProps & { visit: number | null; onVisit: (visit: number) => void }) {
  const step = pickStep(run, visit);
  const input = step && isRecord(step.input) ? step.input : null;
  const given = input && isRecord(input.with) ? Object.entries(input.with) : [];
  const via = input && isRecord(input.via) && typeof input.via.mode === "string" ? input.via.mode : null;
  const declared = incoming.flatMap((edge) => edge.carries.map((name) => [name, t("wfDataFromNode").replace("{from}", edge.from === "$start" ? t("wfDataStartName") : edge.from)] as const));
  return (
    <div className="space-y-2" data-testid="wf-node-inputs">
      {run ? <Visits run={run} visit={visit} onVisit={onVisit} /> : null}
      <Provenance from={from} />
      {step ? (
        <>
          {given.length ? <div><Heading>{t("wfDataGiven")}</Heading><Rows rows={given} testId="wf-input-rows" /></div> : null}
          {input && "item" in input && input.item !== undefined ? <div><Heading>{t("wfDataItem")}</Heading><Rows rows={[[t("wfDataItemRow"), input.item]]} testId="wf-input-item" /></div> : null}
          {via && via !== "artifact" ? <Note>{t("wfDataCameBy").replace("{mode}", via)}</Note> : null}
          {!given.length && !(input && input.item !== undefined) ? <Note testId="wf-data-empty">{t("wfDataNothing")}</Note> : null}
        </>
      ) : (
        <>
          <Note testId="wf-data-declared-note">{definitionOnly && !from ? t("wfDataNoRun") : t("wfLastRunNone")}</Note>
          {declared.length ? <div><Heading>{t("wfDataFromEdges")}</Heading><Rows rows={declared} testId="wf-input-declared" /></div> : null}
        </>
      )}
    </div>
  );
}

function OutputsTab({ node, run, from, definitionOnly, visit, onVisit }: NodeDataProps & { visit: number | null; onVisit: (visit: number) => void }) {
  const step = pickStep(run, visit);
  const output = step && isRecord(step.output) ? step.output : null;
  const declared = node.out;
  const rows = output ? [...declared.filter((name) => name in output), ...Object.keys(output).filter((name) => !declared.includes(name))].map((name) => [name, output[name]] as const) : [];
  return (
    <div className="space-y-2" data-testid="wf-node-outputs">
      {run ? <Visits run={run} visit={visit} onVisit={onVisit} /> : null}
      <Provenance from={from} />
      {step ? (
        <>
          {step.error ? <p className="break-words text-xs text-destructive-text" role="alert"><span className="font-medium">{t("wfNodeError")}: </span>{step.error}</p> : null}
          {rows.length ? <Rows rows={rows} testId="wf-output-rows" /> : output && output.truncated === true ? <ValueCell value={output} /> : <Note testId="wf-data-empty">{t("wfDataNothing")}</Note>}
        </>
      ) : (
        <>
          <Note testId="wf-data-declared-note">{definitionOnly && !from ? t("wfDataNoRun") : t("wfLastRunNone")}</Note>
          {declared.length ? <div><Heading>{t("wfDataDeclared")}</Heading><ul className="flex flex-wrap gap-1" data-testid="wf-output-declared">{declared.map((name) => <li key={name} className="lp-pill-muted rounded-full px-2 py-0.5 font-mono text-[11px]">{name}</li>)}</ul></div> : <Note>{t("wfDataNothing")}</Note>}
        </>
      )}
    </div>
  );
}

function LastRunTab({ run, from, definitionOnly, visit, onVisit, onOpenThread, rerun }: NodeDataProps & { visit: number | null; onVisit: (visit: number) => void }) {
  const step = pickStep(run, visit);
  if (!run || !step) return <div className="space-y-2" data-testid="wf-node-lastrun"><Note>{definitionOnly ? t("wfNodeNoRunDefinition") : t("wfNodeNoRun")}</Note></div>;
  const status = stepStatus(step.state);
  const took = step.startedAt && step.endedAt ? Math.max(0, Math.round((step.endedAt - step.startedAt) / 1000)) : null;
  return (
    <div className="space-y-2" data-testid="wf-node-lastrun">
      <Visits run={run} visit={visit} onVisit={onVisit} />
      <Provenance from={from} />
      <ul className="space-y-2">
        <li className="space-y-1.5 rounded-lg border border-[var(--lp-hairline)] p-2.5 text-xs" data-testid={`wf-step-${step.key}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{t("wfNodeStep").replace("{n}", String(run.steps.indexOf(step) + 1))}</span>
            <span className={`${STEP_PILL[status]} rounded-full px-2 py-0.5 text-[11px] font-medium`}>{t(NODE_KEY[status]!)}</span>
            {step.attempt > 1 ? <span className="text-muted-foreground">{t("wfNodeAttempt").replace("{n}", String(step.attempt))}</span> : null}
            <span className="ml-auto text-muted-foreground">{when(step.startedAt ?? null)}{took !== null ? ` · ${t("wfSecondsShort").replace("{n}", String(took))}` : ""}</span>
          </div>
          {step.awaiting ? <p className="text-muted-foreground">{t("wfNodeAwaiting").replace("{what}", step.awaiting)}</p> : null}
          {step.error ? <p className="break-words text-destructive-text" role="alert"><span className="font-medium">{t("wfNodeError")}: </span>{step.error}</p> : null}
          {step.handoff ? <p className="break-words"><span className="font-medium">{t("wfNodeHandoff")}: </span>{step.handoff}</p> : null}
          {step.threadId ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" data-testid={`wf-open-thread-${step.key}`} onClick={() => onOpenThread(step.threadId!)}>{t("wfNodeOpenThread")}</Button> : null}
        </li>
      </ul>
      {rerun ? (
        <div className="space-y-1">
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2.5 text-xs" disabled={rerun.busy} data-testid="wf-rerun-node" onClick={rerun.onRerun}>
            {rerun.busy ? t("wfRerunning") : t("wfRerunNode")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("wfRerunHint")}</p>
          {rerun.error ? <p className="break-words text-xs text-destructive-text" role="alert" data-testid="wf-rerun-error">{t("wfRerunError").replace("{reason}", rerun.error)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export type PanelTab = { id: "params" | "inputs" | "outputs" | "lastrun"; label: string; content: ReactNode };

/** The three data tabs of a step, ready to sit after its parameters. */
export function dataTabs(props: NodeDataProps, visit: number | null, onVisit: (visit: number) => void): PanelTab[] {
  return [
    { id: "inputs", label: t("wfTabInputs"), content: <InputsTab {...props} visit={visit} onVisit={onVisit} /> },
    { id: "outputs", label: t("wfTabOutputs"), content: <OutputsTab {...props} visit={visit} onVisit={onVisit} /> },
    { id: "lastrun", label: t("wfTabLastRun"), content: <LastRunTab {...props} visit={visit} onVisit={onVisit} /> },
  ];
}

/**
 * The panel itself: a header with the step's name, a row of tabs, the body of the tab picked. The tab chosen stays while the owner goes from one step
 * to another (the caller keys the data by node, the tab is kept here). `narrow` turns it into the bottom sheet.
 */
export function SidePanel({ title, subtitle, onClose, narrow, testId, tabs, initial = "params" }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; narrow: boolean; testId: string; tabs: readonly PanelTab[]; initial?: PanelTab["id"];
}) {
  const [tab, setTab] = useState<PanelTab["id"]>(initial);
  const active = tabs.find((item) => item.id === tab) ?? tabs[0]!;
  return (
    <Surface testId={testId} aria-label={typeof title === "string" ? title : undefined} className={narrow ? "lp-wf-sheet" : undefined} data-narrow={narrow ? "1" : "0"}>
      <SurfaceHeader className="justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-sm font-medium">{title}</h3>{subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}</div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={onClose}>{t("wfNodeClose")}</Button>
      </SurfaceHeader>
      <SurfaceBody className="space-y-3">
        <div className="lp-seg lp-wf-tabs" role="tablist" aria-label={t("wfTabsLabel")} data-testid="wf-node-tabs">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" className="lp-seg-item lp-wf-tab" aria-selected={active.id === item.id} aria-pressed={active.id === item.id} data-testid={`wf-tab-${item.id}`} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-3" data-testid={`wf-tabpanel-${active.id}`}>{active.content}</div>
      </SurfaceBody>
    </Surface>
  );
}
