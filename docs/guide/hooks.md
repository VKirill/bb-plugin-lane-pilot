---
title: The hook standard
type: reference
status: active
created: 2026-11-10
confidence: medium
tags: [guide, hooks, hosts, sessions]
updated: 2026-11-10
sources:
  - src/rooms/session-hooks/cli.ts
  - src/rooms/session-hooks/logic.ts
  - src/rooms/native-agent/native-session-hooks.ts
  - lane-stack/hooks/guard_shell.py
  - scripts/hooks-audit.py
---

# The hook standard

A hook is a command the agent's CLI runs around a session event: session start, a prompt, a tool call, compaction, the end of a turn.
Every agent session on a machine runs all of them, a writer and a helper included, so one bad entry is paid by every session.
The rules are the ones Maslov's SMA follows for its Claude Code hooks (his map, block «Claude Code session hooks» and «The init installer»;
the node ids are in brackets).

## The six rules

| # | Rule | Why | Maslov's map |
|---|---|---|---|
| 1 | **Fail-open.** A hook never wedges or reddens a session: any failure is swallowed and the exit is 0. Only a guard that means to refuse a call exits non-zero. | A missing file must not print an error on every session start. | `k_h_failopen` |
| 2 | **Anchored to the project root.** Paths start from `"$CLAUDE_PROJECT_DIR"`: never from the session's current folder, never from a hard-coded checkout. | A hook inherits the session's folder; a session in a worktree must check its own tree, not the main checkout. | `k_in_anchor` |
| 3 | **Speaks only when there is something to say.** Pointers (file, line), not bodies; at most 2 KB at session start; nothing repeated within a session. | Hook output is context every later turn pays for. | `k_hss_out`, `k_hpr_out`, `k_hpr_seen`, `k_hss_preact` |
| 4 | **Soft budget of 1.5 seconds per tool call.** One process per event where the checks are ours; a check that needs longer does not live on every tool call. | Fifty edits times a 3-second check is minutes of a session. | `k_hp_budget`, `k_h_pre`, `k_h_turn_diff` |
| 5 | **Own entries only.** An installer merges without removing or reordering foreign entries, doubles nothing on a re-run, removes its own stale spellings, and strips only its own on removal. | The person's hooks are theirs. | `k_in_merge`, `k_in_stale`, `k_rm_hooks` |
| 6 | **A worker's hook layer is known.** A hook the worker cannot read or run is removed with a named reason, not left to fail in every worker session. | A worker pays for the person's hooks without being able to fix them. | `ap_personal`, `m_pl_unreadable` |

## The layers on a machine

| Layer | Where | State against the rules |
|---|---|---|
| Lane Pilot's session hooks | `src/rooms/session-hooks`, written per native session by `native-session-hooks.ts` | Built to the rules: one fail-open process, six streams under the 1.5 s budget, the pack for a subagent, the stall detector, the capsule before compaction; merged over the project's and the person's hooks without removing them. |
| Lane Pilot's guards | `lane-stack/hooks/guard_shell.py` and the `guard-*.sh` scripts in `~/.claude/hooks` | Refuse on purpose (rule 1's exception). Three processes on a shell call, about 60 ms together (measured 2026-11-10). |
| The person's hooks | `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, plugins (ADHD, Ponytail) | Checked by the audit below. |
| A project's hooks | `<project>/.claude/settings.json` | Checked by the audit below. A tracked file reaches a writer's worktree. |

## The audit

`python3 scripts/hooks-audit.py [root]` reads every live `.claude/settings.json` under the root (archives, backups and worktrees are
skipped) and reports, without running any hook: an inline command that is not fail-open, a hard-coded checkout path, a start hook reading
a relative path, and a command naming a file that does not exist. Exit 1 on a finding.

First run, OVH, 2026-11-10: a start hook reading `wiki/index.md` exited 1 on every session start in the six projects that have no
`wiki` folder (removed there; made fail-open and anchored in the two projects that have one); a start hook read a skill file that no longer exists
(removed); the edit hooks of two projects ran in the hard-coded main checkout, so a session in a worktree typechecked and auto-fixed
the owner's files instead of its own (anchored). The audit reports 0 findings since.

## Known deviations

- `apps/feed-gen` runs `tsc --noEmit` over the whole project after every edit: 3.5 seconds (measured), over the budget of rule 4. Kept: it is
  the owner's own per-edit check.
- A worker session still inherits every hook of the person and the project (rule 6 is met only for native sessions Lane Pilot launches).
- The static audit cannot see what a script file does: `guard-*.sh`, `gitnexus-hook.cjs` and plugin hooks answer for their own exit code.
