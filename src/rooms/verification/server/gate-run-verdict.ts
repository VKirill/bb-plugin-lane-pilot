import type { GateRunRow, GateRunState } from "../../storage";

/**
 * The durable record of one integration-gate run (lane_pilot_gate_run): «all tasks accepted» alone never said what
 * main's own check did after the merge — still running, red, never ran, or green, and on which commit (Astra F1).
 */
const GATE_RUN_STALE_MS = 35 * 60_000; // gate timeout (30 min) + slack

/** A run left `running` past the gate's own timeout died with it (a reload kills the in-flight call): it ran no verdict. */
function gateRunEffective(row: GateRunRow, now = Date.now()): { state: GateRunState; reason: string | null } {
  if (row.state === "running" && now - row.updatedAt > GATE_RUN_STALE_MS) {
    return { state: "not_run", reason: "the gate run was interrupted (timeout or reload)" };
  }
  return { state: row.state, reason: row.reason };
}

/**
 * The gate state the PM reads next to an accepted task / in preship, in the brief's words:
 * `green on <short sha>` / `running` / `red: <command>` / `not run: <reason>`. `pending` while the verdict is still out.
 */
export function gateRunVerdict(row: GateRunRow | undefined): { line: string; pending: boolean; failed: boolean } {
  if (!row) return { line: "running", pending: true, failed: false };
  const eff = gateRunEffective(row);
  if (eff.state === "running") return { line: "running", pending: true, failed: false };
  if (eff.state === "passed") return { line: `green on ${row.head ? row.head.slice(0, 12) : "unknown commit"}`, pending: false, failed: false };
  if (eff.state === "failed") return { line: `red: ${row.command}${eff.reason ? ` (${eff.reason.slice(0, 160)})` : ""}`, pending: false, failed: true };
  return { line: `not run: ${eff.reason ?? "unknown"}`, pending: false, failed: true };
}
