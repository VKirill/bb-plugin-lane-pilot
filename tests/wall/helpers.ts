import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** 2026-10-22 03:00 UTC, the night's start. */
export const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);

export function freshDb() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES ('run_real','proj_real','thr_pm','running',?,?)").run(NOW - 40 * DAY, NOW);
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES ('run_sand','proj_sand','thr_pm2','running',?,?)").run(NOW - 40 * DAY, NOW);
  let n = 0;
  const attempt = (state: string, reason: string | null, at: number, options: { run?: string; task?: string; version?: string | null; id?: string } = {}) => {
    const id = options.id ?? `lpattempt_${String(++n).padStart(4, "0")}`;
    db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,state,reason,created_at,updated_at,harness_version) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, options.run ?? "run_real", options.task ?? `task-${id}`, state, reason, at, at, options.version === undefined ? "0.1.268" : options.version);
    return id;
  };
  const triage = (attemptId: string, origin: string, at: number, run = "run_real", project = "proj_real") =>
    db.prepare("INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,status,failed_at,triaged_at) VALUES (?,?,?,?,?,?,?,'ok',?,?)")
      .run(project, attemptId, run, `task-${attemptId}`, "x", "r", origin, at, at);
  const gate = (task: string, gateName: string, status: string, at: number, run = "run_real") =>
    db.prepare("INSERT INTO lane_pilot_gate_event (project_id,run_id,task_id,gate,status,input_sha256,attempt,occurred_at) VALUES ('proj_real',?,?,?,?,?,0,?)").run(run, task, gateName, status, "a".repeat(64), at);
  const receipt = (task: string, stage: string, state: string, input = "i1", run = "run_real", reason: string | null = null) =>
    db.prepare("INSERT INTO lane_pilot_stage_receipt (run_id,task_id,stage_id,contract_version,state,input_sha256,attempt,reason,updated_at) VALUES (?,?,?,1,?,?,0,?,?)")
      .run(run, task, stage, state, input.padEnd(64, "0"), reason, NOW);
  return { db, attempt, triage, gate, receipt };
}

export const isReal = (projectId: string, taskId: string) => projectId !== "proj_sand" && !taskId.startsWith("drill-");
