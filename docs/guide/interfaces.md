---
title: CLI, agent tools, UI and RPC
topic: interfaces
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, interfaces]
updated: 2026-11-06
sources:
  - src/rooms/tools/server/cli.ts
  - src/rooms/contracts/index.ts
  - server.ts
---

# CLI, agent tools, UI and RPC

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## The `bb lane-pilot` CLI

One command, `bb lane-pilot <subcommand>`, registered in `src/rooms/tools/server/cli.ts`, with handlers in the rooms. A PM's shell cannot start work (`schedule create|update|run-now`, `dispatch-bb`, `workflow-trigger`, `council`) for a request the phase rails took; automations are not touched.

The full list, one line per command, is generated from the CLI's own registry into [the atlas](../atlas.md) (section «CLI commands»); `bb lane-pilot` without arguments prints every usage line. The ones used most:

| Command | What it does |
|---|---|
| `state <project-id>`, `timeline <task-id>` | Runs and attempts of a project; the whole story of one task from the receipts. |
| `metrics <project-id>`, `money`, `cost` | Per-attempt stages, time, tokens and cost; monthly spend and its cap; cost per verified result. |
| `waiting`, `wall`, `lead` | What waits for the owner; what the night loop did; the lead's proposals. |
| `memory search\|write`, `anamnesis`, `rules` | The project memory, the owner profile, rules by form. |
| `errands diagnose\|episodes-sweep\|process-key-eval` | Repeated errands and their cost; the episode pass; the process-key score. |
| `schedule`, `workflow-trigger`, `workflow-answer` | The schedule board; start a graph; answer a graph's question. |
| `jev calibrate\|watch`, `capabilities`, `health` | Jev accuracy; provider capability table; breakers and budgets. |
| `revert`, `reverify`, `regress`, `return` | Undo an accepted merge, re-run checks, regression bisect, send a task back to a stage. |
| `docs-nightly`, `coverage`, `skill-lint` | The nightly docs pass now; coverage of rooms by drills and tests; check a skill folder. |

