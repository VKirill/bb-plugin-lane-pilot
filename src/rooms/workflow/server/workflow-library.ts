import { dirname } from "node:path";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { BUILTIN_SOURCES } from "../builtin";
import type { Field, Workflow } from "../schema";
import { sha256Text } from "../../storage/files";
import { parseGoals } from "../goals";
import { createStatusResolver } from "../../storage/ops-store";
import { globalWorkflowDir, loadWorkflowStore, nodeFileSource, projectWorkflowDir, type StoredWorkflow, type WorkflowFileSource, type WorkflowStore } from "../../storage/store";
import { workflowView, type WorkflowView } from "../view";
import type { ServerCore } from "../../core/server/core";
import type { Services } from "../../core/server/services";

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;
export type WorkflowSummary = Output<"workflow_list">["workflows"][number];
export type WorkflowStats = WorkflowSummary["stats"];
type ProjectState = Output<"workflow_list">["project"];

const FAILED = ["failed", "blocked", "interrupted"];
const RECENT_RUNS = 10;
const STEP_OUTPUT_LIMIT = 4_000;
const EVENT_TAIL = 80;

const field = (item: Field) => ({ name: item.name, type: item.type, required: item.required, ...(item.values ? { values: item.values } : {}), ...((item.description ?? item.note) ? { note: item.description ?? item.note } : {}),
  ...(item.default !== undefined ? { default: item.default } : {}) });

/** A big output goes to the screen as a preview: the journal keeps the whole value. */
export function clipJson(value: unknown, limit = STEP_OUTPUT_LIMIT): unknown {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value);
  return text.length <= limit ? value : { truncated: true, preview: text.slice(0, Math.floor(limit / 2.5)) };
}

const parseJson = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };

/**
 * The read side of the workflow screens: the library (built-in files, the hub's `~/.lane-pilot/workflows`, the project's
 * `.lane-pilot/workflows` read on the project's machine), run statistics from the journal, and a run as a live view.
 * Nothing here writes; the editor (W6) will add its saves next to these reads.
 */
