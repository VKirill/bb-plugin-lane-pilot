// Known gaps in Lane Pilot's coverage of the SMA map: behaviour the card claims that no contract check holds.
// Hand-maintained register (was generated from `it.todo` stubs until R10 removed them): close a gap by implementing
// the behaviour and covering it with a real `[sma:<id>]` test, then delete its line. A `have` entry with a gap here
// counts as partial on the map (model.ts).
export const SMA_CONTRACT_GAPS: Readonly<Record<string, readonly string[]>> = {
  dt_switch: ["an empty store leaves the conveyor on; off is not the factory default"],
  f_dead_letter: ["the ledger stamps these attempt states"],
  f_rejected: ["the ledger stamps these attempt states"],
  f_verifying: ["the ledger stamps these attempt states"],
  f_waiting_human: ["the ledger stamps these attempt states"],
  k_ag_intel: ["nothing writes structured code facts into .planning/intel"],
  k_d_contexts: ["the context key is not read from three agent output profiles"],
  k_d_ref_unread: ["seven reference files are not named by any command"],
  k_d_tpl_prompts: ["no ready prompt is stored for the planner or the debugger"],
  k_up_legacy: ["update.md changelog-and-cache workflow is not shipped and has no proof in this tree"],
  k_up_reapply: ["saved person patches are not merged onto a new engine version, and that workflow is not installed as a skill"],
  m_cfg_pipeline_off: ["not built: the conveyor still defaults to on for a fresh install; shipping it off waits for the owner's word"],
  m_sd_approve: ["built and tested; the Approve press and the red branch run only in a window named in LP_DRILL_UI_URL: the hub's own port refuses a browser navigation (403, a BB core guard), so without that address the word goes through the task_word RPC and the scene says why."],
  m_sd_lift: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario watchdog); without it the scene only reports a dry run or skipped"],
  m_sd_outage: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario outage_live); without it the scene only reports a dry run or skipped"],
  m_sd_skills: ["built and tested; the skills screen is pressed only in a window named in LP_DRILL_UI_ACCESS_URL or LP_DRILL_UI_URL: the hub's own port refuses a browser navigation (403), so without that address the scene reports skipped with the reason."],
  m_sw_ship: ["deliberate: the ship workflow pushes and opens the pull request itself (the owner's order of 2026-11-01) and the ship screen says so; the card leaves the push to a person and prints the command"],
  m_tl_crash: ["built and tested; the live pass runs only with LP_DRILL_WATCHDOG_LIVE=1 in the environment (python3 scripts/lp-drill.py --scenario watchdog); without it the scene only reports a dry run or skipped"],
};

/**
 * What the 2026-11-10 audit found missing behind a «have» claim that no contract test held: one reader opened the proof of each of
 * 925 such claims and compared the code with the SMA card. One reader, not a test: a line here is a named doubt, and it leaves the map
 * the same way as a contract gap — a real `[sma:<id>]` test of the behaviour, then delete the line.
 */
export const SMA_AUDIT_GAPS: Readonly<Record<string, readonly string[]>> = {
  k_we_codereview: ["deliberate: the code critic stops weak work by default (code_critique.mode=gate); the card's advice-only mode is the setting value advisory"],
  m_gt_authed: ["the core checks the caller only when the owner sets BB_VK_OWNER_AUTH; the plugin adds no caller check of its own (owner decision 2026-10-08)"],
  m_sh_publish: ["deliberate: the ship workflow pushes and opens the pull request itself — the owner ordered releases without asking (2026-11-01); the card leaves the push to a person"],
};
