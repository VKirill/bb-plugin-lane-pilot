---
title: Roles, agents and models
topic: roles
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, roles]
updated: 2026-11-14
sources:
  - packages/models/src/role-models.ts
  - src/rooms/platform/server/launch-tuning.ts
  - src/rooms/platform/server/pm-spawn.ts
  - src/rooms/tasks/execution-packet.ts
  - packages/workflow-engine/src/model-json.ts
  - src/rooms/brief/index.ts
  - src/rooms/critique/pm-read.ts
  - packages/workflow-engine/src/agent-output.ts
---

# Roles, agents and models

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Every name below has one Russian display name and one place in the table [Agents: who is who](../agents.md).

Every agent step in Lane Pilot names a role, and the role names the model. One table, `role_model.<role>`, applies to every graph, at the global, project or section level. There is no per-step model override. Two things sit outside the table: the writer of a task (picked per task by a Jev judgment) and the PM chat (the model the owner started the chat on).

## Who does what

| Actor | What it does | How its model is chosen |
|---|---|---|
| PM (`dev-orchestrator`, shown as "Development coordinator") | The chat the owner talks to. Plans, dispatches writers, starts workflows, councils, errands and specialists, reads results, ships. Edits no product code. Started from the composer action "Lane Pilot / agent". | The model of the chat. The composer tries Claude Opus 5.5 with the 1M context first, then plain Opus 5.5. |
| Writers | Implement one task in a git worktree, one attempt per worktree. Run in a BB thread on any provider BB offers. | Not in the role table. The writer is the project's `writer.provider` / `writer.model` / `writer.reasoning_effort`, with the fallback chain; no model picks it per task. `writer.rotation_share` (25 by default) sends part of the tasks to the first fallback writer. |
| Sticky area writers | Tasks with the same area go one after another in the same writer thread, so the writer keeps its context. A thread that cannot take a turn is marked and not offered again. | The thread keeps its writer; the next task's turn carries the rules that apply to its contract. |
| Best-of | With `writer.best_of` = 3 (default off), three writers of the fallback chain run the task at once, each in its own worktree. The task's checks pick the winner, then the code critic's verdict. Losers close as superseded. `writer.best_of.rounds`, `.token_budget` and `.slot_cap` bound the cost. | Writers from the fallback chain. |
| Plan critic (`plan-critic`) | Judges the planner's plan before work starts. `plan_critique.enabled` defaults to true, mode `gate`. | Role table. |
| Specialist reviewer (`specialist-reviewer`) | A second, domain-minded look at the plan. `specialist.enabled` defaults to false; `specialist.when` defaults to `high_risk`. | Role table. |
| Code critic (`code-critic`) | Judges the writer's diff and every dimension of a wave review (`lp.review`). Runs on a model of another family than the writer. `quality_mode` (quick, standard, full) decides which review stages a task goes through; `full` puts both critics on every task. | Role table; never the writer's own model. |
| `triager` | The sorter of a failed gate into its class. | Role table. |
| PM reader (`pm-reader`) | The scout of a task: reads the `read_first` files and what they lead to, read-only, and reports facts with file and line and the questions the plan leaves open. Off by default (`pm_read.enabled`, threshold `pm_read.min_lines` = 350). | Role table. |
| Auditor, debugger | Audit finished work against the goal; find the cause of a failure from logs and code. | Role table (GPT-6.1 Sol high). |

## How work is handed to a helper

The full contract, task and result, is [The hand-off standard](handoff.md); this section is its task half in short.

A helper is an agent in the project checkout with its own tools. Its brief says what the work is for, where to start, what it may not change and what to return; it does not do the helper's reading for it.

