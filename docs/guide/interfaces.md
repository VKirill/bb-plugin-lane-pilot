---
title: CLI, agent tools, UI and RPC
topic: interfaces
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, interfaces]
updated: 2026-11-27
sources:
  - src/rooms/tools/server/cli.ts
  - src/rooms/contracts/index.ts
  - src/rooms/pages/models/nav-model.ts
  - src/rooms/pages/ui/console-shell.tsx
  - src/rooms/runs/ui/chat-panel.tsx
  - server.ts
---

# CLI, agent tools, UI and RPC

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## The `bb lane-pilot` CLI

One command, `bb lane-pilot <subcommand>`, registered in `src/rooms/tools/server/handlers/cli-commands.ts`, with handlers in the rooms. A PM's shell cannot start automations (`schedule create|update|run-now`, `dispatch-bb`, `workflow-trigger`).

The full list, one line per command, is generated from the CLI's own registry into [the atlas](../atlas.md) (section «CLI commands»); `bb lane-pilot` without arguments prints every usage line. The ones used most:

| Command | What it does |
|---|---|
| `state <project-id>`, `timeline <task-id>` | Runs and attempts of a project; the whole story of one task from the receipts. |
| `metrics <project-id>`, `money`, `cost` | Per-attempt stages, time, tokens and cost; monthly spend and its cap; cost per verified result. |
| `waiting`, `lead`, `checkers` | What waits for the owner; the lead's hypotheses; planted-defect scorecard and drills. |
| `memory search\|write\|eval\|probe\|tiers\|conflicts` | Project memory search, writes, retrieval evaluation, path probes, cold tier, conflicts. |
| `errands diagnose` | Repeated errands and their cost. |
| `schedule`, `workflow-trigger`, `workflow-answer` | Schedule board (including `pause-all`/`resume-all`); start a graph; answer a graph's question. |
| `health` | Breakers, clock, budgets and platform health. |
| `revert`, `reverify`, `return` | Undo an accepted merge, re-run checks, send a task back to a stage. |
| `coverage`, `skill-lint` | Coverage of rooms by drills and tests; check a skill folder. |

## Agent tools

Tools are registered in the rooms and exposed to agents through the `bb-bridge` server. A compiled Claude Code profile holds at most 64 tools, so the PM sees a folded list: core tools by name, and a few family tools with an `action`. `lane_pilot_tool_search` finds a capability by words or by an old tool name and returns its family, action and argument schema. The old names stay registered for roles that still name them.

**PM core tools (by name)**

| Tool | Purpose |
|---|---|
| `lane_pilot_read` | Read a bounded slice of a file in the run's writer workspace. |
| `lane_pilot_dispatch_writer`, `lane_pilot_wait_writer`, `lane_pilot_answer_writer` | Start a task-v2 contract, wait up to 240 s for the receipt, answer a writer's `ASK_PM` question. |
| `lane_pilot_update_task`, `lane_pilot_cancel_task`, `lane_pilot_reassign_task` | Change a queued or blocked task in place, cancel unwanted tasks, move a running task to a fresh writer thread. |
| `lane_pilot_workspace_status`, `lane_pilot_run_health` | Status and diff of the managed workspace; breaker state and run budget. |
| `lane_pilot_ask_owner` | Ask the owner as a form in the chat (with a push). |
| `lane_pilot_errand`, `lane_pilot_wait_errand` | Start and wait for a non-code errand. |
| `lane_pilot_route`, `lane_pilot_run_workflow`, `lane_pilot_workflow_status`, `lane_pilot_workflow_amend` | Match a request to a workflow, start it, read its progress, change a run's goals. |
| `lane_pilot_propose` | Surface a structured proposal card (`::lane-draft{id="..."}`). |

**PM family tools**

| Tool | Actions |
|---|---|
| `lane_pilot_helpers` | `scout`, `wait_scout`, `specialist`, `wait_specialist`, `browser`, `browser_qa` |
| `lane_pilot_relay` | `ask`, `reply`, `list`, `handoff` |
| `lane_pilot_memory` | `context`, `history` |
| `lane_pilot_workflow_draft` | `capabilities`, `create`, `patch`, `get`, `test`, `publish` |
| `lane_pilot_schedule` | List, show with run history, create, change, delete, pause, resume, run now. |
| `lane_pilot_queue` | Hold tasks until a date or a release, release them, list dead letters. |
| `lane_pilot_facts` | Answer questions about tasks, limits, the past or a failure from Lane Pilot's records. |
| `lane_pilot_check` | Run a quick, full or browser check the owner asked for. |
| `lane_pilot_permit` | Allow or deny the one command a guard refused for a writer (permanent deletes, DROP/TRUNCATE). |
| `lane_pilot_tool_search` | Find a capability by words. |

**Other roles**

| Role | Tools |
|---|---|
| Workflow architect | `lane_pilot_read`, `lane_pilot_ask_owner`, `lane_pilot_workflow_draft`, `lane_pilot_relay`, `lane_pilot_tool_search`, plus read-only Read, Glob, Grep, WebFetch, WebSearch. |
| Lead | `lane_pilot_lead` (hypotheses and work-graph proposals). |
| Specialists and custom agents | `lane_pilot_schedule` only, so "every Monday collect..." can be said in the specialist's own chat. Internal sessions (`project-onboarder`, `browser-qa`) get none. |
| Handoff | `lane_pilot_handoff_create`, `_receipt`, `_list`: a typed card (objective, acceptance, inputs, budget, deadline) with a receipt. |
| Diagnostics | `lane_pilot_gate_report`. |

