import { describe, it } from "vitest";

/**
 * Cards whose behaviour belonged to Claude Lane's install.sh / lane-stack-remove / sma-framework.
 * Lane Pilot's installer no longer does these, and the product does not need them back. (2026-10-29)
 */
describe("install cards Lane Pilot no longer needs", () => {
  it.todo("[sma:k_lib_deleteme] removal does not reverse SMA's eight targets (engine, runtime, roles, skills, aliases, hooks, blocks, .sma); LP only moves lane hooks and lane-* bins aside");
  it.todo("[sma:k_rm_statusline] leftover cleanup deletes lane-statusline and does not restore a saved personal statusLine");
  it.todo("[sma:k_rm_self] LP never installs /sma-* commands, so there is no workflow left to remove on restart");

  it.todo("[sma:k_in_npx] there is no npx sma-framework init; install copies LP's guard and does not run install.sh");
  it.todo("[sma:k_in_flags] no --local / --global / --gsd-aliases flags; the home is the only target");
  it.todo("[sma:k_in_engine] sma-core workflows, roles and templates are not rsynced into the home");
  it.todo("[sma:k_in_localpaths] project links are not rewritten from the home Claude config");
  it.todo("[sma:k_in_runtime] scripts/sma CLI and libraries are not copied to the path hooks call");
  it.todo("[sma:k_in_agents] sma-*.md role files are not written into .claude/agents");
  it.todo("[sma:k_in_carry] owner-added role lines are not carried; LP does not rewrite role files");
  it.todo("[sma:k_in_commands] the sixteen /sma-* workflows are not selected or installed");
  it.todo("[sma:k_in_skills] no thin SKILL.md is written per /sma-* command");
  it.todo("[sma:k_in_skillbody] there is no skill body that points at an SMA workflow file");
  it.todo("[sma:k_in_aliases] /gsd-* aliases are not installed, with or without a flag");
  it.todo("[sma:k_in_hooktable] nine project-rooted SMA hook events are not installed; the proof NATIVE_HOOK_SOURCES is the guard script text, not a hook table");
  it.todo("[sma:k_in_statusline] no status-line segment is written into project settings, and a personal line is not wrapped");
  it.todo("[sma:k_in_dirs] .sma/ sessions, claims, journal and a .gitignore line are not created");
  it.todo("[sma:k_in_memory] TAGS.md and an empty MEMORY.md skeleton are not created; an existing corpus is not an install concern");
  it.todo("[sma:k_in_rules] no SMA memory-rules block is injected into CLAUDE.md; LP only splices a caller-supplied lane-pilot marker");
  it.todo("[sma:k_in_done] install does not report 'run /sma-start' as the next step");

  it.todo("[sma:k_st_engine] .claude/sma-core is not an installed store");
  it.todo("[sma:k_st_runtime] scripts/sma is not an installed store");
  it.todo("[sma:k_st_agents] .claude/agents/sma-*.md is not an installed store");
  it.todo("[sma:k_st_skills] .claude/skills/sma-* sixteen wrappers are not an installed store");
  it.todo("[sma:k_st_sma] project .sma state drawers are not created");
  it.todo("[sma:k_st_claudemd] SMA:RULES and memory-export markers are not written; the live markers are # lane-pilot:managed");
  it.todo("[sma:k_lib_statusline_install] there is no shared statusLine merge used by an install verb");
  it.todo("[sma:k_lib_scaffold] there is no memory-corpus scaffold of tags plus an empty index");

  it.todo("[sma:k_up_cmd] /sma-update is not installed as a skill");
  it.todo("[sma:k_up_report] there is no dry-run of installed vs latest npm vs a nearby checkout; detectStack only compares install.json to TARGET_SHA and does not call a registry");
  it.todo("[sma:k_up_older] nothing refuses an older pin; a different sha is not compared as a version, and rollback is not a separate manual installer");
  it.todo("[sma:k_v_update] there is no sma update command that reports a version and re-runs the installer on --yes");
  it.todo("[sma:k_lib_update] there is no update library that compares versions and plans one installer run");
  it.todo("[sma:k_up_npm] an unreachable npm registry is not turned into a report line, because update does not query npm");
  it.todo("[sma:k_up_local] a sibling folder with bin/init.mjs is not an update source; claude-lane-stack-installed is only a leftover to move aside");
  it.todo("[sma:k_up_legacy] update.md changelog-and-cache workflow is not shipped and has no proof in this tree");
  it.todo("[sma:k_up_reapply] saved person patches are not merged onto a new engine version, and that workflow is not installed as a skill");
});