- **Pointers, not contents.** A file the helper can open is named by path (`renderExecutionPacket`, `src/rooms/tasks/execution-packet.ts:92-99`), never pasted. Pasted source is cut by a budget, and the helper then reasons about the part that fit.
- **Read-only instead of «no tools».** A helper that must not change the checkout is told so (`REVIEW_READ_ONLY_LINE`, `packages/workflow-engine/src/model-json.ts:48`) and reads freely; for read-and-reply roles (`plan-critic`, `specialist-reviewer`, `pm-reader`, `gate-triage`), `withLaunchTuning` also attaches `experimental_vkLaunchTuning` at spawn (`acp-cursor` and `devin` use `ask` mode, `acp-antigravity` uses `plan` with `--sandbox`, and `claude-code` disables `CLAUDE_EDITOR_TOOLS`, which also covers `code-critic` while keeping `Bash`; disabled via `LANE_PILOT_LAUNCH_TUNING=off`, `src/rooms/platform/server/launch-tuning.ts:17-58`, `src/rooms/platform/server/pm-spawn.ts:189`). «Open no files» is only for a judge whose whole material is in the message and exists nowhere else (gate triage: counts from the hub).
- **Data the helper cannot reach rides in the message**, tagged and marked as data: hub records, the PM's plan, the owner's words, the previous step's handoff.
- **One stated result.** The brief ends with the answer format the next step reads (`renderBrief`, `src/rooms/brief/index.ts:120-147`).

The plan critic, the specialist reviewer, the code critic, the task scout (`pmReadPrompt`, `src/rooms/critique/pm-read.ts:41-58`) and the second pilot follow this. A graph's agent step gets the same shape from the engine: the node's task, a step packet of references and the previous step's handoff (`agentPrompt`, `packages/workflow-engine/src/agent-output.ts:94-128`).

## Employees and specialists

The PM starts a specialist with `lane_pilot_helpers` (action `specialist`); it runs as a child thread the owner can open. The stock roles come from the employee manifest and the bundled agents. Employees run only on Claude Code agent profiles. Each employee has a domain, a machine affinity, a deliverables folder under `.agents/`, 0-3 always-loaded skills and the catalog sections it searches first.

| Role id | Shown as | Focus | Machine |
|---|---|---|---|
| `design-lead` | Designer | Flows, prototypes, mockups, `DESIGN.md`, UX audits | any |
| `copy-lead` | Copy editor | Offers, headlines, microcopy, audience | any |
| `seo-specialist` | SEO specialist | Semantics, titles, meta, content plans | any |
| `video-lead` | Video | Explainers, reels, procedural films, captions | any |
| `tavily` | Researcher | Web research with a cited note | any |
| `3d-artist` | 3D artist | Blender assets | Mac mini |
| `game-dev` | Game developer | Games in any engine; engine and genre come from the catalog | Mac mini |
| `social-manager` | Social manager | Posts, replies, audience reads | any |
| `billing-assistant` | Billing assistant | Invoices and closing documents (Elba on the Mac mini, Diadoc on Windows) | Mac mini |
| `visual-artist` | Visual artist | Pictures through Image Studio | any |
| `macos-operator` | macOS operator | The owner's Mac routine through computer-use | Mac mini |

Eleven more stock agents are bundled as standalone roles: `advisor-researcher`, `ai-researcher`, `animator`, `doc-classifier`, `domain-researcher`, `eval-auditor`, `eval-planner`, `framework-selector` (shown as "Model selector"), `mempalace-curator`, `nyquist-auditor` (shown as "Check auditor") and `ui-researcher`. `project-onboarder` is an internal orientation session, and `browser-qa` is reserved for the `lp.browser-qa` graph.

The owner can create custom agents on the Agents page or with `bb lane-pilot agents create|update|delete|list|show` (JSON, or markdown with frontmatter: id, display name, prompt, tools, skills, MCP servers, optional model and effort). Custom agents without a row of their own use the `specialist` row. A specialist can also be pinned to a model per agent. The "Agent access" part of the Team tab sets, per kind of helper, what its session loads. An owner remark about how an employee should work is stored as a dated rule line by `lane_pilot_employee_lesson`, and a Jev judgment (`employee.remark`) tells whether a message is such a remark.

## Errands, browser, councils, forge, relay, repair, upkeep

