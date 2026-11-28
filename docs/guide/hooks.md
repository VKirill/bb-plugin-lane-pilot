---
title: The hook standard
topic: hooks
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

## The six rules

| # | Rule | Why |
|---|---|---|
| 1 | **Fail-open.** A hook never wedges or reddens a session: any failure is swallowed and the exit is 0. Only a guard that means to refuse a call exits non-zero. | A missing file must not print an error on every session start. |
| 2 | **Anchored to the project root.** Paths start from `"$CLAUDE_PROJECT_DIR"`: never from the session's current folder, never from a hard-coded checkout. | A hook inherits the session's folder; a session in a worktree must check its own tree, not the main checkout. |
| 3 | **Speaks only when there is something to say.** Pointers (file, line), not bodies; at most 2 KB at session start; nothing repeated within a session. | Hook output is context every later turn pays for. |
| 4 | **Soft budget of 1.5 seconds per tool call.** One process per event where the checks are ours; a check that needs longer does not live on every tool call. | Fifty edits times a 3-second check is minutes of a session. |
| 5 | **Own entries only.** An installer merges without removing or reordering foreign entries, doubles nothing on a re-run, removes its own stale spellings, and strips only its own on removal. | The person's hooks are theirs. |
| 6 | **A worker's hook layer is known.** A hook the worker cannot read or run is removed with a named reason, not left to fail in every worker session. | A worker pays for the person's hooks without being able to fix them. |

## The layers on a machine

| Layer | Where | State against the rules |
|---|---|---|
| Lane Pilot's session hooks | `src/rooms/session-hooks`, written per native session by `native-session-hooks.ts` | Built to the rules: one fail-open process, six streams under the 1.5 s budget, the pack for a subagent, the stall detector, the capsule before compaction; merged over the project's and the person's hooks without removing them. |
| Lane Pilot's guards | `lane-stack/hooks/guard_shell.py` and the `guard-*.sh` scripts in `~/.claude/hooks` | Refuse on purpose (rule 1's exception). Three processes on a shell call, about 60 ms together (measured 2026-11-10). |
| The person's hooks | `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, plugins | Checked by the audit below. Loaded by the owner's own chats and a PM chat only: a helper or writer on Claude Code does not load the `user` setting source (see «One layer on every machine»). |
| A project's hooks | `<project>/.claude/settings.json` | Checked by the audit below. A tracked file reaches a writer's worktree. |

## The audit

`python3 scripts/hooks-audit.py [root]` reads every live `.claude/settings.json` under the root and Codex's `~/.codex/hooks.json`
(archives, backups and worktrees are skipped; `--host <machine-id> <home> [project-root ...]` does the same on another BB machine through `bb file`) and reports, without running any hook: an inline command that is not fail-open, a hard-coded checkout path, a start hook reading
a relative path, and a command naming a file that does not exist. Exit 1 on a finding.

First run, OVH, 2026-11-10: a start hook reading `wiki/index.md` exited 1 on every session start in the six projects that have no
`wiki` folder (removed there; made fail-open and anchored in the two projects that have one); a start hook read a skill file that no longer exists
(removed); the edit hooks of two projects ran in the hard-coded main checkout, so a session in a worktree typechecked and auto-fixed
the owner's files instead of its own (anchored). The audit reports 0 findings since.

## One layer on every machine

The person's layer is not the same on every machine, and nothing synchronizes it (the agent-tools plugin synchronizes MCP servers and
skills, not hooks). Measured 2026-11-10 through `scripts/hooks-audit.py --host`:

