import type Database from "better-sqlite3";

import { finalRuleOf, workflowFinish } from "./business-outcome";
import { legacyDefinitionSha256, type StoredWorkflow } from "./store";
import type { Workflow } from "./schema";
import type { WorkflowProblem } from "./validate";

/**
 * What the owner's side of the workflow library keeps beside the journal: the receipts of green test runs of a workflow file
 * (W7), and later the goals of a run and the triggers' automations. Appended to the END of the plugin's migrations (they are positional).
 */
export const PIPELINE_RUNS_ATTRIBUTION = `UPDATE lane_pilot_wf_run SET workflow_id='lp-task-pipeline'
  WHERE workflow_id='analyze-plan-execute' AND parent_run_id IS NULL AND (idem_key LIKE 'lp-task:%' OR link_attempt_id IS NOT NULL)`;

export const workflowOpsMigrations: string[] = [
  // The last test run of a workflow file, keyed by the exact definition that was tested: a file edited afterwards has no receipt.
  `CREATE TABLE lane_pilot_wf_test (
    workflow_id TEXT NOT NULL,
    definition_sha256 TEXT NOT NULL,
    green INTEGER NOT NULL,
    results_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, definition_sha256)
  )`,
  // The BB automation that runs a workflow's schedule trigger (W9): one per workflow, project and schedule trigger; the signature says what it was made from.
  `CREATE TABLE lane_pilot_wf_trigger (
    workflow_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    automation_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, project_id, slot)
  )`,
  // K7: the goals a run was started for (JSON, the router's shape); their changes and the audit before closing are events of the run.
  `ALTER TABLE lane_pilot_wf_run ADD COLUMN goals_json TEXT`,
  // Stats per real workflow: until 0.1.187 the per-task pipeline (one run per dispatched task, keyed `lp-task:<attempt>`) was called
  // analyze-plan-execute, the id the outer chain of the chains spec has now. Those runs are attributed to the pipeline they were.
  PIPELINE_RUNS_ATTRIBUTION,
];

/** Appended at the end of the plugin's migrations (src/rooms/migrations.ts), never inside workflowOpsMigrations, which is spread in the
 * middle of that list: an entry added there shifts every later index and the hub refuses the plugin (0.1.389 deploy, 2026-10-30). */
export const workflowNotVerifiedMigrations: string[] = [
  // A user run whose goals were empty or whose audit could not be made is `not_verified`, not `succeeded`. SQLite cannot widen a CHECK, so the table is rebuilt.
  `CREATE TABLE lane_pilot_wf_run_nv (
    id TEXT PRIMARY KEY,
    idem_key TEXT UNIQUE,
    workflow_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    workflow_sha256 TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    project_id TEXT,
    link_run_id TEXT,
    link_task_id TEXT,
    link_attempt_id TEXT,
    parent_run_id TEXT,
    parent_step_key TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('running','waiting','succeeded','failed','blocked','interrupted','canceled','not_verified')),
    reason TEXT,
    mode TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    harness_version TEXT,
    steps_used INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    wait_ms INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    goals_json TEXT
  );
  INSERT INTO lane_pilot_wf_run_nv(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,parent_run_id,parent_step_key,depth,status,reason,mode,inputs_json,output_json,harness_version,steps_used,tokens_used,cost_micro_usd,wait_ms,owner_id,lease_until,created_at,updated_at,goals_json)
    SELECT id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,parent_run_id,parent_step_key,depth,status,reason,mode,inputs_json,output_json,harness_version,steps_used,tokens_used,cost_micro_usd,wait_ms,owner_id,lease_until,created_at,updated_at,goals_json FROM lane_pilot_wf_run;
  DROP TABLE lane_pilot_wf_run;
  ALTER TABLE lane_pilot_wf_run_nv RENAME TO lane_pilot_wf_run;
  CREATE UNIQUE INDEX lane_pilot_wf_run_child ON lane_pilot_wf_run(parent_run_id, parent_step_key) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX lane_pilot_wf_run_status ON lane_pilot_wf_run(status);
  CREATE INDEX lane_pilot_wf_run_link ON lane_pilot_wf_run(link_run_id, link_task_id)`,
];

export type StatusVerdict = { status: Workflow["status"]; notes: WorkflowProblem[] };

export type ProvenOnEntry = {
  nodeId: string;
  provider: string;
  model: string;
  runs: number;
  lastAt: number;
  source: "live" | "proof";
};