| Part | What it is |
|---|---|
| Errand (`lane_pilot_errand`, then `lane_pilot_wait_errand`) | The `errand` graph for non-code work: a helper thread works in a cloud console in the owner's browser, a mailbox, a screen recording or an account from Env Catalog. Changes need `authorized: true`; accounts, BB plugins, skills and MCP servers are named per call. Role `errand`. |
| Browser (`lane_pilot_browser`) | The `browser-step` graph: one goal in the owner's signed-in Chrome on the browser machine (the Mac mini) with agent-desktop (an LLM agent drives it through the accessibility tree). It returns the final URL, a status (done, blocked, error) and up to 6000 characters of the page text. |
| Browser QA (`lane_pilot_browser_qa`) | The `lp.browser-qa` graph checks an accepted task in a browser per case and viewport. Role `browser-qa`. |
| Council of directors (`lane_pilot_council`, `bb lane-pilot council`) | Role-bound seats on different models argue a product or business question. Seats: `product`, `demand`, `audience`, `skeptic` (always speaks last), `growth`, `ux`; the default set is the first four. The chair writes a decision page under `docs/decisions` and hands next tasks over. Mode `room` (default) or `rounds`; 1-6 rounds (`council.max_rounds`, default 3); optional `judge` and `materials`. Seat models come from `council.<role>.provider|model|reasoning_effort`, else distinct pairs from the stage selections. The chair is the `council` row of the role table. The owner can speak into a running council or ask it to decide. The Council page shows the session with an isometric office view on screens of 1024 px and wider. |
| Forge / Creator (`lane_pilot_forge`) | The Creator writes exactly one skill, role or workflow draft into `.agents/forge/<kind>s/<name>/`. A lint checks its shape and forbids grants such as bypassed permissions, all tools, secrets, guard changes or piped downloads. A receipt keeps the bytes that passed. Enabling takes two steps: request, then confirm. |
| Relay (`lane_pilot_relay`) | Thread-to-thread layer. `ask` queues a question into another thread without interrupting it; `reply` answers an `askId`; `list` shows asks and reminders and can cancel a reminder. Limits: 6 asks per thread pair per hour, 20 open reminders per thread, 150 reminders per thread per day, 7 days of retention. Reminders fire by time, when a watched thread settles, or when a set of task ids reaches a state. A sweep retries every 30 seconds. Task outcomes go to the PM as one batched message when the PM is idle. |
| Self-repair engineer (`repairer`) | Every 15 minutes Lane Pilot looks for failures that are its own fault. Each new kind of problem gets one repair thread in the Lane Pilot repository: it finds the cause, fixes it, adds a test and tells the affected PM. RPCs `self_repair_status`, `self_repair_configure`, `self_repair_tick`. Judgment `selfrepair.group` files a new signature under a known group. |
| Docs maintainer (`docs-maintainer`) | Refreshes repository docs at night from the code diff (`docs.hour` default 5, `docs.enabled` default auto). `bb lane-pilot docs-nightly` runs it now. |
| Memory maintainer (`memory`) | Distils notes and facts into project memory (`memory.maintain`, default on). |
| Project-life maintainer (`project-life`) | Keeps `.agents/PROGRESS.md` and `.agents/CHANGELOG.md` current; may also touch `.agents/plans/` and `.agents/todos/`. |
| Rules analyzer (`rules-analyzer`) | Reads failed writer attempts at night and writes project rules that would have prevented them. |
| Workflow architect (`workflow-architect`) | An agent profile started from the composer in any chat. It interviews the owner about a repeatable process and builds it as a tested chain with the `lane_pilot_workflow_draft` tools. It edits no product code and dispatches no writers. Role `workflow-architect`. |
| Planner, analyst | Write the analysis and the phase plans every task is cut from. The planner never runs below the `strong` tier. |

## Role -> model table

Built-in defaults from `ROLE_TABLE` in `packages/models/src/role-models.ts`. Authors are Claude, judges come from another family, cheap judgments use small models. A row can name any provider's model and an optional `pool` of extras; the least loaded provider takes each run.

