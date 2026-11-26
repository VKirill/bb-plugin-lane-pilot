import { stringAt } from "@lane-pilot/kit";

/**
 * The agent_type the bundled guard's deny list keys on. A PM's metadata role is `pm`; the guard's PM rules
 * key on `lane-pilot-pm`. Every other role is already the guard's name (errand, writer, code-critic, …).
 * (2026-10-29 claude-guard)
 */
export function claudeGuardAgentType(role: string): string {
  return role === "pm" ? "lane-pilot-pm" : role;
}

/**
 * Claude Code built-ins a background helper never uses: orchestration, self-wakeups, questions nobody answers, its own
 * subagents. Their definitions are ~40 KB of every helper's first request (Workflow alone 22.9 KB, measured 2026-11-07).
 * A second `--disallowedTools` from BB core adds to this one (real claude run: both sets are removed). PM keeps them.
 */
export const HELPER_DISALLOWED_TOOLS = "Workflow,ScheduleWakeup,AskUserQuestion,Agent";

/** Push, merge, tag and release stay human-only (SMA wb_human_only): the denial rides the launch, not only a call-time check. */
export const WRITER_DISALLOWED_TOOLS = "Bash(git push:*),Bash(git merge:*),Bash(git tag:*),Bash(gh release:*)";

/** Roles that never push, merge, tag or release; same set the bundled guard keys on (LANE_PILOT_WRITER_ROLES). */
export const WRITER_ROLES = new Set(["writer", "emergency-writer"]);

/** Validates `laneTaskDir` metadata (`<abs>/.agents/tasks/<id>` with no `..` traversal). */
export function parseTaskDir(metadata: unknown): string | null {
  const dir = stringAt(metadata, "laneTaskDir");
  if (!dir || !/^\/(?:[^\0]*\/)?\.agents\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dir) || dir.split("/").includes("..")) return null;
  return dir;
}

/**
 * Turn ceiling on a writer's claude launch (`--max-turns`). 0 = no ceiling, the default: a long task legitimately runs
 * hundreds of turns, and a fixed cap would cut finished-in-all-but-name work; stalls are caught by the silence and spin
 * sweeps and by the token budget. The launch carries the flag whenever a ceiling above zero is passed.
 */
export const WRITER_MAX_TURNS = 0;
