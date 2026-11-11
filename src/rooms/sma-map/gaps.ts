// Known gaps in Lane Pilot's coverage of the SMA map: behaviour the card claims that no contract check holds.
// Hand-maintained register (was generated from `it.todo` stubs until R10 removed them): close a gap by implementing
// the behaviour and covering it with a real `[sma:<id>]` test, then delete its line. A `have` entry with a gap here
// counts as partial on the map (model.ts).
export const SMA_CONTRACT_GAPS: Readonly<Record<string, readonly string[]>> = {
  ap_caps: ["The documentary gate is on by default but holds a stage only on a red (not_supported) receipt; a provider with no or stale receipt is observed and runs, so a stage can still run without proof. Chosen by decision."],
  dt_switch: ["an empty store leaves the conveyor on; off is not the factory default"],
  f_dead_letter: ["the ledger stamps these attempt states"],
  f_rejected: ["the ledger stamps these attempt states"],
  f_verifying: ["the ledger stamps these attempt states"],
  f_waiting_human: ["the ledger stamps these attempt states"],
  k_ag_docwriter: ["lp.docs-maintenance now has an assignment input and the docs stage honours it, but nothing hands it one: both docs workflows are pipelines refused by lane_pilot_run_workflow, and the docs-nightly CLI takes no assignment."],
  k_ag_intel: ["nothing writes structured code facts into .planning/intel"],
  k_d_contexts: ["the context key is not read from three agent output profiles"],
  k_d_ref_unread: ["seven reference files are not named by any command"],
  k_d_tpl_instructions: ["instructionForms is wired into lp.profile_write, which writes only if PROJECT.md already exists; project-start writes PROJECT.md later in its recap step, so a fresh project start gets no CLAUDE.md or Copilot form."],
  k_d_tpl_prompts: ["no ready prompt is stored for the planner or the debugger"],
  k_lib_landing: ["Every 15 minutes the task's own checks rerun on the merge in a throwaway worktree and the verdict lands on the change row; the project suite is not run and badge and numbers are not stamped at merge."],
  k_up_legacy: ["update.md changelog-and-cache workflow is not shipped and has no proof in this tree"],
  k_up_reapply: ["saved person patches are not merged onto a new engine version, and that workflow is not installed as a skill"],
  k_v_grill: ["grill-plan now ends 'open' naming unresolved challenges, but it blocks no build and has no budget-aware pre-push plan (by decision); the row has no [sma:k_v_grill] test, only an untagged chains test."],
  k_we_uiqa: ["built and tested; off unless browser_qa.enabled=on (bb lane-pilot setting <project> browser_qa.enabled=on); then ui-audit runs between verdict and goal audit."],
  k_we_verify: ["built and tested; off unless browser_qa.enabled=on (bb lane-pilot setting <project> browser_qa.enabled=on); visible work then owes a passed live check."],
  m_cfg_budget0: ["built and tested; off unless money.cap_unset_zero=on (bb lane-pilot setting money.cap_unset_zero=on); by the owner's decision an unset monthly cap means no limit, so a paid lane is not without money by default"],
  m_cfg_max_turns: ["built and tested; no ceiling unless writer.max_turns is set (bb lane-pilot setting <project> writer.max_turns=80); the card's default of 80 is not applied"],
  m_cfg_pipeline_off: ["not built: the conveyor still defaults to on for a fresh install; shipping it off waits for the owner's word"],
  m_ck_isolated: ["No project snapshot or throwaway copy: checks run in the live checkout. The roots manifest is taken only for chat checks and only recorded; writer verification takes none and a changed root never fails."],
  m_ck_required: ["Recipe-from-snapshot and throwaway copy are missing (live checkout). Cleared env, closed publication (credential stores masked unless verification.ssh_keys=on) and roots manifest are recorded for chat checks only; manifest never fails."],
  m_md_role_wanted: ["built and tested; off unless writer.kind_models is set (bb lane-pilot setting <project> writer.kind_models='{\"docs\":[\"key\"]}')"],
  m_mo_estimate: ["built and tested; off unless money.silent_estimate_tokens is set (bb lane-pilot setting money.silent_estimate_tokens=200000)"],
  m_mo_rule: ["built and tested; money.strict=on only prefers a free subscription member; by the owner's decision an unset monthly cap means no limit, so a paid lane is not held without a cap"],
  m_sd_approve: ["built and tested; the real Approve press and the red-branch refusal run only with LP_DRILL_LIVE_PRESS=1 and a window at LP_DRILL_UI_URL; otherwise the word goes through the task_word RPC and no red task runs."],
  m_sd_lift: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario watchdog); without it the scene only reports a dry run or skipped"],
  m_sd_outage: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario outage_live); without it the scene only reports a dry run or skipped"],
  m_sd_skills: ["built and tested; runs by name but does nothing (reports skipped, 'not run') unless LP_DRILL_UI_ACCESS_URL is set with {project}, the access page of the drill's project; then it presses the window."],
  m_sw_ship: ["The ship screen says the push stays with a person, but no push or PR command is printed under the buttons, because the ship workflow's outputs carry none."],
  m_tl_crash: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario watchdog); without it the scene only reports a dry run or skipped"],
  m_w_suspect: ["default is eight silent knocks of any kind, as before; three refused connections in a row declare only with LP_WATCH_REFUSED_AFTER=3 in the watchdog's environment (default 8)."],
  m_wrappers: ["Attempt writes (state, journal, wake, cancel code, world_seq counter) are one transaction; task and hold writes (held_until, contract, closed_words) are plain statements outside the frame and do not bump the world counter."],
  rl_prep: ["accounts and person are not checked (no probe can fail); the browser check passes when no browser machine is named. Database, receipts, limits and window are checked and refuse the series."],
  wr_vendors: ["an api vendor exists and claude is the default"],
};

/**
 * What the 2026-11-10 audit found missing behind a «have» claim that no contract test held: one reader opened the proof of each of
 * 925 such claims and compared the code with the SMA card. One reader, not a test: a line here is a named doubt, and it leaves the map
 * the same way as a contract gap — a real `[sma:<id>]` test of the behaviour, then delete the line.
 */
export const SMA_AUDIT_GAPS: Readonly<Record<string, readonly string[]>> = {
  k_we_codereview: ["deliberate: the code critic stops weak work by default (code_critique.mode=gate); the card's advice-only mode is the setting value advisory"],
  m_gt_authed: ["the core checks the caller only when the owner sets BB_VK_OWNER_AUTH; the plugin adds no caller check of its own (owner decision 2026-10-08)"],
  m_mo_unset: ["deliberate: an unset monthly cap means no limit — every lane the owner runs is a subscription (2026-11-10); the card reads an unset cap as zero for paid lanes"],
  m_sh_publish: ["deliberate: the ship workflow pushes and opens the pull request itself — the owner ordered releases without asking (2026-11-01); the card leaves the push to a person"],
  p4_nested_batch: ["Pieces are tasks issued by waves and the phase closes on acceptance. No plan bound to a nested batch whose closing closes the plan."],
};