export function createWorkflowLibrary(ctx: ServerCore, services: Pick<Services, "docsPlaces" | "workflowEngine">, options: { globalDir?: string } = {}) {
  const { db } = ctx;
  const globalDir = options.globalDir ?? globalWorkflowDir();
  const statuses = createStatusResolver(db);

  /** The project's workflow files, read once on its machine and served from memory to the store. */
  async function readProjectFiles(projectId: string): Promise<{ files: Map<string, string>; dir: string | null; state: ProjectState }> {
    const places = await services.docsPlaces(projectId).catch(() => []);
    const root = places.find((place) => place.scopes.length === 0) ?? places[0];
    if (!root) return { files: new Map(), dir: null, state: "no_machine" };
    try {
      const listed = await ctx.host.call("listWorkflowFiles", { requestedHostId: root.hostId, projectCwd: root.path }, { hostId: root.hostId, timeoutMs: 15_000 });
      return { files: new Map(listed.files.map((file) => [file.path, file.content])), dir: projectWorkflowDir(root.path), state: "ok" };
    } catch (cause) {
      ctx.log(`Lane Pilot workflow library: project files unavailable (${cause instanceof Error ? cause.message : String(cause)})`);
      return { files: new Map(), dir: null, state: "unavailable" };
    }
  }

  async function loadStore(projectId?: string): Promise<{ store: WorkflowStore; project: ProjectState; files: WorkflowFileSource }> {
    const project = projectId ? await readProjectFiles(projectId) : { files: new Map<string, string>(), dir: null, state: "not_requested" as const };
    const files: WorkflowFileSource = {
      list: async (dir) => (project.dir && dir === project.dir ? [...project.files.keys()].map((name) => `${dir}/${name}`).sort() : nodeFileSource.list(dir)),
      read: async (path) => (project.dir && dirname(path) === project.dir ? project.files.get(path.slice(project.dir.length + 1)) ?? "" : nodeFileSource.read(path)),
    };
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, files, globalDir, ...(project.dir ? { projectDir: project.dir } : {}), resolveStatus: statuses.resolve });
    return { store, project: project.state, files };
  }

  function statsFor(workflowId: string, projectId?: string): WorkflowStats {
    const where = projectId ? "workflow_id=? AND project_id=?" : "workflow_id=?";
    const args = projectId ? [workflowId, projectId] : [workflowId];
    const row = db.prepare(`SELECT COUNT(*) AS runs,
        COALESCE(SUM(status='succeeded'),0) AS ok,
        COALESCE(SUM(status IN (${FAILED.map(() => "?").join(",")})),0) AS bad,
        COALESCE(SUM(status IN ('running','waiting')),0) AS active
      FROM lane_pilot_wf_run WHERE ${where}`).get(...FAILED, ...args) as { runs: number; ok: number; bad: number; active: number };
    const last = db.prepare(`SELECT id, status, created_at FROM lane_pilot_wf_run WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...args) as { id: string; status: string; created_at: number } | undefined;
    const finished = row.ok + row.bad;
    return { runs: row.runs, succeeded: row.ok, failed: row.bad, active: row.active, successRate: finished > 0 ? row.ok / finished : null,
      lastRunAt: last?.created_at ?? null, lastStatus: last?.status ?? null, lastRunId: last?.id ?? null };
  }

  const summary = (item: StoredWorkflow, projectId?: string): WorkflowSummary => ({
    id: item.workflow.id, name: item.workflow.name, description: item.workflow.description, status: item.workflow.status, version: item.workflow.version,
    scope: item.origin, internal: item.workflow.internal, tags: item.workflow.tags, nodes: item.workflow.nodes.filter((node) => node.type !== "note").length,
    warnings: item.warnings.length, stats: statsFor(item.workflow.id, projectId),
  });

  return {
    loadStore,

    async list(input: { projectId?: string }): Promise<Output<"workflow_list">> {
      const { store, project } = await loadStore(input.projectId);
      return {
        workflows: store.list().map((item) => summary(item, input.projectId)).sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.en.localeCompare(b.name.en)),
        problems: store.problems.map((row) => ({ origin: row.origin, source: row.source, messages: row.problems.map((problem) => problem.message) })),
        project,
      };
    },

    /** A workflow of the library with the file it was read from (its text hashed), so an editor can start from it and publish over that file and no other. */
    async source(input: { id: string; projectId?: string }): Promise<{ workflow: Workflow; origin: StoredWorkflow["origin"]; path: string; fileSha256: string | null; ids: string[] } | null> {
      const { store, files } = await loadStore(input.projectId);
      const item = store.get(input.id);
      if (!item) return null;
      const text = item.origin === "builtin" ? null : await files.read(item.source).catch(() => null);
      return { workflow: item.workflow, origin: item.origin, path: item.source, fileSha256: text === null ? null : sha256Text(text), ids: store.list().map((other) => other.workflow.id) };
    },

    async get(input: { id: string; projectId?: string }): Promise<Output<"workflow_get">> {
      const { store } = await loadStore(input.projectId);
      const item = store.get(input.id);
      if (!item) return { workflow: null };
      const { workflow } = item;
      const runs = db.prepare(`SELECT id, status, reason, mode, created_at, updated_at, tokens_used, cost_micro_usd, parent_run_id FROM lane_pilot_wf_run
        WHERE workflow_id=?${input.projectId ? " AND project_id=?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${RECENT_RUNS}`)
        .all(...(input.projectId ? [workflow.id, input.projectId] : [workflow.id])) as Array<{ id: string; status: string; reason: string | null; mode: string | null; created_at: number; updated_at: number; tokens_used: number; cost_micro_usd: number; parent_run_id: string | null }>;
      const requires = workflow.requires;
      return {
        workflow: {
          ...summary(item, input.projectId),
          examples: workflow.examples, inputs: workflow.inputs.map(field), outputs: workflow.outputs.map(field),
          triggers: workflow.triggers.map((trigger) => trigger.cron ? `${trigger.type} ${trigger.cron}` : trigger.type),
          requires: [...requires.plugins, ...requires.skills, ...requires.mcp, ...requires.tools, ...requires.platforms, ...requires.machines, ...requires.env, ...requires.secrets, ...(requires.browserSession ? ["browser session"] : [])],
          budget: { maxSteps: workflow.budget.maxSteps ?? null, maxTokens: workflow.budget.maxTokens ?? null, maxCostUsd: workflow.budget.maxCostUsd ?? null, maxWallSeconds: workflow.budget.maxWallSeconds ?? null },
          qualityMode: workflow.quality_mode?.default ?? null, source: item.source, sha256: item.sha256,
          schedules: (db.prepare("SELECT project_id, slot, automation_id FROM lane_pilot_wf_trigger WHERE workflow_id=? ORDER BY project_id, slot").all(workflow.id) as Array<{ project_id: string; slot: number; automation_id: string }>)
            .map((row) => ({ projectId: row.project_id, slot: row.slot, automationId: row.automation_id })),
          proven: (() => { const live = statuses.liveSuccess(workflow.id, workflow.version, workflow.live_success); return live ? { runId: live.id, at: live.updated_at } : null; })(),
          warningMessages: item.warnings.map((warning) => warning.message),
          graph: workflowView(workflow, store.resolve),
          runs: runs.map((row) => ({ id: row.id, status: row.status, reason: row.reason, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at,
            tokens: row.tokens_used, costUsd: row.cost_micro_usd / 1_000_000, parentRunId: row.parent_run_id })),
        },
      };
    },

    /** The run as the engine journals it: the pinned definition drawn as a graph, every step with its state and thread, the child runs of subworkflow nodes. */
    runSnapshot(input: { runId: string }): Output<"workflow_run_snapshot"> {
      const snapshot = services.workflowEngine.snapshot(input.runId);
      if (!snapshot) return { snapshot: null };
      const { run } = snapshot;
      const children = db.prepare("SELECT id, parent_step_key, workflow_id, status FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY created_at, rowid").all(run.id) as Array<{ id: string; parent_step_key: string; workflow_id: string; status: string }>;
      const events = (snapshot.events as Array<{ seq: number; step_key: string | null; kind: string; from_state: string | null; to_state: string | null; detail: string | null; at: number }>).slice(-EVENT_TAIL);
      return {
        snapshot: {
          run: { id: run.id, workflowId: run.workflow_id, version: run.workflow_version, status: run.status, reason: run.reason, mode: run.mode, projectId: run.project_id,
            createdAt: run.created_at, updatedAt: run.updated_at, tokens: run.tokens_used, costUsd: run.cost_micro_usd / 1_000_000, parentRunId: run.parent_run_id,
            parentStepKey: run.parent_step_key, stepsUsed: run.steps_used, inputs: clipJson(parseJson(run.inputs_json)), output: clipJson(parseJson(run.output_json)) },
          graph: workflowView(JSON.parse(run.definition_json)) as WorkflowView,
          steps: snapshot.steps.map((step) => {
            const receipt = parseJson(step.receipt_json) as { threadId?: string | null } | null;
            const output = parseJson(step.output_json) as Record<string, unknown> | null;
            const awaiting = parseJson(step.await_json) as { kind?: string } | null;
            return { key: step.step_key, nodeId: step.node_id, state: step.state, visit: step.visit, scope: step.scope, attempt: step.attempt, parentKey: step.parent_key, edgeIndex: step.edge_index,
              startedAt: step.started_at, endedAt: step.ended_at, error: step.error, threadId: receipt?.threadId ?? null,
              handoff: typeof output?.handoff === "string" ? output.handoff : null, awaiting: awaiting?.kind ?? null, input: clipJson(parseJson(step.input_json)), output: clipJson(output) };
          }),
          children: children.map((row) => ({ runId: row.id, stepKey: row.parent_step_key, workflowId: row.workflow_id, status: row.status })),
          goals: parseGoals(run.goals_json),
          goalAudit: services.workflowEngine.lastAudit(run.id),
          goalChanges: services.workflowEngine.goalJournal(run.id).map((entry) => ({ at: entry.at, by: entry.by, reason: entry.reason, goals: entry.goals.length })),
          events: events.map((row) => ({ seq: row.seq, stepKey: row.step_key, kind: row.kind, from: row.from_state, to: row.to_state, detail: row.detail, at: row.at })),
        },
      };
    },
  };
}
