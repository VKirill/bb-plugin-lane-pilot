import { describe, it } from "vitest";

// Planning, install, templates and agent cards whose Claude Lane behaviour has no counterpart in Lane Pilot or BB (2026-10-30).
describe("claude lane gaps: planning, install, agents", () => {
  it.todo("[sma:m_hs_skill_create] not in Lane Pilot: The person's text goes into the machine's skill library."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_hs_skill_stores] not in Lane Pilot: Project skills and the machine library; each card names its own."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_rd_diag] not in Lane Pilot: Version, platform, OS release, Node and unsigned codes."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_up_verb] not in Lane Pilot: Compares the installed version with the package registry and a local copy; installs only on confirmation."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_up_downgrade] not in Lane Pilot: If the installed one is newer, there is nothing to install."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_tl_rebrand_wired] not in Lane Pilot: A red scanner turns the test run and the package publish red."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_wd_snapshot] not in Lane Pilot: The sketch is opened in a browser; the snapshot is kept beside it."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_seed] not in Lane Pilot: A forward-looking idea with the conditions to revisit it. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_listseeds] not in Lane Pilot: Read-only, with a status filter. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_thread] not in Lane Pilot: Persistent context threads for work across sessions. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_inbox] not in Lane Pilot: Triage of open GitHub issues and PRs against the project templates. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_spikewrap] not in Lane Pilot: Packages the experiment findings into a lasting project skill. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_sketchwrap] not in Lane Pilot: Packages the sketch findings into a lasting project skill. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_help] not in Lane Pilot: Help at the asked level, with no project analysis. Installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_insertphase] not in Lane Pilot: A decimal number between phases without renumbering. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_removephase] not in Lane Pilot: Removal, renumbering and a commit as the historical record. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_syncskills] not in Lane Pilot: Copies managed sma-* skills from one runtime to others. No skill and no help line."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_wdi_hooks] not in Lane Pilot: Active capability steps at discuss:pre."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_c_mapcode] not in Lane Pilot: Mappers write seven documents about the code in parallel. Not installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_profile] not in Lane Pilot: Every command reads the profile only through this module."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_docsynth] not in Lane Pilot: Merges documents by precedence and writes INGEST-CONFLICTS.md."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_rm_self] not in Lane Pilot: After a restart no /sma-* command remains."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_npx] not in Lane Pilot: Installs the engine, runtime, commands and hooks into a project or the global config. Node built-ins only."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_flags] not in Lane Pilot: Local into the project by default; global into the shared Claude Code config."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_engine] not in Lane Pilot: Workflows, roles, templates, references and sma-tools; aliases separately."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_localpaths] not in Lane Pilot: In a local install links to the home config become links to the project .claude."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_runtime] not in Lane Pilot: The CLI and libraries land in the project at the path the hooks call."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_agents] not in Lane Pilot: Each sma-*.md file becomes a subagent definition."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_commands] not in Lane Pilot: Only these workflows become /sma-* skills. The other seventy-nine files do not."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_skills] not in Lane Pilot: For each of the sixteen commands a SKILL.md pointing at the workflow is written."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_skillbody] not in Lane Pilot: The skill adds nothing: the workflow file is the single source of truth."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_in_done] not in Lane Pilot: A plain report of what was installed and the next step."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_engine] not in Lane Pilot: Workflows, roles, templates, references, sma-tools."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_runtime] not in Lane Pilot: The CLI and libraries the hooks call."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_agents] not in Lane Pilot: Subagent definitions; the person own roles beside them stay."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_skills] not in Lane Pilot: Sixteen thin wrappers over workflows."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_st_sma] not in Lane Pilot: The runtime folder: sessions, claims, journal and two dozen more drawers."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_up_cmd] not in Lane Pilot: Checks versions and updates through the standard installer. Installed as a skill."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_up_report] not in Lane Pilot: Installed, latest on npm and a local checkout nearby; nothing changes."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_up_older] not in Lane Pilot: A rollback is a separate manual installer run."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_v_update] not in Lane Pilot: Version report; with --yes it re-runs the installer."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_lib_update] not in Lane Pilot: Compares versions and plans one installer run."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_up_npm] not in Lane Pilot: An unreachable registry is a report line, not an error."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_up_local] not in Lane Pilot: A sibling folder holding bin/init.mjs and the sma-framework package."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_entry] not in Lane Pilot: Replaces repeated shell snippets across about fifty workflows. Workflows call it as sma_run query."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_query] not in Lane Pilot: Accepts both «state.update» and «state update»."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_config] not in Lane Pilot: Reads and writes config.json keys with value checks."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_loop] not in Lane Pilot: Returns the active capability hooks at a loop point, before planning or after execution."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_capmanifest] not in Lane Pilot: SMA memory, coordination and hooks as one capability."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_t_latest] not in Lane Pilot: A deterministic version query instead of model guesses. The older update workflow calls it."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_pl_codebase] not in Lane Pilot: Seven documents about stack, architecture, conventions and risks."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_aliases] not in Lane Pilot: Eleven thin skills that point at the /sma-* commands. Installed only by a flag and removed when old phases close."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_discuss_modes] not in Lane Pilot: Nine mode files: default, batch, text, auto, chain, analyze, advisor, power, all."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_exec_steps] not in Lane Pilot: Codebase drift gate, per-plan copy gate, post-merge gate and copy policy."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_help_modes] not in Lane Pilot: Brief, default, full and per-topic help."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_ref_thinking] not in Lane Pilot: Five files: planning, research, execution, verification, debugging."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_ref_mvp] not in Lane Pilot: Vertical slice, story splitting and the story template."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_ref_ai] not in Lane Pilot: Frameworks and evaluations for AI phases."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_ref_probe] not in Lane Pilot: Edge-case and prohibition probes of a spec, with fixtures."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_ref_infra] not in Lane Pilot: The release profile schema and the onboarding teaching order."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_tpl_summary] not in Lane Pilot: Minimal, standard and complex SUMMARY.md forms."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_tpl_codebase] not in Lane Pilot: Seven forms for the codebase map documents."); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_d_tpl_research] not in Lane Pilot: Stack, features, architecture, pitfalls and summary."); // deferral:dfr_seed_skip_sma_gaps
});
