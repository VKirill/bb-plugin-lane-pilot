/** One line of task-level stability for the daily summary. Read-only.
 *   npx tsx scripts/print-live-stability.ts --db <lane-pilot data.db> --core <bb.db> --days 1 --floor 0.1.389
 */
import Database from "better-sqlite3";
import { liveStability, renderLiveStability, type LiveAttempt } from "../src/rooms/bench/live-rate";

const flag = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const days = Number(flag("days"));
if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");
const db = new Database(flag("db"), { readonly: true, fileMustExist: true });
db.exec(`attach database '${flag("core").replaceAll("'", "''")}' as core`);
const since = Date.now() - days * 86_400_000;
const rows = db.prepare(`select a.task_id as taskId, r.project_id as projectId, p.name as projectName, a.state as state, a.reason as reason, a.harness_version as harnessVersion, a.updated_at as updatedAt
  from lane_pilot_attempt a
  join lane_pilot_run r on r.id = a.run_id
  left join core.projects p on p.id = r.project_id
  where a.created_at > ?`).all(since) as LiveAttempt[];
process.stdout.write(`${renderLiveStability(liveStability(rows, { floorVersion: flag("floor") }))}\n`);
