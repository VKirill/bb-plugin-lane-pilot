import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { wfErrandSpawnThreadId, wfStepsOfRun, wfWorkflowIdOfRun, type RunRow } from "@lane-pilot/workflow-engine";
import {
  ERRAND_EPISODE_EXTRACTOR_VERSION,
  ERRAND_EPISODE_TABLE,
  collectEnabled,
  errandOutcome,
} from "../../../contracts/server";
import { loadProjectSettings, type LanePilotDatabase } from "../../../storage";

type EpisodeStmt = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type EpisodeDb = {
  prepare(sql: string): EpisodeStmt;
};

export type EpisodeLogSink = {
  debug?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
};

export type PendingEpisodeInput = {
  runId: string;
  threadId?: string | null | undefined;
  projectId?: string | null | undefined;
  processKey?: string | null | undefined;
  workflowId?: string | undefined;
  now?: number | undefined;
};

type StepTraceRow = {
  node_id: string;
  started_at: number | null;
  updated_at: number;
  answered_model?: string | null;
  requested_model?: string | null;
  answered_provider?: string | null;
  requested_provider?: string | null;
  receipt_json: string | null;
};

type DefinitionNode = {
  id?: unknown;
  type?: unknown;
  role?: unknown;
  uses?: unknown;
  action?: unknown;
};

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDefinitionNodes(definitionJson: string | null | undefined): Map<string, DefinitionNode> {
  const map = new Map<string, DefinitionNode>();
  const parsed = parseJsonObject(definitionJson);
  const nodes = parsed.nodes;
  if (!Array.isArray(nodes)) return map;
  for (const entry of nodes) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as DefinitionNode;
    if (typeof node.id === "string" && node.id) map.set(node.id, node);
  }
  return map;
}

function isCollectEnabled(db: EpisodeDb, projectId: string | null): boolean {
  try {
    return collectEnabled(loadProjectSettings(db as LanePilotDatabase, projectId ?? GLOBAL_SETTINGS_PROJECT_ID));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/no such table:\s*lane_pilot_project_settings/iu.test(message)) return true;
    throw cause;
  }
}

function lookupRunWorkflowId(db: EpisodeDb, runId: string): string | null {
  try {
    return wfWorkflowIdOfRun(db as never, runId) || null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/no such table:\s*lane_pilot_wf_run/iu.test(message)) return null;
    throw cause;
  }
}

function existingEpisodeRow(db: EpisodeDb, runId: string): { process_key: string | null } | undefined {
  return db
    .prepare(`SELECT process_key FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=? AND extractor_version=? LIMIT 1`)
    .get(runId, ERRAND_EPISODE_EXTRACTOR_VERSION) as { process_key: string | null } | undefined;
}

function safeErrandSpawnThreadId(db: EpisodeDb, runId: string): string | null {
  try {
    return wfErrandSpawnThreadId(db as never, runId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/no such table:\s*lane_pilot_wf_effect/iu.test(message)) return null;
    throw cause;
  }
}

function buildStepTrace(steps: readonly StepTraceRow[], nodesById: ReadonlyMap<string, DefinitionNode>): string[] {
  return steps.map((step) => {
    const node = nodesById.get(step.node_id);
    const receipt = parseJsonObject(step.receipt_json);
    const role = firstNonEmpty(node?.role, node?.type) ?? "unknown";
    const tool = node
      ? firstNonEmpty(node.uses, node.action) ?? step.node_id
      : firstNonEmpty(receipt.executor) ?? step.node_id;
    return `${role}:${tool}`;
  });
}

function pickModelAndProvider(steps: readonly StepTraceRow[], inputs: Record<string, unknown>): {
  model: string | null;
  providerId: string | null;
} {
  let model: string | null = null;
  let providerId: string | null = null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (!model) model = firstNonEmpty(step.answered_model, step.requested_model);
    if (!providerId) providerId = firstNonEmpty(step.answered_provider, step.requested_provider);
    if (model && providerId) break;
  }
  return {
    model: model ?? firstNonEmpty(inputs.model),
    providerId: providerId ?? firstNonEmpty(inputs.providerId),
  };
}