| Role | Default model | Effort | Why |
|---|---|---|---|
| `analyst` | Claude Opus 5.5 | high | Writes the analysis the plan stands on; an author. |
| `planner` | Claude Opus 5.5 | high | Writes the phase plans; strongest author. Least tier: strong. |
| `workflow-architect` | Claude Opus 5.5 | high | Designs a graph from a conversation; an author. |
| `specialist` | Claude Opus 5.5 | high | An owner-created agent without a row of its own. |
| `copy-lead`, `seo-specialist`, `design-lead`, `video-lead`, `tavily`, `3d-artist`, `game-dev`, `visual-artist` | Claude Sonnet 5.5 | high | Judgment plus tool use; Opus stays for planning. |
| `social-manager`, `billing-assistant`, `macos-operator` | Claude Sonnet 5.5 | medium | Routines with tools and checklists. |
| `plan-critic`, `specialist-reviewer`, `code-critic`, `triager` | Gemini 3.8 Flash high (9router) | medium | Another family than the Claude authors, on a near-free subscription so Claude and GPT limits go to authors. Fallback: GPT-6.1 Sol high (triager: GPT-6 Luna high). |
| `auditor`, `debugger`, `council` (chair) | GPT-6.1 Sol | high | Strongest model of the other family; judges, not authors. |
| `pm-reader` | Claude Haiku 5.5 | low | Cheap, fast extraction. |
| `memory`, `project-life` | Claude Haiku 5.5 | medium | Short, careful text jobs. |
| `errand`, `browser-qa` | Claude Sonnet 5.5 | medium | Tool use without deep thinking. |
| `rules-analyzer`, `docs-maintainer` | GPT-6 Luna | high | Cheap, runs every night, a checker stands behind it. |
| `repairer` | GPT-6.1 Sol | high | Self-repair engineer; kept off Claude's weekly window. |

Resolution order, first hit wins: the owner's row (`role_model.<role>`), then an older stage selection (`plan_critique.*`, `specialist.*`, `pm_read.*`, `errand.*`, `memory.*`, `project_life.*`, `docs.*`), then the built-in default, then the role's fallback pair, then the PM chat's model. A deciding role (planner, auditor, code critic, debugger) is never lowered below its least tier by an inherited selection. The judge-against-author rule keeps a critic out of the writer's family. `bb lane-pilot council-seats` and the RPC `get_role_models` show what is resolved; `list_model_overrides` and `reset_model_overrides` clear per-place rows.

ZCode: the `zcode` provider offers one model, `glm-5.3-flash-free`, which never bills the plan. It is used only on the Mac mini, from 15:00 to 01:00 UTC (`zcode.window` = `always` lifts the limit), with at most three parallel ZCode tasks. Background rows `docs-maintainer`, `rules-analyzer`, `memory` and `project-life` try it first (`zcode.background` = false turns that off).

## Providers

Lane Pilot does not hard-code a provider list. It reads the provider and model catalog from BB (`bb.sdk.providers`), per machine, and checks every choice against it. The ids the code handles explicitly:

| Provider id | Used for |
|---|---|
| `claude-code` | PM, employees, Claude writers and authors |
| `codex` | GPT models: judges, repairer, GPT writers |
| `opencode2` (OpenCode v2) | Gemini 3.8 Flash through 9router, GLM-5.3 Flash (`zai-coding-plan`); replaces the removed `acp-opencode` (saved choices were migrated) |
| `acp-cursor` | Composer 2.5 and Grok 4.6 writers through the Cursor subscription |
| `zcode` | ZCode GLM-5.3 Flash Free (see above) |

The writer profiles also list MiniMax M3.1 Flash, Gemini Pro and Gemini 4 Argon, all marked unavailable and kept out of the pick. An hourly capability sweep (`bb lane-pilot capabilities [--probe]`, RPC `capability_table`) probes each provider adapter version once; a failed probe opens that provider's breaker and writers fall back to another provider.

## Sources

Where this page's claims start in the code: `packages/models/src/role-models.ts:29-49`. The deep pages linked above cite the rest.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Everything is a graph](graphs.md)