| Layer | OVH | Mac mini | MacBook | Windows |
|---|---|---|---|---|
| Lane Pilot threads in 14 days | 3,735 | 2,837 | 0 | 0 |
| Lane Pilot's guard (`~/.agents/lane-pilot/pm/guard_shell.py`) | same file | same file | same file | absent |
| The person's Claude Code hooks | 14 | 0 | 0 | 1 |
| The person's Claude Code plugins | typesafe, fast-jev-compaction and two output-style plugins | remotion, fast-jev-compaction and one output-style plugin | fast-jev-compaction and one output-style plugin | none |
| Codex hooks (`~/.codex/hooks.json`) | 2 (the old Lane Stack guard) | 0 | 0 | 0 |
| Project hooks | 6 in 5 projects | 0 | 0 | 0 |
| Audit findings | 0 | 0 | 0 | 0 |

So a helper on Claude Code ran under fourteen extra hooks on OVH and under none on the Mac mini. Since 0.1.505 a helper's or writer's
launcher drops the `user` setting source (`MERGE_SETTINGS_PY` in `native-claude-host.ts`): its layer is Lane Pilot's bundle, the
project's own hooks (they travel with the repository) and BB core's flags, the same wherever the thread lands. The person's env keys
no longer reach a helper either. MCP servers still connect: they are not a setting source. A PM chat keeps
the person's layer.

What a helper no longer inherits on OVH, with the reason (rule 6: removed with a named reason):

| The person's hook | Reason | Fired in 1,416 Claude Code sessions, 14 days |
|---|---|---|
| `guard-secrets.sh` | Lane Pilot's guard has its own secrets layer | 0 |
| `guard-lockfile-rm.sh` | answers «ask», and nobody answers a helper | 0 |
| `gitnexus-impact-check.sh` | ran on one machine and one provider only; the rule stays in the project's instructions | 10 sessions |
| `guardian-code.sh` | lint-level; the task's own checks cover it | 17 sessions mention it |
| `gitnexus-hook.cjs` | 97% of its output was «Local augment is unavailable» (now filtered in the person's settings too) | 70 sessions |
| tmux state, clipboard image, project-wiki | terminal-only or for the owner's own agents | n/a |

## The person's rules: one file on the hub

How an answer is shaped for the owner and how code is built are not hook output any more.
They are one file, `~/.bb/AGENTS.md` on the hub: BB core reads it as the user's instructions into every thread of every provider on
every machine (delivery checked 2026-11-10 on Codex, Claude Code, Devin, Cursor and OpenCode on OVH and on Codex on the Mac mini). A helper does not get it: `userInstructions` is off in a
role's default context (`helper-context.ts`), and a writer has the ladder in the hub skill `lp-writer`.

The two output-style plugins that used to carry these rules were removed from every machine on 2026-11-28. Before the hub file
the rules reached Claude Code and Codex chats on OVH only, twice in a chat that had both the plugin and the instructions file, and
were paid again after every compaction.

To change a rule, edit the hub file; nothing is copied to a machine.

Claude Code's auto-memory is off for every BB thread since 2026-11-10 (`bb plugin config provider-claude-code set memoryEnabled false`;
the core passed `autoMemoryEnabled: true` over the person's own `settings.json`). A project's memory is the Lane Pilot memory on the hub;
the notes that were in `~/.claude/projects/*/memory` on OVH were copied there (146 of 150; four hold credentials and were refused).

## Known deviations

- `apps/feed-gen` runs `tsc --noEmit` over the whole project after every edit: 3.5 seconds (measured), over the budget of rule 4. Kept: it is
  the owner's own per-edit check.
- Codex on OVH has two hook entries in `~/.codex/hooks.json`; the Macs have none. Both are shims left by the Lane Stack cleanup: the shell one forwards to
  Lane Pilot's guard (the same file the Macs have), the edit one exits 0. Left in place: editing the file drops the trust Codex gave it, which only the owner can give again.
- Windows has no Lane Pilot layer: `host-detect` refuses a Windows path, the guard is a `python3` script. No Lane Pilot thread ran
  there in 14 days.
- The static audit cannot see what a script file does: `guard-*.sh`, `gitnexus-hook.cjs` and plugin hooks answer for their own exit code.
