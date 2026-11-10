---
title: Settings and experimental features
topic: settings
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, settings]
updated: 2026-11-10
sources:
  - packages/settings-catalog/src/channels.ts
  - packages/settings-catalog/src/ui-catalog.ts
  - packages/settings-catalog/src/lp-defaults.ts
---

# Settings and experimental features

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Every setting is a row in the plugin database, read at the moment it is used, so **no setting needs a plugin reload** and a change applies to the next attempt, stage or night run. Settings exist on three levels that share the same six tabs: **General settings** (system defaults, the `*` row), a **project**, and a **section** of a project (BB Project Folders). A project value overrides the default; a section value overrides its project. A write carries the setting's version, so two editors cannot silently overwrite each other. Tabs marked below have a **Basic / Advanced** switch; advanced rows are the ones most people never touch.

System pages next to the project list: **General settings**, **Agents** (prompts and access of every role and employee), **Tokens** (token usage by range and project), **Workflows**, **Automation** (the schedule board), **Tasks** (board and work graph), **Self-improvement** (the night loop, bench, policy and checks defaults) and **Waiting for you** (what needs the owner).

The full generated list with defaults is [docs/enabled-settings.md](../enabled-settings.md); the Self-improvement controls are explained in [docs/self-improvement-settings.md](../self-improvement-settings.md). Defaults below come from the settings catalog (`packages/settings-catalog/src/ui-catalog.ts`).

## The six tabs

| Tab | What it holds |
|---|---|
| **Overview** | Getting-started checklist (writer chosen, stack on the machine, how to start a run), runs in progress, what needs attention, UI language. |
| **Team** | The roster of roles with model, on/off, where the value comes from and what the role's session loads; the project's main agent for new chats; agent access; Browser QA machine settings; council judge. |
| **Work** | Where and how the writer works (workspace mode, quality mode, sandbox), baseline and regression checks, helper context, plan and code critique, specialist review, night review, PM read, council seats, run budgets, integration gate. Settings without a dedicated control (most `writer.*`) appear here as grouped extra rows. |
| **Knowledge** | Segments **Memory**, **Documents**, **Rules** (project level and below) and **Anamnesis** (system level). |
| **Automation** | Segments **Workflows** (catalog, canvas editor, run, model presets) and **Schedule**. |
| **Runs** | Segments **Active**, **History**, **Analytics** (acceptance statistics), **Council** (sessions) and **Service** (the Lane Pilot stack on each host). |

## Most important settings per tab

**Team**

| Setting | Default | What it does |
|---|---|---|
| `role_model.<role>` | role table | The model (and optional pool of extra models) that works a role; any provider's model. The writer of a task is not a row: Jev picks it per task. |
| `writer.provider`, `writer.model`, `writer.reasoning_effort`, `writer.service_tier` | project's choice | The project's own writer; stays the first fallback when Jev picks another one. Fallback slots 1 to 3 are `writer.fallback<N>.provider` / `.model` / `.reasoning_effort` (defaults: GLM 5.3 Flash, then Gemini 3.8 Flash; slot 3 off). |
| `main.agent` | none | Agent that new chats of the project start with; none means you turn Lane Pilot on in the chat. |
| `helper.context_mode` | `roles` | What helper sessions load: by role (default), inherited, or selected allowlists (`helper.skills`, `helper.mcp_servers`, `helper.bb_plugins`, `helper.native_plugins`). |
| `browser_qa.enabled`, `browser_qa.backend`, `browser_qa.provider` | catalog `false`, `bb-browser`, `jev` | The browser check of accepted tasks. Unset, the check still runs for a task that carries `qa_cases` and `qa_url`; an explicit `false` skips it. |
| `council.judge`, `council.<seat>.*` | `true` | Council seats and the judge. |

**Work**

