import { describe, it } from "vitest";

// Hooks of Claude Lane that Lane Pilot does not do. A todo keeps the node visible and the suite green.
describe("claude lane hook gaps", () => {
  it.todo("[sma:k_lib_automem] Claude Code project notes are not read-only after a secret screen"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_automem] the agent does not write its own notes outside the write pipeline"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_wd_c2] subagent usage is not merged into the session record"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_wp_drift] a code-map freshness hook is not installed"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_session_end] session end does not release the window claims and its lease"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_turn_diff] a turn boundary does not diff files or say whether any left the claim"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_statusline] there is no status line of claim, collisions, window budget and open gates"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_htd_verdict] the turn verdict does not compare the attempt base to HEAD as two trees"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hse_release] a closed terminal does not drop its busy scopes"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hse_drop] a window without a process lingers in the registry"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hse_farewell] a farewell draft is not assembled from the window journal tail"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hsl_render] there is no pure status segment over a claim and budget cache"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hsl_wrap] the segment does not stay under the person's line"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hsl_windows] usage cache does not see sessions the person ran in his own terminal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_session_start] session start does not register the window or give a coordination briefing"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_prompt_recall] memory is not searched by the words of the prompt"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_register] an anonymous window is not given a readable name before its first journal line"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_model] a model change does not hide the old passport hit rate"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_summary] there is no summary of live windows and a running push"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_digest] there is no digest of commits, foreign claims and weakly calibrated areas"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_stpa] a protection kill switch without renewal does not re-arm the warning"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hss_curriculum] a stale miss digest is not rebuilt"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpr_heal] a word index behind the corpus is not rebuilt before the search"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpr_find] search does not cover both the corpus and Claude Code auto-memory"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpr_out] a recalled pointer includes note text, not only the file and the claim"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_pretask] a subagent is not born carrying project rules, claims and lessons"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_worker_compact] the precompact capsule is not installed by the daemon into the worker copy"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpt_spend] the spend stream does not run first"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpt_pack] a degraded pack order is not rebuilt once after the index repair"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpt_record] pack size, layers, trimming, ranking and build time are not recorded"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hsv_tree] a claimed file is not checked for dirt or a commit after the spawn"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpc_capsule] the capsule is not the current task, constraints and recent decisions"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hpc_progress] touched files and commands before compaction do not go into the attempt folder"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_pre] there are not nine check streams on Edit, Write and Bash"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_tool_gate] the tool gate is not installed by the daemon personal layer, failing closed inside an attempt"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_h_legacy] there are no thin collision, reflex, gates and fallback verbs"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hp_ctx] a call does not carry window identity, a heartbeat and the seen-store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hp_merge] a deny from a stream without deny rights is not downgraded to a warning"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hp_ladder] sma-ladder.json is not read to resolve a reflex or gate tier"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_collision] an edit inside a foreign claim is not warning-only"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_reflex] a burn lesson does not fire before the act in every terminal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_gates] gates do not warn by default"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_airbag] a destructive git command does not write a return point"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_deps] an install through a store link is not refused"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_fingerprint] another window's fingerprint on the same file does not come back at once"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_enforce] foreign work is not soft-denied only when it is verified live, with an override token"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_context] there are no triggered fact fragments, no catalog refresh after a commit, and no touch journal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hs_spend] there are no warnings at 70 and 90 percent and no Task deny past a human cap"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hst_detect] repeated action, ping-pong and monologue are not detected"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_hst_nudge] a pattern is not nudged once per session"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_rm_hooks] SMA hook entries are not the only ones removed"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_anchor] hook commands are not anchored as absolute paths"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_badjson] a broken settings.json is not refused"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_merge] hook merge does not keep foreign entries of the event"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_stale] stale hook entries are not removed"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_settings] session settings.json is not written by this merge"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_status] there is no window status command"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_heartbeat] there is no window heartbeat"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_claim] there is no window claim"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_release] there is no window release"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_nextslot] there is no next slot"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_consume] there is no slot consume"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_forceclear] there is no force-clear with a reason"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_tia] there is no test-impact analysis"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_state] there is no fenced STATE section"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_exec] there is no execution journal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_open] there is no window open"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_registry] there is no session-lease registry"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_claims] a claim is not atomic across every pattern"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_collision] there is no glob overlap detector"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_slots] there are no shared slot counters"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_journal] there is no hash-chained window journal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_fingerprint] there is no live-work fingerprint"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_termattempt] there is no trail of the person's window attempts"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_statesection] STATE.md has no fenced section"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_execjournal] there is no plan execution journal"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_snapshot] a window does not publish its status into the store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_window] there is no fleet-window entry link"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_digest] there is no cross-terminal digest"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_tia] the library does not compute test impact"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_translit] a description is not turned into a machine name"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_fsatomics] there is no Windows-safe atomic write"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_sessions] there is no session store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_claims] there is no claim store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_journal] there is no journal store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_attempts] there is no window-attempt store"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_flight] there is no store of capsules and flight marks"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_intel] code facts are not installed by a GitNexus hook"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_pl_intel] a GitNexus facts folder is not installed"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_actionclient] the worker gate does not ask a controller before a command, a model call or a stage"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:as_ticket] a dangerous call is denied at once and does not stand as a ticket"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:as_stagnation] stall frames closed, spinning and progressing are not checked"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:f_inv_push] no queue transition refuses worker push and merge"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_pl_merge] worker hook settings are not merged"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_pl_tool_gate] a dangerous worker call does not wait for a decision"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_pl_unreadable] unreadable hooks are not dropped when settings are merged"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_rd_coord_ledger] there is no terminal claim book"); // deferral:dfr_seed_skip_sma_gaps
});
