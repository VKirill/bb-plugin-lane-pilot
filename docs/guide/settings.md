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
  - src/rooms/settings-registry.ts
  - packages/settings-catalog/src/define-setting.ts
  - packages/settings-catalog/src/lp-defaults.ts
---

# Settings and experimental features

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Every setting is a row in the plugin database, read at the moment it is used, so **no setting needs a plugin reload** and a change applies to the next attempt or stage. Settings exist on three levels that share the same six tabs: **General settings** (system defaults, the `*` row), a **project**, and a **section** of a project (BB Project Folders). A project value overrides the default; a section value overrides its project. A write carries the setting's version, so two editors cannot silently overwrite each other. Tabs marked below have a **Basic / Advanced** switch; advanced rows are the ones most people never touch.

System pages next to the project list: **Today** (**Waiting for you**, **Tasks**, **Errands**, **Schedule**) and **Setup** (**General settings**, **Agents**, **Workflows**, **Tokens**).

The full generated list with defaults is [docs/enabled-settings.md](../enabled-settings.md). Settings are declared through the typed `defineSetting` catalog (`packages/settings-catalog/src/define-setting.ts`) and composed from `src/rooms/registry.ts` in `src/rooms/settings-registry.ts`.

## The six tabs

| Tab | What it holds |
|---|---|
| **Overview** | Getting-started checklist (writer chosen, stack on the machine, how to start a run), runs in progress, what needs attention, UI language. |
| **Team** | The role roster (`RoleModelsPanel`) with model, on/off, where the value comes from and what the role's session loads; the project's main agent for new chats; agent access; Browser QA machine settings. |
| **Work** | Where and how the writer works (workspace mode, quality mode, sandbox), baseline checks, helper context, plan and code critique, specialist review, PM read, run and workflow budgets, owner push settings, integration gate. Settings without a dedicated control (most `writer.*`) appear here as grouped extra rows. |
| **Knowledge** | Segments **Memory** and **Documents**. |
| **Automation** | Segments **Workflows** (catalog, canvas editor, run, model presets) and **Schedule** (including board-wide `schedule.paused_all`). |
| **Runs** | Segments **Board**, **Analytics** (acceptance statistics) and **Service** (the Lane Pilot stack on each host). |

## Most important settings per tab

**Team**

| Setting | Default | What it does |
|---|---|---|
| `role_model.<role>` | role table | The model (and optional pool of extra models) that works a role; any provider's model. |
| `writer.provider`, `writer.model`, `writer.reasoning_effort`, `writer.service_tier` | project's choice | The project's own writer; is the writer of every task. Fallback slots 1 to 3 are `writer.fallback<N>.provider` / `.model` / `.reasoning_effort` (defaults: GLM 5.3 Flash, then Gemini 3.8 Flash; slot 3 off). |
| `main.agent` | none | Agent that new chats of the project start with; none means you turn Lane Pilot on in the chat. |
| `helper.context_mode` | `roles` | What helper sessions load: by role (default), inherited, or selected allowlists (`helper.skills`, `helper.mcp_servers`, `helper.bb_plugins`, `helper.native_plugins`). |
| `browser_qa.enabled`, `browser_qa.backend`, `browser_qa.provider` | catalog `false`, `bb-browser`, `codex` | The browser check of accepted tasks. Unset, the check still runs for a task that carries `qa_cases` and `qa_url`; an explicit `false` skips it. |

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
| `pm_read.enabled` / `.min_lines` | `false` / `350` | A scout reads the task's `read_first` files itself and reports to the plan critic and the writer; below `min_lines` of `read_first` it does not run. |
| `plan_fact.mode` | `record` | `gate` sends a task back when an acceptance item has no evidence. |
| `owner.words` | `sensitive` | Whose word a verified task waits for (up to 6 hours) before it lands on main; the PM asks with `lane_pilot_ask_owner` and records the answer with `lane_pilot_queue` action `word`. `sensitive` (default): only money, database migrations and destructive data operations, and a deploy to production, whatever the task's risk; `on`: every task; `risky`: risk high or critical; `off`: none. A contract clarification and a permit ask by the same rule. |
| `owner_push.enabled`, `.quiet`, `.timezone` | `true`, `23:00-08:00`, `Europe/Madrid` | The Telegram notifications for what waits for the owner (`lp.owner-bell` and `lp.owner-push`). |
| `baseline.already_built`, `baseline.time_cap_sec`, `checks.require_red_on_base` | `notify`, `300`, `medium` | The baseline before a writer starts. |
| `integration.gate_command`, `.gate_when`, `.gate_every` | auto-detected, `queue_drained`, `5` | The whole-suite check after a batch merged. |
| `run.max_attempts`, `run.max_children`, `run.max_tokens`, `run.max_wall_minutes`, `run.gate` | unset, `none` | Run budgets and the operator-review gate. |
| `writer.fallback_on_provider_failure`, `writer.pair_pin`, `writer.capacity_wait` | `immediate`, `on`, `on` | Writer routing, see [How a piece of work flows](flow.md). |
| `writer.task_wall_clock_min`, `writer.verify_max_passes`, `writer.retry_safety`, `failure.interventions` | `720`, `10`, `on`, `on` | Retry caps and gates, see [Failure handling and stability](failures.md). |
| `usage.skip_percent` | `90` | Share of a provider's usage window from which its writer models are skipped until reset. |

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
| `docs.enabled` | `auto` | Documentation support per project. |