Writers in code worktrees get no `lane_pilot_*` tools in these allow-lists. In helper threads on Codex, OpenCode v2 and Cursor, `bb`, `ssh`, `scp` and `sftp` sit behind guard wrappers and `LANE_PILOT_ROLE` is set.

## UI surfaces

Lane Pilot adds one six-section owner console (`LanePilotPage` + `ConsoleShell`) to the BB sidebar and panels to threads.

**Console navigation and top bar**

The dark left sidebar (`ConsoleShell`, collapsing to a compact `Select` below 900 px) lists five main sections, and the **System** group pinned to the bottom (its caption opens the System landing) links the **System** sub-pages (`CONSOLE_SECTIONS` and `SYSTEM_PAGES` in `src/rooms/pages/models/nav-model.ts`). The **ScopeSwitcher** at the top of the sidebar (in the top bar when compact) chooses **All projects**, a single project, or a project section (`remember_project`), and **Brakes** (`BrakeButton` / `BrakesDialog`, above the System group; in the top bar when compact) exposes global pauses (`schedules`, `conveyor`, `graphs`, `staff`) and **Stop all**.

| Section | Content |
|---|---|
| **Overview** (`overview`) | Live KPIs, active runs table, closed-by-day chart, staff goals, and upcoming scheduled runs. |
| **Decisions** (`decisions`, with live `waiting` badge) | Tabs **Waiting for you** (`OwnerWaitingBoard`), **Weekly desk** (`ReviewDesk`), and **Done autonomously** (`ActionsLog`). |
| **Staff** (`staff`) | Chartered and task-based staff cards (`StaffList`), 3-step **Hire** wizard (`HireWizard`), and per-staff detail (`StaffPage`: Charter, Shifts, Autonomy + repo trust, Loadout, Costs). |
| **Work** (`work`) | Tabs **Tasks** (`TaskBoard` board/list + `TaskPage`), **Big projects** (`BigProjects`), and **Errands** (`ErrandsScreen`). |
| **Memory & history** (`memory`) | Tabs **Records** (`MemoryScreen` for project memory records and knowledge cards) and **Task history** (`HistoryScreen`). |
| **System** (`system`) | Hub tiles linking to **Graphs** (`WorkflowsScreen`), **Agents & loadout** (`AgentsLoadout` unified role matrix + `OwnedSettings` + `ModelOverridesPanel`), **Schedules** (`ScheduleBoard`), **Costs** (`CostsScreen` Spend & Quality), **Health** (`HealthScreen` canary, outages, drills, `ServiceSegment`), and **Settings** (`SettingsScreen`: Work and checks, Memory, Documents, Language & notifications across System / Project / Section with rare fields under **More**). |

Pre-redesign URLs and `scope` values (`LEGACY_TABS`, `LEGACY_SCOPES`) resolve to the corresponding console route via `resolveLegacyRoute`.

**In chats.** The composer action "Enable Lane Pilot" and the "Lane Pilot / agent" menu pick the PM, a specialist or the workflow architect for a new chat; a banner shows the selected agent. A "Lane Pilot helpers" tab (`lane-helper-thread`) and an actions-menu entry open the helpers of a thread. The fixed right-hand panel (`ChatPanel` in `experimental_tab` `lane-pilot-live`, plus the thread-header button and command palette shortcuts) shows a **Section / Whole project** scope switch (`thread_scope`), repository trust status (`repo_trust`), four tabs (**Tasks**, **Memory**, **History**, **Helpers**), repository autonomy rules, and a follow-up composer (`threads.send`); a context segment (`ThreadLive`) also appears in the thread info section. A PM line `::lane-run{id="..."}` or `::lane-draft{id="..."}` renders a live run or proposal card. Questions to the owner (PM, gate, workflow human wait) arrive as BB pending interactions, which BB's notification plugin also sends to the phone. Sidebar rows of helper threads carry a short role mark. Several of these slots are feature-tested, so older BB versions draw less.

## RPC and BB hooks

The plugin's RPC surface is one validated contract built from ten method maps: `rpcShell`, `rpcNative`, `rpcRuns`, `rpcSettings`, `rpcOps`, `rpcKnowledge`, `rpcWorkflow`, `rpcWorkflowExport`, `rpcWorkflowMap`, and `rpcConsole`. Inputs are strict, and each handler is timed. The host worker has a separate `hostContract` (native install, git worktree and integrate, host jobs, snapshots and model calls). See `docs/rpc-callers.md` and `docs/rpc-callers/contract-map.md`.

BB hooks: `message.dispatch` runs `handleNativeDispatch` (resolves the selected agent profile and the thread binding, and records owner presence); a mention provider resolves the `native-selection:<token>` the composer attached; an environment contributor adds the native launcher and, for helper threads, `LANE_PILOT_ROLE` and the guard `PATH`. Hook time limits are set in `package.json` (`messageDispatch` 20 s, `contributeEnv` 10 s), with a 300 s drain on reload.

## Sources

Where this page's claims start in the code: `src/rooms/tools/server/handlers/cli-commands.ts`, `src/rooms/platform/models/pm-tool-families.ts`, `src/rooms/contracts/index.ts`, `src/rooms/pages/ui/page.tsx`, `src/rooms/pages/models/nav-model.ts`, `src/rooms/runs/ui/chat-panel.tsx`, `server.ts`. The deep pages linked above cite the rest.