export type ProvenOnOptions = {
  rule?: Workflow["live_success"] | null;
  legacySha256?: string;
};

type LiveRunRow = { id: string; updated_at: number; output_json: string | null; workflow_sha256: string; definition_json: string };

const tableExists = (db: Database.Database, name: string): boolean => {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
};

const columnExists = (db: Database.Database, table: string, column: string): boolean => {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((col) => col.name === column);
  } catch {
    return false;
  }
};

/**
 * Succeeded root runs of a workflow whose final output passes `live_success` (or the default business-outcome rule).
 * Shared by `createStatusResolver().liveSuccess` and `provenOn`.
 */
function listLiveSuccessRuns(
  db: Database.Database,
  input: { workflowId: string; version?: number; rule?: Workflow["live_success"] | null; shas?: readonly string[] },
): LiveRunRow[] {
  if (!tableExists(db, "lane_pilot_wf_run")) return [];
  const clauses = ["workflow_id=?", "status='succeeded'", "parent_run_id IS NULL"];
  const params: unknown[] = [input.workflowId];
  if (input.version !== undefined) {
    clauses.push("workflow_version=?");
    params.push(input.version);
  }
  if (input.shas && input.shas.length > 0) {
    clauses.push(`workflow_sha256 IN (${input.shas.map(() => "?").join(",")})`);
    params.push(...input.shas);
  }
  const rows = db.prepare(
    `SELECT id, updated_at, output_json, workflow_sha256, definition_json FROM lane_pilot_wf_run WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`,
  ).all(...params) as LiveRunRow[];
  return rows.filter((row) => {
    try {
      const parsed = JSON.parse(row.output_json ?? "null") as unknown;
      const output = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      const rule = input.rule !== undefined ? input.rule : finalRuleOf(row.definition_json);
      return workflowFinish(output, rule).ok;
    } catch {
      return false;
    }
  });
}