**Automation**

| Setting | Default | What it does |
|---|---|---|
| `workflow.preset.<name>.*` | built-in presets (`cheap-fast`, `strong`, `ins-*`) | Named model presets used by graph steps. |
| `workflow.debugger.*` | unset | Model of workflow agent steps with no model of their own. |
| `workflow.node_budget_tokens`, `.node_budget_usd`, `.node_budget_wall_seconds` | unset | Per-node resource caps enforced by the workflow engine. |
| `workflow.run_budget_tokens`, `.run_budget_usd`, `.run_budget_wall_seconds`, `workflow.stuck_repeat_limit` | unset | Per-run resource caps and loop repeat ceiling. |
| `schedule.paused_all` | `false` | Pause or resume engine clock firing across the entire schedule board (`bb lane-pilot schedule pause-all\|resume-all`). |
| Schedule entries | none | Created from the PM (`lane_pilot_schedule`) or the Schedule segment; each has `missed` and `overlap` policies. |

## Experimental features

These switches are off, in shadow, or at their neutral value by default. Each one is a normal setting (live, no reload) with its own evidence trail, so you can turn it on for one project, watch the numbers and turn it off again. Defaults are from the settings catalog. Where a feature has a per-project scope, set it on the project's **Work** tab (advanced rows) or **Knowledge** tab; global ones live on **General settings**.

