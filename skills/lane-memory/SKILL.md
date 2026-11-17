---
name: lane-memory
description: "One project fact memory on the BB hub (Lane Pilot), the same from every machine; lessons become hub rules. Use when user says память, lane-memory, corpus, CORE, урок, почему бот забыл, or an agent needs durable non-code facts; `$ARGUMENTS` exactly info prints the card. Not PROGRESS dumps."
argument-hint: "[info]"
---

# Lane memory

Facts that **cannot be derived** from git or the code documentation (docs/).
Laws from the SMA 5.6.1 drawing.

**Where it lives.** One memory per project on the BB hub (Lane Pilot's database), whatever machine the session
runs on. At a terminal, read with `bb lane-pilot memory search "<question>" [--project P]` and write with
`bb lane-pilot memory write "<fact>" [--project P]`; inside a Lane Pilot PM chat, use the `lane_pilot_memory`
tool for context and lessons. `.agents/memory/` files are not written any more; `sensitive` records go to the hub too.
The memory is kept up by Lane Pilot itself, with no person in the loop: its write door merges repeats and retires or evicts notes by itself. Do not write memory into `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or any file of the project, and do not wait for a person to apply a merge.

**Lessons.** A correction or a landmine is a rule, not a file line. Inside a Lane Pilot PM chat, the tool
`lane_pilot_memory` with `action: "lesson"` records it (runId, rule, audience `pm`, `writer` or `both` — required,
`always` optional). The terminal `bb lane-pilot memory write` door records a factual note; this skill defines no
terminal lesson command.
`audience: "pm"` — planning, task contracts, reviewing reports, merging, deploying: writers never get it. `audience: "writer"` —
how code is edited and checked inside one task. `always: true` only for a rule that holds for every writer task whatever
it changes (how to run or read any command); otherwise System One gives it to the tasks it fits. The hub merges
repeats, keeps at most 12 rules in force on trial, retires unused ones and lets at most 30 wait. Never append to
`.agents/LESSONS.md`.

> **Inside a Lane Pilot chat** (`LANE_PILOT_AGENT_TYPE` set / tools `lane_pilot_*` present) the hub is already on: read with `lane_pilot_memory` `action: "context"` (runId, query), write a lesson with `lane_pilot_memory` `action: "lesson"`, and do not create `.agents/memory/` files or drafts there. Do not call agentmemory tools (`memory_save`, `memory_smart_search`): that would start a second memory.

> **Memory-maintainer stage:** when the host gives you an accepted task and asks for a JSON array of memory candidates, answer with that array only; do not call memory tools or edit files.

## Info

If `$ARGUMENTS` is exactly `info`, print `references/info.md` verbatim (Russian) and stop.

## Work

On cold start CORE is already in `project-resume` (Lane Pilot: in the session brief). At a terminal, search the hub with
`bb lane-pilot memory search "<task>" --project <project-id>` and read the named sources. A recalled claim
about the tree is a prompt to verify the repository, not proof.

Write a fact only through the documented CLI door, `bb lane-pilot memory write "<fact>" [--project <project-id>]`.
Keep durable memory out of `.agents/memory/`; the CLI writes to the hub and this skill does not define a local draft,
`--apply`, `--confirm`, installer or fallback command.

```bash
bb lane-pilot memory write "One concise factual claim" --project <project-id>
```