/** Appended to the plugin's migrations (append only): one row per (graph version, provider, model) proof run (written by the proof command). */
export const workflowProofMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_proof (workflow_id TEXT NOT NULL, definition_sha256 TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, cases_n INTEGER NOT NULL, passed_n INTEGER NOT NULL, cost_micro_usd INTEGER, at INTEGER NOT NULL, PRIMARY KEY (workflow_id, definition_sha256, provider, model))`,
];

export type WorkflowProofRecord = {
  workflowId: string;
  definitionSha256: string;
  provider: string;
  model: string;
  casesN: number;
  passedN: number;
  costMicroUsd?: number | null;
  at?: number;
};

/** Upserts a model-proof summary row for a specific workflow definition sha and provider/model pair. */
export function recordWorkflowProof(db: Database.Database, input: WorkflowProofRecord): void {
  const at = input.at ?? Date.now();
  const costMicroUsd = input.costMicroUsd ?? null;
  db.prepare(
    `INSERT INTO lane_pilot_wf_proof (workflow_id, definition_sha256, provider, model, cases_n, passed_n, cost_micro_usd, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id, definition_sha256, provider, model) DO UPDATE SET
       cases_n = excluded.cases_n,
       passed_n = excluded.passed_n,
       cost_micro_usd = excluded.cost_micro_usd,
       at = excluded.at`,
  ).run(input.workflowId, input.definitionSha256, input.provider, input.model, input.casesN, input.passedN, costMicroUsd, at);
}

/**
 * Per-node and graph-level models a specific workflow definition sha has passed on, combining live-success runs and
 * `lane_pilot_wf_proof` records when present. Returns `[]` if the underlying tables are missing.
 */
export function provenOn(
  db: Database.Database,
  workflowId: string,
  definitionSha256: string,
  options?: ProvenOnOptions,
): ProvenOnEntry[] {
  const shas = options?.legacySha256 && options.legacySha256 !== definitionSha256
    ? [definitionSha256, options.legacySha256]
    : [definitionSha256];
  const entries: ProvenOnEntry[] = [];

  const liveRuns = listLiveSuccessRuns(db, { workflowId, rule: options?.rule, shas });
  if (liveRuns.length > 0 && tableExists(db, "lane_pilot_wf_step") && columnExists(db, "lane_pilot_wf_step", "answered_model")) {
    const runIds = liveRuns.map((row) => row.id);
    const placeholders = runIds.map(() => "?").join(",");
    const stepRows = db.prepare(
      `SELECT node_id, COALESCE(answered_provider, '') AS provider, answered_model AS model,
         COUNT(DISTINCT run_id) AS runs, MAX(COALESCE(ended_at, updated_at)) AS last_at
       FROM lane_pilot_wf_step
       WHERE run_id IN (${placeholders}) AND answered_model IS NOT NULL AND answered_model != ''
       GROUP BY node_id, COALESCE(answered_provider, ''), answered_model
       ORDER BY last_at DESC, node_id ASC, provider ASC, model ASC`,
    ).all(...runIds) as Array<{ node_id: string; provider: string; model: string; runs: number; last_at: number }>;
    for (const row of stepRows) {
      entries.push({
        nodeId: row.node_id,
        provider: row.provider,
        model: row.model,
        runs: row.runs,
        lastAt: row.last_at,
        source: "live",
      });
    }
  }

  if (tableExists(db, "lane_pilot_wf_proof")) {
    const proofRows = db.prepare(
      `SELECT provider, model, passed_n, at
       FROM lane_pilot_wf_proof
       WHERE workflow_id=? AND definition_sha256=? AND passed_n > 0 AND passed_n >= cases_n
       ORDER BY at DESC, provider ASC, model ASC`,
    ).all(workflowId, definitionSha256) as Array<{ provider: string; model: string; passed_n: number; at: number }>;
    for (const row of proofRows) {
      entries.push({
        nodeId: "*",
        provider: row.provider,
        model: row.model,
        runs: row.passed_n,
        lastAt: row.at,
        source: "proof",
      });
    }
  }

  return entries;
}

/**
 * The status a workflow has here, which is not always the status its file says:
 * - a file of the owner (global or project) that says `tested` or `published` counts only with a green test receipt for exactly
 *   this definition; without it the workflow is a `draft` (it is not offered, not run by the PM), so a hand-written `published` cannot skip the tests;
 * - a `tested` workflow (the built-in own chains, or the owner's) is `published` after a live run of this definition that did the job. Canvas positions are not part of that definition.
 */
export function createStatusResolver(db: Database.Database) {
  const receipt = (workflowId: string, sha256: string) =>
    db.prepare("SELECT green, results_json, at FROM lane_pilot_wf_test WHERE workflow_id=? AND definition_sha256=?").get(workflowId, sha256) as { green: number; results_json: string; at: number } | undefined;
  /**
   * The newest live run of this version that did the job: engine succeeded, the output is completed work, and the run was of this
   * definition (`definitionSha256`, which ignores canvas positions, or the older hash that still includes them).
   */
  const liveSuccess = (workflowId: string, version: number, rule?: Workflow["live_success"], sha?: { current: string; legacy: string }) => {
    const shas = sha ? (sha.legacy !== sha.current ? [sha.current, sha.legacy] : [sha.current]) : undefined;
    const hit = listLiveSuccessRuns(db, { workflowId, version, rule: rule ?? null, shas })[0];
    return hit ? { id: hit.id, updated_at: hit.updated_at } : undefined;
  };

  return {
    recordTest(workflowId: string, sha256: string, green: boolean, results: unknown, at = Date.now()): void {
      db.prepare(`INSERT INTO lane_pilot_wf_test(workflow_id, definition_sha256, green, results_json, at) VALUES (?,?,?,?,?)
        ON CONFLICT(workflow_id, definition_sha256) DO UPDATE SET green=excluded.green, results_json=excluded.results_json, at=excluded.at`)
        .run(workflowId, sha256, green ? 1 : 0, JSON.stringify(results ?? null), at);
    },
    receipt,
    liveSuccess,
    resolve(item: StoredWorkflow): StatusVerdict {
      const { workflow } = item;
      const file = workflow.status;
      if (file === "draft" || file === "deprecated") return { status: file, notes: [] };
      if (item.origin !== "builtin") {
        const tested = receipt(workflow.id, item.sha256) ?? receipt(workflow.id, legacyDefinitionSha256(workflow));
        if (!tested?.green) {
          return { status: "draft", notes: [{ level: "warning", code: "untested",
            message: `The file says "${file}", but there is no green test run for exactly this version of it: it counts as a draft until its tests pass (run its tests from the Workflows tab).` }] };
        }
      }
      if (file === "tested" && liveSuccess(workflow.id, workflow.version, workflow.live_success, { current: item.sha256, legacy: legacyDefinitionSha256(workflow) })) return { status: "published", notes: [] };
      return { status: file, notes: [] };
    },
  };
}
export type StatusResolver = ReturnType<typeof createStatusResolver>;
