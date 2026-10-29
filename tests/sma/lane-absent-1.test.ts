import { describe, it } from "vitest";

// Claude Lane and the SMA daemon are not in this repo. Each line is the gap: Lane Pilot does not do that behaviour.
describe("lane-absent gaps", () => {
  it.todo("[sma:dt_stopped_spend] token-usage-sync does not settle reserves of attempts killed with the previous daemon"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_sweep] canary-check probes the plugin; it does not stop a silent attempt or hand its row back"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_reconcile] no pass appends attempts the queue re-issued while the daemon was down"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_bugs] failure_triage is a rule name, not one failure line per task in one file for all projects"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_wt_sweep] no sweep removes worktree copies of works closed for more than a day"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_intake] a PM dispatch still creates a task; backlog-scan is not the only door new work can enter"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_call_stalled] a stalled phase is written to the book; the owner is not called"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_assign_design] drawing() stores paths the caller sends; it does not open a drawing task"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_park_waves] stopWave cancels queued pieces and leaves running writers; there is no after-turn correction"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_lanes] breakerHolds does not drop a lane that has no enabled worker"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_claim] dispatchWriter inserts the task in-process; there is no durable queue whose fetch is the claim"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:dt_idle] tick returns how many phases moved and does not name why it claimed nothing"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_rebrand_wired] install.sh is not in this repo; a red leak scan does not fail the test run or the publish"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_contract] rpcOps is the RPC method table; it does not check that each answer field is rendered or explained"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_contract_test] the suite does not run a check that every answer field is rendered or explained"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_terminal_parity] parityGaps diffs two tool lists; it does not read six lines from one attempt folder"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_codex_lane] there is no drill that an edit outside the Codex lane is refused"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_cap_drill] there is no drill that a session is stopped when its cap is reached"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_bug_sweep] there is no pass that writes one failure line per task into one file for all projects"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_crash] there is no watchdog that restarts a crashed hub and keeps the crash log"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_airbag] there is no airbag ref or stash taken before a risky step"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_integrity] the guard-hash drill is not a renewal of hazard, shadow, or disarm"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_airbag] there is no airbag that restores the tree when a step throws"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_spendadapter] parseOpenCodeToolTelemetry reads OpenCode events, not a Claude Code transcript's cache and cost"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_breaker] a rule loop is not soft-disabled at three repeats and re-armed only by a person"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_reflex] lessons are not filed as reflexes that change the next step"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_gates] there is no hard-rule warning on the stream and no convention gate"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_depsguard] an install through a symlink into the dependency store is not refused"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_storejournal] a progress journal is not truncated to a fixed window"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_workerprog] a worker's progress is not written so a reload can resume it"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_rulesparity] guard_shell does not copy a deny into the plugin or refuse a widening"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_configdir] two sessions are not decided to be one subscription from a config folder and an account"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_statusline] Lane Pilot reads cached usage windows; it does not build one status-line segment"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_skeptic] planted defects are not a skeptic countersign or a near-miss channel outside the score"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_grill] grill-plan finishes done while open challenges remain; it does not block a build"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_subreceipts] a subagent receipt is not stored or checked"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_canary] planted defects are handed to the checkers; there is no sealed ledger the blind verifier cannot read"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_subreceipts] there is no subagent receipt the parent must attach"); // deferral:dfr_seed_skip_sma_gaps
});