| Setting | Default | What it does |
|---|---|---|
| `quality_mode` | `standard` | `quick` skips both critics; `standard` critiques the plan by risk and the code only if enabled; `full` runs both on every task and requires a browser check for tasks with `qa_cases`. A task contract can set its own. |
| `adoc.040` | `auto` | Workspace routing and the lifecycle of managed worktrees. |
| `workspace.provider` | `auto` | `auto` gives each attempt a BB environment of its own provider with automatic fallback; `off` is the emergency switch to the old worktree path. |
| `sandbox.backend` | `auto` | Seatbelt on macOS or bubblewrap on Linux for checks; fails closed when unavailable. |
| `verification.sandbox_unsafe` | empty | Tests the sandbox cannot run; a whole-suite check must exclude them. |
| `secrets.allow` | empty | Env Catalog names a task's checks may receive. |
| `plan_critique.enabled` / `.mode` / `.min_score` / `.min_write_tasks` / `.on_high_risk` | `true` / `gate` / `7` / `3` / `true` | The plan critic refuses a plan before any writer starts when mode is `gate`. |
| `code_critique.enabled` / `.mode` / `.auto_fix` / `.max_rounds` | `false` / `advisory` / `true` / `1` | The post-writer reviewer; `gate` blocks acceptance on requested changes; auto-fix returns findings to the same writer (up to 3 rounds). |
| `critic.code.default_for_risk` | `medium` | With `code_critique.enabled` unset, turns the code critic on for tasks of that risk or higher (`off`, `medium`, `high`). |
| `specialist.enabled` / `.when` | `false` / `high_risk` | Specialist risk review. |
| `night_review.enabled` / `.auto_merge` / `.max_fix_tasks` | `false` / `off` / `5` | The bounded post-acceptance night reviewer. |
| `pm_read.enabled` / `.min_lines` | `false` / `350` | A scout reads the task's `read_first` files itself and reports to the plan critic and the writer; below `min_lines` of `read_first` it does not run. |
| `plan_fact.mode` | `record` | `gate` sends a task back when an acceptance item has no evidence. |
| `owner.words` | `on` (no catalog row) | A verified task waits up to 6 hours for the owner's yes before it lands on main; the PM asks with `lane_pilot_ask_owner` and records the answer with `lane_pilot_queue` action `word`. `off` lands tasks without the wait. |
| `baseline.already_built`, `baseline.time_cap_sec`, `checks.require_red_on_base` | `notify`, `300`, `medium` | The baseline before a writer starts. |
| `regress.nightly`, `.last_n`, `.last_days` | `true`, `30`, `14` | The night re-check of accepted tasks. |
| `integration.gate_command`, `.gate_when`, `.gate_every` | auto-detected, `queue_drained`, `5` | The whole-suite check after a batch merged. |
| `run.max_attempts`, `run.max_children`, `run.max_tokens`, `run.max_wall_minutes`, `run.gate` | unset, `none` | Run budgets and the operator-review gate. |
| `writer.fallback_on_provider_failure`, `writer.pair_pin`, `writer.capacity_wait`, `writer.route_record`, `writer.skill_pick` | `immediate`, `on`, `on`, `on`, `on` | Writer routing, see [How a piece of work flows](flow.md). |
| `writer.task_wall_clock_min`, `writer.verify_max_passes`, `writer.retry_safety`, `failure.interventions` | `720`, `10`, `on`, `on` | Retry caps and gates, see [Failure handling and stability](failures.md). |
| `usage.skip_percent` | `90` | Share of a provider's usage window from which its writer models are skipped until reset. |
| `jev.enabled`, `jev.provider`, `jev.modes`, `jev.thresholds` | `true`, `typesafe`, per judgment, defaults | The Jev judgments. |

**Knowledge**

