// Known gaps in Lane Pilot's coverage of the SMA map: behaviour the card claims that no contract check holds.
// Hand-maintained register (was generated from `it.todo` stubs until R10 removed them): close a gap by implementing
// the behaviour and covering it with a real `[sma:<id>]` test, then delete its line. A `have` entry with a gap here
// counts as partial on the map (model.ts).
export const SMA_CONTRACT_GAPS: Readonly<Record<string, readonly string[]>> = {
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
};

/**
 * What the 2026-11-10 audit found missing behind a «have» claim that no contract test held: one reader opened the proof of each of
 * 925 such claims and compared the code with the SMA card. One reader, not a test: a line here is a named doubt, and it leaves the map
 * the same way as a contract gap — a real `[sma:<id>]` test of the behaviour, then delete the line.
 */
export const SMA_AUDIT_GAPS: Readonly<Record<string, readonly string[]>> = {};
