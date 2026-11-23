# Clean Subthread Delegation & In-Project Setup

Lane Pilot combines two execution layers borrowed and unified with AI Factory (`bb-plugin-aif-helper`) and BB Session Context (`project-folders` `0.8.6+`):

1. **Project-local context and skills inside the repository (`.agents/pilot/` + `.bb/skills/`):**
   - Every prepared project carries its own manifest (`.agents/pilot/config.json`), stack/command description (`.agents/pilot/DESCRIPTION.md`), module boundaries (`.agents/pilot/ARCHITECTURE.md`), base conventions (`.agents/pilot/rules/base.md`), and standardized Pilot skills inside `.bb/skills/<name>/SKILL.md`.
   - BB Core (`readWorkspaceAgentContext`) discovers `.bb/skills/` directly from the workspace, and clean subthreads read exact files from disk without needing 250+ machine-global skills in their prompt.
   - When Lane Pilot activates on an unprepared checkout, `bootstrapProjectForPilot` automatically materializes `.agents/pilot/` starter files and syncs standardized skills into `.bb/skills/` without overwriting user files.

2. **Guaranteed clean subthread sessions (zero extraneous plugins or skills):**
   - SDK-spawned helpers (`fullAccessSpawn`) automatically attach `cleanSubthreadPolicyField`, narrowing plugins, skills, and MCP servers to the role's exact profile on `"default"` (`standard`) service tier.
   - CLI-spawned subthreads (`bb thread spawn --parent-self ...`) automatically receive BB's `subthreads` session-context rule (only built-in BB essentials + `bb-bridge` + project `AGENTS.md`).

## Coordinator → Worker Task Handoff Rules

Whether delegating through `lane_pilot_dispatch_writer` (isolated worktree writer lanes) or native `bb thread spawn` (`lp-implement` on `.agents/pilot/plans/<slug>.md`):

1. **Coordinator owns orchestration:** Only the coordinator updates plan checkboxes, runs post-worker merge/verification gates, and decides commits.
2. **One task per worker brief:** Give each worker a written brief naming:
   - Single task ID, goal, `owns_paths`, and `read_first` files (`AGENTS.md`, `.agents/pilot/ARCHITECTURE.md`, `.agents/pilot/rules/base.md`)
   - Explicit ban on nested subagent spawning, plan-checkbox edits, branch switching, and commits
   - Scoped verification commands and a cap of 2 local fix-and-reverify rounds
   - Structured output fields (`files_modified`, check exit codes, `docs_recommended`, `commit_recommended`, and `handoff_outcome: blocked_external` on genuine requirement conflicts)
3. **Idempotent child lookup before spawn:** Check `bb thread list --parent-thread "$BB_THREAD_ID" --json` for title `LP · <plan> · Task <N>` before spawning a duplicate worker, always pass `--service-tier 'default'` and `--parent-notifications off`, wait with `bb thread wait <id> --status idle`, and verify `git diff` + checks yourself before marking the task done.
