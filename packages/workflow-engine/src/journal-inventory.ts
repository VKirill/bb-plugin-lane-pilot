import type Database from "better-sqlite3";
import type { createJournal } from "./journal";

export type InventoryStep = { node_id: string; output_json: string; receipt_json: string; rowid: number };

export function wfInventoryRows(db: Pick<Database.Database, "prepare">, runId: string): InventoryStep[] {
  return db.prepare("SELECT rowid, node_id, output_json, receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND state='succeeded' AND node_id IN ('baseline','write_tests','fix_tests') ORDER BY rowid").all(runId) as InventoryStep[];
}

export function wfInventoryBaselineSucceeded(db: Pick<Database.Database, "prepare">, runId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='step' AND step_key GLOB 'baseline#*' AND to_state='succeeded' LIMIT 1").get(runId));
}

/** Child reruns lose their steps, so claim the logical baseline once in the surviving root's append-only events. */
export function wfClaimInventoryBaseline(db: Pick<Database.Database, "prepare" | "transaction">, journal: Pick<ReturnType<typeof createJournal>, "event">, runId: string, workflowId: string, stepKey: string): boolean {
  // Collapse visits and scope suffixes conservatively: an ambiguous second visit must not reset the baseline.
  const logicalNode = (key: string) => key.replace(/#\d+(?:@[a-f0-9]+)?$/, "");
  const ancestry: string[] = [workflowId, logicalNode(stepKey)];
  let owner = runId;
  for (let depth = 0; ; depth++) {
    if (depth > 16) throw Error("inventory run ancestry too deep");
    const parent = db.prepare("SELECT parent_run_id, parent_step_key FROM lane_pilot_wf_run WHERE id=?").get(owner) as { parent_run_id: string | null; parent_step_key: string | null } | undefined;
    if (!parent) throw Error("inventory run ancestry missing");
    if (!parent.parent_run_id) break;
    if (!parent.parent_step_key) throw Error("inventory parent step missing");
    ancestry.unshift(logicalNode(parent.parent_step_key));
    owner = parent.parent_run_id;
  }
  const claim = JSON.stringify(ancestry);
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='inventory_baseline_claim' AND detail=? LIMIT 1").get(owner, claim)) return false;
    journal.event(owner, null, "inventory_baseline_claim", null, null, claim);
    return true;
  })();
}