| Setting | Default | What it is for | How it works | Turn it on, and what to watch |
|---|---|---|---|---|
| `writer.retry_escalate` | `false` | Stop spending a retry on a writer that already failed the task's own check. | After a task-class failure whose reason is `verification failed`, the first red check hands the task to the next writer of the fallback chain, inside the same attempt budget. Off: the same writer retries once first. | Set `true`. Watch the attempt reasons (`retry_escalate: ...`) and `bb lane-pilot metrics <project>` for whether the next writer lands more tasks on the first accepted try. |
| `writer.best_of` | `off` (values `off`, `3`) | Quality on hard tasks: three candidates instead of two sequential retries. | Needs `quality_mode` = `full`. Three writers of the fallback chain run the task at once, each in its own worktree. The task's checks pick the winner; a tie goes to the code critic's verdict; losers close as `superseded` and are never merged. | Set `3` on a project with `quality_mode` `full`. Cost is bounded by `writer.best_of.slot_cap` (default `3`; `1` runs the candidates in turn), `writer.best_of.token_budget` (default `0`, the run's budget rules) and `writer.best_of.rounds`. Watch tokens per accepted task. |
| `writer.best_of.rounds` | `1` | Recursive refinement of best-of. | Above `1`, candidates of the next round start with the previous round's surviving attempts, their check remarks and diff stats. The task budget counts candidates times rounds. | Raise only with `writer.best_of` on; watch the same token numbers. |
| `writer.class_cooldowns` | empty | Give a failure class a pause before the next attempt. | A JSON map class to seconds, for example `{"provider":30,"task":5}`. Empty keeps today's behaviour: classes keep their own waits and nothing else pauses. Classes are `task`, `provider`, `merge`, `dirty_base`, `harness`, `infra`, `contract`, `judgment`, `budget`, `limit`, `reassign`, `verification_timeout`. | Write the map; cap any pause with `writer.cooldown_max_ms` (default `0`, no cap). Watch time-to-accept and whether `provider` failures stop repeating. An unparsable value means no pause. |
| `memory.pack_mode` | `shadow` (values `off`, `shadow`, `adapter`, `canary`) | One budgeted context pack per project, repo, section chain and role instead of the legacy memory mix. | The compiler builds a pack from the same sources as the legacy mix: required rules pack first and fail the build rather than be cut, optional notes go in by relevance, a note whose named files drifted is excluded for re-verification. In this build every value except `off` only compiles and logs `context-pack shadow ...: kept/added/dropped, bytes old->new`; nothing it builds is delivered. | Leave in `shadow` and read the log lines; `off` stops the comparison. `adapter` and `canary` are accepted values but deliver nothing yet. |
| `memory.query_floor` | `on` | Make memory answer "nothing relevant" instead of the nearest noise. | On the PM memory tool, `session_memory_search` and the context-pack, a record must name a path written in the question or share enough rare words with it. Weight of a shared word: how uncommon it is in the project's notes. The required weight rises with question length. The writer's brief and the reviewers are untouched (their path anchors already are a floor). | Default is on; set `off` to get the old behaviour (every search returns its best matches). Tune with `bb lane-pilot memory-eval --floor`. |
| `memory.judge.enabled` | `true` | Let a small model pick the notes that help answer an explicit memory search. | The PM memory tool, `session_memory_search` and the writer's brief ask the judge (OpenLux, key `OPENLUX_MEMORY_API_KEY`). | Off returns the vector's notes as they came. |
| `memory.judge.model` | `agy/gemini-3.8-flash-low` | The judge's model. | `agy/<id>` runs the Antigravity CLI on the hub (owner's sign-in, no key); `router9/<id>` goes to the owner's 9router (key `NINEROUTER_API_KEY`); any other id goes to OpenLux. A quota error or a hang on the first route skips it for 2 minutes. | |
| `memory.judge.fallback_model` | `gemini-3.8-flash` | Tried once after an HTTP error of the first model (on another endpoint also after its timeout, with a fresh window). | Then the vector's first five notes. | |
| `memory.judge.timeout_ms` | `12000` | How long the judge may take. | After it the search returns the vector's first five without a warning. | |
| `memory.judge.candidates` | `12` | How many of the nearest notes the judge reads. | Only notes with a cosine of at least 0.50. | |
| `memory.scope` | `section` (values `section`, `project`) | Let the sections of one project share one memory. | `project` makes every note of the project visible to every section on every memory read path (PM context, explicit search, the writer brief, reviewers, the recall hook, the cold tier, the thread block); the note keeps its section as a tag and a note of the asking section ranks 3 places higher. Rules keep their own scope. | `section` reads the project root, the ancestors and the own section only. |

## Other switches that default to the conservative side

| Setting | Default | Turning it on |
|---|---|---|
| `quality_mode` | `standard` | `full` runs plan and code critics on every task and requires a browser check for tasks with `qa_cases`; it is also the precondition of best-of. |
| `plan_fact.mode` | `record` | `gate` sends a task back to the writer when an acceptance item has no evidence that holds. |
| `code_critique.mode` | `advisory` | `gate` blocks acceptance on any change request; `advisory` blocks only on a block or a blocking finding on a rubric criterion. |
| `specialist.enabled`, `pm_read.enabled` | `false` | Extra review and check stages before the writer starts. |

## Sources

Where this page's claims start in the code: `src/rooms/settings-registry.ts`, `packages/settings-catalog/src/define-setting.ts`, `packages/settings-catalog/src/lp-defaults.ts`. The deep pages linked above cite the rest.

<!-- lane-pilot:backlinks -->
## Referenced by

- [CLI, agent tools, UI and RPC](interfaces.md)
- [Self-improvement](self-improvement.md)