/** Inserts a pending episode row idempotently when a routed graph starts for an errand brief. */
export function writePendingEpisode(
  db: EpisodeDb,
  input: PendingEpisodeInput,
  log?: EpisodeLogSink,
): void {
  try {
    if (!isCollectEnabled(db, input.projectId ?? null)) return;
    const now = input.now ?? Date.now();
    const workflowId = input.workflowId ?? lookupRunWorkflowId(db, input.runId) ?? "errand";
    db.prepare(
      `INSERT OR IGNORE INTO ${ERRAND_EPISODE_TABLE}
        (run_id, extractor_version, project_id, workflow_id, status, outcome, thread_id, process_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 'running', ?, ?, ?, ?)`,
    ).run(
      input.runId,
      ERRAND_EPISODE_EXTRACTOR_VERSION,
      input.projectId ?? null,
      workflowId,
      input.threadId ?? null,
      input.processKey ?? null,
      now,
      now,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`errand episode write failed run=${input.runId}: ${message}`);
  }
}

/** Records or updates the episode row for a finished errand or routed-errand workflow run. */
export function writeEpisode(
  db: EpisodeDb,
  run: RunRow,
  now = Date.now(),
  log?: EpisodeLogSink,
): void {
  try {
    const inputs = parseJsonObject(run.inputs_json);
    const hasRouteTop = typeof inputs.routeTop === "string" && inputs.routeTop.trim().length > 0;
    const existing = existingEpisodeRow(db, run.id);
    if (run.workflow_id !== "errand" && !hasRouteTop && !existing) return;
    if (!isCollectEnabled(db, run.project_id)) return;

    const steps = wfStepsOfRun(db as never, run.id) as unknown as StepTraceRow[];

    const trace = buildStepTrace(steps, parseDefinitionNodes(run.definition_json));
    const output = parseJsonObject(run.output_json);
    const hasOutput = Object.keys(output).length > 0;
    const { outcome, verified } = errandOutcome(run.status, hasOutput ? output : null, run.reason);
    const checksJson = Array.isArray(output.checks) ? JSON.stringify(output.checks) : null;
    const threadId = firstNonEmpty(output.thread_id) ?? safeErrandSpawnThreadId(db, run.id);
    const { model, providerId } = pickModelAndProvider(steps, inputs);
    const skillsOfferedJson = Array.isArray(inputs.skills) ? JSON.stringify(inputs.skills.map(String)) : null;

    db.prepare(
      `INSERT INTO ${ERRAND_EPISODE_TABLE}
        (run_id, extractor_version, project_id, workflow_id, status, outcome, verified, checks_json,
         thread_id, model, provider_id, skills_offered_json, trace_json, process_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, extractor_version) DO UPDATE SET
         status = excluded.status,
         outcome = excluded.outcome,
         verified = excluded.verified,
         checks_json = excluded.checks_json,
         thread_id = COALESCE(excluded.thread_id, ${ERRAND_EPISODE_TABLE}.thread_id),
         model = COALESCE(excluded.model, ${ERRAND_EPISODE_TABLE}.model),
         provider_id = COALESCE(excluded.provider_id, ${ERRAND_EPISODE_TABLE}.provider_id),
         skills_offered_json = COALESCE(excluded.skills_offered_json, ${ERRAND_EPISODE_TABLE}.skills_offered_json),
         trace_json = excluded.trace_json,
         process_key = COALESCE(excluded.process_key, ${ERRAND_EPISODE_TABLE}.process_key),
         updated_at = excluded.updated_at`,
    ).run(
      run.id,
      ERRAND_EPISODE_EXTRACTOR_VERSION,
      run.project_id ?? null,
      run.workflow_id,
      run.status,
      outcome,
      verified,
      checksJson,
      threadId,
      model,
      providerId,
      skillsOfferedJson,
      JSON.stringify(trace),
      null,
      now,
      now,
    );

    const processKey = existing?.process_key ?? "none";
    log?.debug?.(`errand episode written run=${run.id} steps=${trace.length} process_key=${processKey}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`errand episode write failed run=${run.id}: ${message}`);
  }
}
