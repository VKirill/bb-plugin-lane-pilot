import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Button,
  CONTROL_H,
  Icon,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  type StatusPillTone,
} from "@lane-pilot/ui-kit";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { PROJECT_WORKFLOW_IDS } from "../../contracts/ui";
import { useLpRealtime, useLpRpcQuery } from "../../ui-shell/ui";

type InputField = NonNullable<z.infer<(typeof rpcContract)["workflow_get"]["output"]>["workflow"]>["inputs"][number];
/** The graph input form, injected by the page layer so `runs` does not import the `workflow` room. */
export type InputsFormView = ComponentType<{
  fields: InputField[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: Record<string, unknown>) => void;
  onCancel: () => void;
}>;
type RunRow = z.infer<(typeof rpcContract)["workflow_runs"]["output"]>["runs"][number];
type RunSnapshot = NonNullable<z.infer<(typeof rpcContract)["workflow_run_snapshot"]["output"]>["snapshot"]>;
type ProjectRunEntry = RunRow & { workflowId: string };
type SnapshotState =
  | { status: "loading" }
  | { status: "ready"; snapshot: RunSnapshot }
  | { status: "gone" }
  | { status: "error" };
type StageStatus = "done" | "running" | "waiting" | "failed" | "skipped" | "pending";

const ACTIVE_STATUSES = new Set(["running", "waiting"]);

const GRAPH_TITLE_KEYS: Record<string, I18nKey> = {
  "project-start": "consoleProjectGraph_project_start",
  "full-lifecycle": "consoleProjectGraph_full_lifecycle",
  "roadmap-driven": "consoleProjectGraph_roadmap_driven",
};

const STAGE_BAR_CLASS: Record<StageStatus, string> = {
  done: "bg-[var(--color-success,#16a34a)]",
  running: "animate-pulse bg-[var(--color-timeline-accent,#7c3aed)]",
  waiting: "bg-[var(--color-attention,#d97706)]",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/30",
  pending: "bg-border",
};

function runStatusTone(status: string): StatusPillTone {
  if (status === "succeeded") return "ok";
  if (status === "running") return "accent";
  if (status === "waiting") return "warn";
  if (status === "canceled" || status === "not_verified") return "muted";
  return "bad";
}

function runStatusLabel(status: string): string {
  const key = `wfRunStatus_${status}` as I18nKey;
  const text = t(key);
  return !text || text === key ? status : text;
}

function graphLabel(workflowId: string): string {
  const key = GRAPH_TITLE_KEYS[workflowId];
  return key ? t(key) : workflowId;
}

function formatWhen(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resolveStageStatus(states: string[]): StageStatus {
  if (states.includes("running")) return "running";
  if (states.includes("waiting")) return "waiting";
  if (states.some((s) => s === "failed" || s === "interrupted" || s === "canceled")) return "failed";
  if (states.length > 0 && states.every((s) => s === "skipped")) return "skipped";
  if (states.includes("succeeded")) return "done";
  return "pending";
}

function stageListFromSnapshot(snapshot: RunSnapshot, locale: Locale): Array<{ id: string; label: string; status: StageStatus }> {
  const stepsByNode = new Map<string, string[]>();
  for (const step of snapshot.steps) {
    stepsByNode.set(step.nodeId, [...(stepsByNode.get(step.nodeId) ?? []), step.state]);
  }
  const nodes = snapshot.graph.nodes.filter((node) => node.kind !== "start" && node.kind !== "end");
  if (nodes.length > 0) {
    return nodes.map((node) => ({
      id: node.id,
      label: node.title?.[locale] ?? node.label ?? node.id,
      status: resolveStageStatus(stepsByNode.get(node.id) ?? []),
    }));
  }
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string; status: StageStatus }> = [];
  for (const step of snapshot.steps) {
    if (seen.has(step.nodeId)) continue;
    seen.add(step.nodeId);
    out.push({
      id: step.nodeId,
      label: step.nodeId,
      status: resolveStageStatus(stepsByNode.get(step.nodeId) ?? []),
    });
  }
  return out;
}

