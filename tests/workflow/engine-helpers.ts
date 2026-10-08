import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { LanePilotDatabase } from "../../src/rooms/storage/database";
import { CrashError, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { EngineOptions, NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { workflowMigrations } from "@lane-pilot/workflow-engine";
import { createStatusResolver, workflowOpsMigrations } from "@lane-pilot/workflow-engine";
import { definitionSha256 } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import { workflow } from "./fixtures";

/** A database with only the journal tables: the engine needs nothing else. */
export function journalDb(): LanePilotDatabase {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...workflowMigrations, ...workflowOpsMigrations]);
  return db;
}

export const wf = (extra: Parameters<typeof workflow>[0] = {}): Workflow => parseWorkflow(workflow(extra));

export const ok = (fn: (ctx: StepContext) => Record<string, unknown> | Promise<Record<string, unknown>>, extra: Partial<NodeExecutor> = {}): NodeExecutor =>
  ({ reentrant: true, run: async (ctx) => ({ output: await fn(ctx) }), ...extra });

export function engineOn(db: LanePilotDatabase, executors: Record<string, NodeExecutor> = {}, options: Partial<EngineOptions> = {}): WorkflowEngine {
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", ...options });
  for (const [key, executor] of Object.entries(executors)) engine.register(key, executor);
  return engine;
}

export const rows = <T = Record<string, unknown>>(db: LanePilotDatabase, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
export const stepStates = (db: LanePilotDatabase, runId: string) =>
  Object.fromEntries(rows<{ step_key: string; state: string }>(db, "SELECT step_key, state FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", runId).map((row) => [row.step_key, row.state]));

export { CrashError };

/** A green test receipt for a workflow file, as the owner's «run tests» (or a publish) leaves it: without one a file that says published counts as a draft. */
export function trust(db: LanePilotDatabase, definition: Record<string, unknown>): void {
  const parsed = parseWorkflow(definition);
  createStatusResolver(db).recordTest(parsed.id, definitionSha256(parsed), true, []);
}
