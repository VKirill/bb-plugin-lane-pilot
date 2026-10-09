# Picked skills must be loadable by OpenCode writers (v2, after writer-skill-pick-v2)

Lane Stack's `opencode-lane` guard (~/.config/opencode/plugins/opencode-lane/guard.ts) checks the `skill` tool. It allows a fixed set: ui-ux-pro-max, writer-practices and karpathy-guidelines. It also allows a skill that exists as `.opencode/skills/<name>/SKILL.md` in the writer's cwd or a parent up to the git root (`projectHasSkill`). Every other skill is refused with «[opencode-lane guard] skill blocked». So Jev-picked skills (from writer-skill-pick-v2) would be blocked for OpenCode writers.

## Fix
1. When the writer provider is `acp-opencode` and the task has picked or hinted skills beyond the base profile, materialize them before the spawn:
   - put each one at `<attempt worktree>/.opencode/skills/<name>/` on the writer's host, as a symlink to the skill folder from the catalog's `filePath`, or a copy if symlinks are not possible;
   - do it through the existing host-call layer that prepares the worktree, with no sync spawns in the host worker.
2. Keep these files out of the diff and the ownership checks. Use `.git/info/exclude` in the worktree, or extend the existing bookkeeping-path ignore list (`.agents/`, `.bb/`, `.claude/`). The dirt snapshot, run-scope and owns_paths validation, and the merge must never see them. Remove them when the attempt ends.
3. In live-folder mode (no git), skip this and log one line.
4. Record which skills were materialized in the attempt's stage result.

## Checks
- A unit test with a stubbed host call:
  - an OpenCode writer with picked skills gets the materialize call with the right names and paths;
  - codex and claude writers get none;
  - `.opencode/skills/**` is ignored by the dirt and ownership classifier;
  - cleanup is called when the attempt ends.
- Typecheck.

## Delivery
- [x] Materialized Jev-picked skills for OpenCode writers in ignored, cleaned-up worktree skill folders — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `0d58e62`.