Two commands belong to the opt-in measurements described under [Experimental features](settings.md#experimental-features): `bb lane-pilot checkers diff-hidden` and `bb lane-pilot writer trajectories export`.

## Agent tools

Tools are registered in the rooms and exposed to agents through the `bb-bridge` server. A compiled Claude Code profile holds at most 64 tools, so the PM sees a folded list: core tools by name, and a few family tools with an `action`. `lane_pilot_tool_search` finds a capability by words or by an old tool name and returns its family, action and argument schema. The old names stay registered for roles that still name them.

**PM core tools (by name)**

| Tool | Purpose |
|---|---|
| `lane_pilot_read` | Read a bounded slice of a file in the run's writer workspace. |
| `lane_pilot_dispatch_writer`, `lane_pilot_wait_writer`, `lane_pilot_answer_writer` | Start a task-v2 contract, wait up to 240 s for the receipt, answer a writer's `NEEDS_HUMAN` question. |
| `lane_pilot_update_task`, `lane_pilot_cancel_task`, `lane_pilot_reassign_task` | Change a queued or blocked task in place, cancel unwanted tasks, move a running task to a fresh writer thread. |
| `lane_pilot_workspace_status`, `lane_pilot_run_health` | Status and diff of the managed workspace; breaker state and run budget. |
| `lane_pilot_ask_owner` | Ask the owner as a form in the chat (with a push). |
| `lane_pilot_errand`, `lane_pilot_wait_errand` | Start and wait for a non-code errand. |
| `lane_pilot_route`, `lane_pilot_run_workflow`, `lane_pilot_workflow_status`, `lane_pilot_workflow_amend` | Match a request to a workflow, start it, read its progress, change a run's goals. |

**PM family tools**

| Tool | Actions |
|---|---|
| `lane_pilot_helpers` | `specialist`, `wait_specialist`, `browser`, `browser_qa` |
| `lane_pilot_council` | `start`, `status`, `say`, `stop` |
| `lane_pilot_relay` | `ask`, `reply`, `list` |
| `lane_pilot_memory` | `context`, `routing_stats`, `lessons_sweep`, `rule_propose`, `lesson`, `learned` |
| `lane_pilot_workflow_draft` | `capabilities`, `create`, `patch`, `get`, `test`, `publish` |
| `lane_pilot_schedule` | List, show with run history, create, change, delete, pause, resume, run now. |
| `lane_pilot_phase` | Take the owner's goal through discussion, planning, design, execution, verification, acceptance and lessons. |
| `lane_pilot_queue` | Hold tasks until a date or a release, release them, list dead letters. |
| `lane_pilot_facts` | Answer questions about tasks, limits, the past or a failure from Lane Pilot's records. |
| `lane_pilot_check` | Run a quick, full or browser check the owner asked for. |
| `lane_pilot_permit` | Allow or deny the one command a guard refused for a writer (permanent deletes, DROP/TRUNCATE). |
| `lane_pilot_forge` | Actions `draft`, `lint`, `enable` (request, confirm), `list`. |
| `lane_pilot_tool_search` | Find a capability by words. |

**Other roles**

| Role | Tools |
|---|---|
| Workflow architect | `lane_pilot_read`, `lane_pilot_ask_owner`, `lane_pilot_workflow_draft`, `lane_pilot_relay`, `lane_pilot_tool_search`, plus read-only Read, Glob, Grep, WebFetch, WebSearch. |
| Specialists and custom agents | `lane_pilot_schedule` only, so "every Monday collect..." can be said in the specialist's own chat. Internal sessions (`project-onboarder`, `browser-qa`) get none. |
| Employees' lessons | `lane_pilot_employee_lesson`, `lane_pilot_employee_remark` (record or judge an owner remark about an employee). |
| Handoff | `lane_pilot_handoff_create`, `_receipt`, `_list`: a typed card (objective, acceptance, inputs, budget, deadline) with a receipt. |
| Diagnostics | `lane_pilot_gate_report`, `lane_pilot_ingest_opencode_telemetry`, `lane_pilot_memory_golden`. |

Writers in code worktrees get no `lane_pilot_*` tools in these allow-lists. In helper threads on Codex, OpenCode v2 and Cursor, `bb`, `ssh`, `scp` and `sftp` sit behind guard wrappers and `LANE_PILOT_ROLE` is set.

## UI surfaces

Lane Pilot adds three pages to the BB sidebar and several panels to threads.

**Pages**

| Page | What it holds |
|---|---|
| Lane Pilot | The settings and operations app. A scope rail on the left; the system pages are General settings, Agents, Tokens, Workflows, Automation (the schedule board), Tasks, Self-improvement and Waiting for you (with a count badge). Below them, one entry per project. |
| Council | Council sessions and the office view. |
| Lane Pilot - cockpit | Screens of the product map: Home, Phases, Today, Tasks, Money, Workers, Forge, Memory, First run, Coordination, Ship, System, Screens. |

**Project tabs.** The same six tabs exist at system, project and section level: Overview, Team, Work, Knowledge, Automation, Runs. Four of them (Team, Work, Knowledge, Automation) have a Basic/Advanced switch.

| Tab | Content |
|---|---|
| Overview | Project status and how to start. |
| Team | The role roster with each role's model and pool, plus "Agent access". |
| Work | Writer, critics, Jev provider panel (global only) and the other work settings. |
| Knowledge | Segments Memory, Documents, Rules, Anamnesis. Rules need a project or section; Anamnesis belongs to the system level. |
| Automation | Segments Workflows, Schedule. |
| Runs | Segments Active, History, Analytics, Council, Service. |

**In chats.** The composer action "Enable Lane Pilot" and the "Lane Pilot / agent" menu pick the PM, a specialist or the workflow architect for a new chat; a banner shows the selected agent. A "Lane Pilot helpers" tab and an actions-menu entry open the helpers of a thread. The thread info panel shows what Lane Pilot is doing for the chat (tasks now, step by step), and a context segment above the composer shows the same. A PM line `::lane-run{id="..."}` renders a live run card. Questions to the owner (PM, gate, repair thread, council) arrive as BB pending interactions, which BB's notification plugin also sends to the phone. Sidebar rows of helper threads carry a short role mark. Several of these slots are feature-tested, so older BB versions draw less.

**Pixel World.** `packages/world-sim` is a deterministic simulation of a small city whose districts, building sites and people follow Lane Pilot's real work. The hub ticks it (`src/rooms/world/server`); it is off until the owner enables it (KV `world:enabled`, RPC `world_enable`). RPCs `world_snapshot`, `world_events` and `world_status` serve a client. `packages/pixel-world` is the three.js engine behind it; the council office is its first scene.

## RPC and BB hooks

The plugin's RPC surface is one validated contract built from eight method maps: shell, native, runs, settings, ops, knowledge, workflow and world. Inputs are strict, and each handler is timed. The host worker has a separate `hostContract` (native install, git worktree and integrate, host jobs, snapshots, council and Jev calls). See `docs/rpc-callers.md` and `docs/rpc-callers/contract-map.md`.

BB hooks: `message.dispatch` runs `handleNativeDispatch` (resolves the selected agent profile and the thread binding, and records owner presence); a mention provider resolves the `native-selection:<token>` the composer attached; an environment contributor adds the native launcher and, for helper threads, `LANE_PILOT_ROLE` and the guard `PATH`. Hook time limits are set in `package.json` (`messageDispatch` 20 s, `contributeEnv` 10 s), with a 300 s drain on reload.

## Sources

Where this page's claims start in the code: `src/rooms/tools/server/cli.ts:62-82`, `src/rooms/contracts/index.ts:15-32`, `server.ts:77-97`. The deep pages linked above cite the rest.