| Setting | Default | What it does |
|---|---|---|
| `memory.enabled`, `memory.maintain`, `memory.inject` | `true` | Project memory on, maintained after accepted work, injected into briefs. |
| `memory.audience` | `subagent` | Which audience of notes is retrieved. |
| `memory.maintain_mode`, `memory.maintain_every` | `wave`, `3` | `wave`: a free fact per accepted task and one maintainer run when the wave goes idle; `task`: a helper per accepted task. |
| `memory.salience_min` | `40` | Admission floor (0 to 100) for notes the maintainer proposes. |
| `memory.core_budget`, `memory.note_budget`, `memory.index_budget`, `memory.context_budget` | `3072`, `24000`, `65536`, `2500` tokens | Size caps. |
| `memory.search_engine` | `auto` | FTS5 or BM25 retrieval. |
| `memory.pack_mode` | `shadow` | Context pack compiler, see [Experimental features](settings.md#experimental-features). |
| `docs.enabled`, `docs.maintain`, `docs.hour`, `docs.since`, `docs.page_cap` | `auto`, `true`, `5`, `yesterday`, `0` | Daily docs maintenance. |
| `project_life.enabled` | `true` | PROGRESS, plan ticks and ROADMAP refreshed after accepted work. |

**Automation**

| Setting | Default | What it does |
|---|---|---|
| `workflow.preset.<name>.*` | built-in presets (`cheap-fast`, `strong`, `ins-*`) | Named model presets used by graph steps. |
| `workflow.debugger.*` | unset | Model of workflow agent steps with no model of their own. |
| Schedule entries | none | Created from the PM (`lane_pilot_schedule`) or the Schedule segment; each has `missed` and `overlap` policies. |

**Self-improvement (system page)**

| Setting | Default | What it does |
|---|---|---|
| `wall.enabled`, `wall.max_classes_per_night`, `wall.rounds_per_night`, `wall.night_token_cap` | `true`, `3`, `2`, `20000000` | The 03:00 night loop and its limits. |
| `bench.budget_tokens`, `bench.budget_hours`, `bench.nightly_sets` | `120000000`, `6`, `all` | LP-Bench series caps and nightly sets. |
| `harness.adopt_by` | `bench` | Whether a taught writer tree is adopted after winning on the bench or by live alternation. |
| `owner_push.enabled`, `.quiet`, `.timezone` | `true`, `23:00-08:00`, `Europe/Madrid` | The Telegram push about what waits for the owner. |

## Experimental features

These switches are off, in shadow, or at their neutral value by default. Each one is a normal setting (live, no reload) with its own evidence trail, so you can turn it on for one project, watch the numbers and turn it off again. Defaults are from the settings catalog. Where a feature has a per-project scope, set it on the project's **Work** tab (advanced rows) or **Knowledge** tab; global ones live on the **Self-improvement** system page or **General settings**.

| Setting | Default | What it is for | How it works | Turn it on, and what to watch |
|---|---|---|---|---|
| `writer.retry_escalate` | `false` | Stop spending a retry on a writer that already failed the task's own check. | After a task-class failure whose reason is `verification failed`, the first red check hands the task to the next writer of the fallback chain, inside the same attempt budget. Off: the same writer retries once first. | Set `true`. Watch the attempt reasons (`retry_escalate: ...`), `bb lane-pilot metrics <project>` and the routing statistics (`lane_pilot_memory` action `routing_stats`) for whether the next writer lands more tasks on the first accepted try. |
| `writer.best_of` | `off` (values `off`, `3`) | Quality on hard tasks: three candidates instead of two sequential retries. | Needs `quality_mode` = `full`. Three writers of the fallback chain run the task at once, each in its own worktree. The task's checks pick the winner; a tie goes to the code critic's verdict; losers close as `superseded` and are never merged. | Set `3` on a project with `quality_mode` `full`. Cost is bounded by `writer.best_of.slot_cap` (default `3`; `1` runs the candidates in turn), `writer.best_of.token_budget` (default `0`, the run's budget rules) and `writer.best_of.rounds`. Watch tokens per accepted task. |
| `writer.best_of.rounds` | `1` | Recursive refinement of best-of. | Above `1`, candidates of the next round start with the previous round's surviving attempts, their check remarks and diff stats. The task budget counts candidates times rounds. | Raise only with `writer.best_of` on; watch the same token numbers. |
| `writer.class_cooldowns` | empty | Give a failure class a pause before the next attempt. | A JSON map class to seconds, for example `{"provider":30,"task":5}`. Empty keeps today's behaviour: classes keep their own waits and nothing else pauses. Classes are `task`, `provider`, `merge`, `dirty_base`, `harness`, `infra`, `contract`, `judgment`, `budget`, `limit`, `reassign`, `verification_timeout`. | Write the map; cap any pause with `writer.cooldown_max_ms` (default `0`, no cap). Watch time-to-accept and whether `provider` failures stop repeating. An unparsable value means no pause. |
| `memory.pack_mode` | `shadow` (values `off`, `shadow`, `adapter`, `canary`) | One budgeted context pack per project, repo, section chain and role instead of the legacy memory mix. | The compiler builds a pack from the same sources as the legacy mix: required rules pack first and fail the build rather than be cut, optional notes go in by relevance, a note whose named files drifted is excluded for re-verification. In this build every value except `off` only compiles and logs `context-pack shadow ...: kept/added/dropped, bytes old->new`; nothing it builds is delivered. | Leave in `shadow` and read the log lines; `off` stops the comparison. `adapter` and `canary` are accepted values but deliver nothing yet. |
| `failure.class` Jev judgment (`jev.modes`: `failure.class=...`) | `shadow` | Classify a failure the regular expressions cannot place, so the right retry (task vs provider vs infra) happens. | Rules classify first; only a reason with no confident match goes to Jev. In `shadow` the rules' class is used and Jev's answer is recorded in a receipt. Each receipt is labelled from the run's terminal state. With 10 or more labelled outcomes and 75 percent or more agreement, the judgment decides as if active, even in shadow, checked once a minute. Below that, the rules' class stands. | Nothing to switch: it promotes itself. `bb lane-pilot jev failure` prints calls, labelled outcomes, agreement and why it is or is not live. Set `failure.class=active` in `jev.modes` to force it, `off` to stop it. |
| `checkers.diff_hidden_limit` | `0` (off) | Check the checkers: find ones that pass or complain without ever looking at the diff. | Re-runs the diff-inspecting checkers on an accepted task with the diff hidden. A *blind pass* is a checker that passes with no code; a *phantom finding* is the same finding reported with no diff. A healthy checker behaves differently with and without the diff. Rows go to `lane_pilot_diff_hidden_audit`; the wall morning summary gets a line. | `bb lane-pilot checkers diff-hidden [--tasks N] [--only id,id] [--checkers a,b] [--json]` runs it on demand. The setting is the number of accepted tasks per night loop (`0` turns the audit off). Watch the blind-pass and phantom counts in the morning line. |
| `bench.model_rebench` | `off` (global) | Notice when Jev's model routing drifts from outcomes. | On the 1st of each month at 05:30 UTC, when `on`, the graph `lp.model-rebench` compares Jev's routing choices (`writer.model` and `route.workflow`) with the real task and workflow outcomes of the last 30 days: accuracy, win rate of the chosen models and recommendations. The result is stored in `lane_pilot_model_rebench` and shown in the morning summary. It recommends; it changes no routing by itself. | Set `on` on General settings. One run per month (idempotent key per month). Watch accuracy and win rate month to month. |
| `writer.trajectory_export` | `off` | Collect failed attempts as a corpus for analysis. | When `on`, every writer attempt that does not end accepted is recorded (task, thread events, output) into `lane_pilot_rejected_trajectory` with known secrets redacted; no file is written on the server. | Set `on`, then `bb lane-pilot writer trajectories export [--since <iso\|ms>] [--out <path>] [--project <id>]` writes JSONL on your machine. Watch the row count and bytes in the morning line. |
| skill-switch metric (no setting) | always recorded | Learn whether writers that jump between skills fail more. | After every writer attempt Lane Pilot counts the skills used and the switches between different ones, with the outcome, in `lane_pilot_skill_metric`. | Read the morning line; nothing to configure. |
| `pm.context_file` | `off` | Give the PM a short, verbatim project state without re-summarising every turn. | When `on`, the night loop compiles for each recently active project a context.md of at most 2000 characters (active run, the last accepted tasks, open or failed tasks, recent memory rules, open walls) into `lane_pilot_pm_context`. The PM prompt builder appends it as a *Project Context* section with secrets stripped and an explicit truncation note. | Set `on` per project. Watch the morning line and the size of the stored context. |
| `memory.query_floor` | `on` | Make memory answer "nothing relevant" instead of the nearest noise. | On the PM memory tool, `session_memory_search`, the council and the context-pack, a record must name a path written in the question or share enough rare words with it. Weight of a shared word: how uncommon it is in the project's notes. The required weight rises with question length. The writer's brief and the reviewers are untouched (their path anchors already are a floor). | Default is on; set `off` to get the old behaviour (every search returns its best matches). Tune with `bb lane-pilot memory-eval --floor`. |

## Other switches that default to the conservative side

| Setting | Default | Turning it on |
|---|---|---|
| `quality_mode` | `standard` | `full` runs plan and code critics on every task and requires a browser check for tasks with `qa_cases`; it is also the precondition of best-of. |
| `plan_fact.mode` | `record` | `gate` sends a task back to the writer when an acceptance item has no evidence that holds. |
| `code_critique.mode` | `advisory` | `gate` blocks acceptance on any change request; `advisory` blocks only on a block or a blocking finding on a rubric criterion. |
| `specialist.enabled`, `pm_read.enabled`, `night_review.enabled` | `false` | Extra review and check stages. `night_review.auto_merge` (default `off`) merges only a verified, approved PR in a managed worktree. |
| `harness.adopt_by` | `bench` | `live` adopts a taught writer tree by alternation on real tasks instead of by the bench. |
| `jev.modes` | per judgment | Each judgment runs `off`, `shadow` (recorded next to the old decision) or `active` (decides the clear cases). `bb lane-pilot jev calibrate` gives each judgment a verdict: `gate`, `sort-only` or `dead`. |

## Sources

Where this page's claims start in the code: `packages/settings-catalog/src/channels.ts:1-21`, `packages/settings-catalog/src/ui-catalog.ts:1-21`, `packages/settings-catalog/src/lp-defaults.ts:1-21`. The deep pages linked above cite the rest.

<!-- lane-pilot:backlinks -->
## Referenced by

- [CLI, agent tools, UI and RPC](interfaces.md)
- [Self-improvement](self-improvement.md)