/** Runs of the three project-level workflows (`project-start`, `full-lifecycle`, `roadmap-driven`) with lazy stage progress and start form. */
export function BigProjects({
  projectId,
  projects,
  locale,
  InputsForm,
}: {
  projectId: string | null;
  projects: ReadonlyArray<{ id: string; name: string }>;
  locale: Locale;
  InputsForm: InputsFormView;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotState>>({});

  const [startOpen, setStartOpen] = useState(false);
  const [selectedGraph, setSelectedGraph] = useState<(typeof PROJECT_WORKFLOW_IDS)[number]>("full-lifecycle");
  const [targetProjectId, setTargetProjectId] = useState<string>(projectId ?? projects[0]?.id ?? "");
  const [fields, setFields] = useState<InputField[] | null>(null);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setTargetProjectId(projectId ?? projects[0]?.id ?? "");
  }, [projectId, projects]);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const fetchRuns = useCallback(async (): Promise<ProjectRunEntry[]> => {
    const pages = await Promise.all(
      PROJECT_WORKFLOW_IDS.map(async (workflowId) => {
        const res = await rpc.call("workflow_runs", {
          id: workflowId,
          ...(projectId ? { projectId } : {}),
          limit: 20,
        });
        return res.runs.map((run) => ({ ...run, workflowId }));
      }),
    );
    return pages.flat().sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }, [rpc, projectId]);

  const pollMs = useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["workflow"], () => {
    void runsQuery.refetch();
  });
  const runsQuery = useLpRpcQuery<ProjectRunEntry[]>(null, { projectId }, { fetcher: fetchRuns, pollMs });
  const runs = runsQuery.data ?? null;

  useEffect(() => {
    if (!startOpen) return;
    let alive = true;
    setFields(null);
    setFieldsError(null);
    setSubmitError(null);
    const scope = targetProjectId ? { projectId: targetProjectId } : {};
    void rpc
      .call("workflow_get", { id: selectedGraph, ...scope })
      .then((res) => {
        if (!alive) return;
        if (!res.workflow) {
          setFields([]);
          setFieldsError(t("wfRunReason_unknown_workflow"));
          return;
        }
        setFields(res.workflow.inputs);
      })
      .catch((cause) => {
        if (!alive) return;
        setFields([]);
        setFieldsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [startOpen, selectedGraph, targetProjectId, rpc]);

  const toggleRun = (runId: string) => {
    const opening = !expanded.has(runId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(runId);
      else next.delete(runId);
      return next;
    });
    if (!opening || snapshots[runId]) return;
    setSnapshots((prev) => ({ ...prev, [runId]: { status: "loading" } }));
    void rpc
      .call("workflow_run_snapshot", { runId })
      .then((res) => {
        setSnapshots((prev) => ({
          ...prev,
          [runId]: res.snapshot ? { status: "ready", snapshot: res.snapshot } : { status: "gone" },
        }));
      })
      .catch(() => {
        setSnapshots((prev) => ({ ...prev, [runId]: { status: "error" } }));
      });
  };

  const handleStart = async (inputs: Record<string, unknown>) => {
    const resolvedProject = projectId ?? targetProjectId;
    if (!resolvedProject) {
      setSubmitError(t("consoleBigProjectsSelectProject"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await rpc.call("workflow_run", {
        id: selectedGraph,
        projectId: resolvedProject,
        inputs,
        source: "manual",
      });
      if (!res.ok) {
        const key = `wfRunReason_${res.reason ?? ""}` as I18nKey;
        const reason = t(key) === key ? (res.message ?? res.reason ?? "") : t(key);
        setSubmitError(t("wfRunRefused").replace("{reason}", reason));
        return;
      }
      setStartOpen(false);
      void runsQuery.refetch();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="big-projects">
      <PageHeader
        title={t("consoleWorkViewProjects")}
        actions={
          <Button
            type="button"
            size="sm"
            className="lp-accent"
            data-testid="big-projects-start"
            onClick={() => setStartOpen((open) => !open)}
          >
            <Icon name="Plus" className="mr-1.5 size-3.5" aria-hidden />
            {t("consoleBigProjectStart")}
          </Button>
        }
      />

      {startOpen ? (
        <Surface testId="big-projects-start-panel">
          <SurfaceHeader>
            <h2 className="text-sm font-medium">{t("consoleBigProjectStart")}</h2>
          </SurfaceHeader>
          <SurfaceBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium" htmlFor="big-project-graph">
                  {t("consoleBigProjectsGraphLabel")}
                </label>
                <Select
                  value={selectedGraph}
                  onValueChange={(next) => setSelectedGraph(next as (typeof PROJECT_WORKFLOW_IDS)[number])}
                >
                  <SelectTrigger id="big-project-graph" className={CONTROL_H} data-testid="big-projects-graph-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECT_WORKFLOW_IDS.map((id) => (
                      <SelectItem key={id} value={id} data-testid={`big-projects-graph-${id}`}>
                        {graphLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {projectId === null ? (
                <div className="space-y-1">
                  <label className="block text-xs font-medium" htmlFor="big-project-target">
                    {t("consoleBigProjectsProjectLabel")}
                  </label>
                  <Select value={targetProjectId} onValueChange={setTargetProjectId}>
                    <SelectTrigger
                      id="big-project-target"
                      className={CONTROL_H}
                      data-testid="big-projects-project-select"
                    >
                      <SelectValue placeholder={t("consoleBigProjectsSelectProject")} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((proj) => (
                        <SelectItem key={proj.id} value={proj.id}>
                          {proj.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            {fieldsError ? (
              <p className="text-xs text-destructive-text" role="alert">
                {fieldsError}
              </p>
            ) : null}
            {fields === null ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t("wfLoading")}
              </p>
            ) : (
              <InputsForm
                key={selectedGraph}
                fields={fields}
                busy={submitting}
                submitLabel={t("wfRunStart")}
                onSubmit={(inputs) => void handleStart(inputs)}
                onCancel={() => setStartOpen(false)}
              />
            )}
            {submitError ? (
              <p className="text-xs text-destructive-text" role="alert" data-testid="big-projects-start-error">
                {submitError}
              </p>
            ) : null}
          </SurfaceBody>
        </Surface>
      ) : null}

      {runsQuery.error && runs === null ? (
        <p className="text-sm text-destructive-text" role="alert" data-testid="big-projects-error">
          {t("consoleBigProjectsLoadError")}
        </p>
      ) : runs === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("boardLoading")}
        </p>
      ) : runs.length === 0 ? (
        <Surface testId="big-projects-empty">
          <SurfaceBody>
            <p className="text-sm text-muted-foreground">{t("consoleBigProjectsEmpty")}</p>
          </SurfaceBody>
        </Surface>
      ) : (
        <div className="space-y-3" data-testid="big-projects-list">
          {runs.map((run) => {
            const isExpanded = expanded.has(run.id);
            const snapState = snapshots[run.id];
            const active = ACTIVE_STATUSES.has(run.status);
            const snapProjectId =
              snapState?.status === "ready" ? snapState.snapshot.run.projectId : null;
            const projLabel = snapProjectId ? (projectNames.get(snapProjectId) ?? snapProjectId) : null;
            const stages =
              snapState?.status === "ready" ? stageListFromSnapshot(snapState.snapshot, locale) : [];

            return (
              <Surface key={run.id} testId={`big-project-run-${run.id}`}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  data-testid={`big-project-toggle-${run.id}`}
                  onClick={() => toggleRun(run.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-state-hover"
                >
                  <Icon
                    name={isExpanded ? "ChevronDown" : "ChevronRight"}
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {graphLabel(run.workflowId)}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
                      {active ? (
                        <span
                          aria-hidden
                          className="size-1.5 animate-pulse rounded-full bg-[var(--color-success,#16a34a)]"
                        />
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{formatWhen(run.createdAt, locale)}</span>
                      <span>{t("wfHistorySteps").replace("{n}", String(run.stepsUsed))}</span>
                      {run.costUsd > 0 ? <span>${run.costUsd.toFixed(2)}</span> : null}
                      {run.reason ? <span className="truncate">{run.reason}</span> : null}
                    </div>
                  </div>
                  <StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusPill>
                </button>

                {isExpanded ? (
                  <SurfaceBody className="border-t border-border/60 pt-3">
                    {!snapState || snapState.status === "loading" ? (
                      <p className="text-xs text-muted-foreground" role="status">
                        {t("boardLoading")}
                      </p>
                    ) : snapState.status === "gone" ? (
                      <p className="text-xs text-muted-foreground">{t("wfRunGone")}</p>
                    ) : snapState.status === "error" ? (
                      <p className="text-xs text-destructive-text">{t("consoleBigProjectsLoadError")}</p>
                    ) : (
                      <div className="space-y-2.5" data-testid={`big-project-stages-${run.id}`}>
                        {projLabel || snapState.snapshot.goals.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {projLabel ? <span>{projLabel}</span> : null}
                            {snapState.snapshot.goals[0]?.done_when ? (
                              <span className="truncate text-foreground">
                                {snapState.snapshot.goals[0].done_when}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {stages.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("consoleBigProjectsSnapshotEmpty")}
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {stages.map((stage) => (
                              <div
                                key={stage.id}
                                data-testid={`big-project-stage-${run.id}-${stage.id}`}
                                data-stage-status={stage.status}
                                className="min-w-[6.5rem] flex-1 space-y-1"
                              >
                                <div className={`h-1.5 w-full rounded-full ${STAGE_BAR_CLASS[stage.status]}`} />
                                <div className="truncate text-xs font-medium text-foreground">
                                  {stage.label}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  {t(`wfNode_${stage.status}` as I18nKey)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </SurfaceBody>
                ) : null}
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
