# Lane Pilot workflow engine: design (W1 + W2)

Written before the code (2026-10-07) and kept in step with it. Sources: `workflow-studio-design.md`, master plan phase W, `maestro-audit/engine.md` (defects D1-D19), the Graph Studio model (`sajov/bb-plugins`, MIT).

## 1. What changes and what does not

The per-task pipeline of Lane Pilot becomes the built-in workflow `lp-task-pipeline` (W3 renamed it from `analyze-plan-execute`, which is now the outer chain of the chains spec). A workflow engine executes it. Every dispatch goes through the engine; `LANE_PILOT_WORKFLOW_ENGINE=0` (read at call time, default on) switches to the old direct path. The stage functions (`runPmRead`, `runPlanCritique`, `runSpecialistReview`, `startWriterTask`) are not rewritten: the node executors call them. The old `runStages` closure in `dispatch.ts` stays untouched as the kill-switch path; the new glue lives in `src/server/writer/dispatch-workflow.ts`. Equivalence is proven by tests (section 9).

## 2. The pipeline mapped onto node types

Stage receipts (`lane_pilot_stage_receipt`) and attempt states stay exactly as written today, because the same functions write them. The engine adds its own journal next to them.

| Today (file) | Node id | Type | Wraps | Notes |
|---|---|---|---|---|
| `dispatchWriter` intake: PM metadata, config, `validateTaskV2`, `findLiveDuplicate`, family check, `lintTask`, `createTask`, `saveTaskPlan`, `run.gate=pre-merge` stage, `createAttempt`, pending writer receipts | (outside the graph) | intake | stays in `dispatchWriter` | It answers the PM synchronously with a rejection and creates the rows the run hangs on; the workflow run (`lane_pilot_wf_run`) is born after the attempt exists and is keyed by the attempt id. |
| `runPmRead` (critique-runs.ts) | `pm-read` | agent (helper thread, role pm-reader) | `runPmRead` | out: state passed/skipped/failed, summary, reason |
| `failed` branch of pm-read | `block-pm-read` | action | the same glue as in `runStages`: plan-critique and specialist-review skipped, writer stages skipped, attempt blocked, run blocked | out: reply |
| quality_mode (`resolveQualityMode`, `applyQualityMode`) | `quality-mode` | decision | reads the task and the project setting | out: mode quick/standard/full. Edges: quick goes to `plan-critique-quick`, standard and full go to `plan-critique`. Both nodes call `runPlanCritique`, which owns the skipped receipt `quality_mode_quick` (its input hash includes the coverage scan, so the receipt stays byte-identical only if the function writes it). |
| `runPlanCritique` | `plan-critique`, `plan-critique-quick` | agent (role plan-critic) | `runPlanCritique` | out: allowed, reason |
| not allowed | `block-plan-critique` | action | skip specialist and writer stages, attempt blocked, run blocked | |
| `runSpecialistReview` | `specialist-review` | agent (role specialist-reviewer) | `runSpecialistReview` | out: allowed, reason |
| not allowed | `block-specialist` | action | skip writer stages, blocked | |
| live-folder check, `gitOwnershipBase`, `saveTaskGitBase` | `ownership-base` | action | the same host calls | out: ok, reason. Failure writes the `run-gate` receipt and skips the writer stages as today |
| failed base | `block-ownership` | action | | |
| `persistTaskFolder` | `task-folder` | action | | best effort; a failure only logs, as today |
| cancel check, `transitionAttempt(queued)`, `services.startWriterTask`, reply | `writer` | lp-task | `startWriterTask` | asynchronous: the step goes to `waiting` and the attempt is what it awaits. Inside (locked, not editable in an editor): `writer-agent`, workspace and worktree, `verification`, `code-critique`, repair rounds, merge intent + `gitIntegrate`, integration gate (`integration-gate.ts`), `acceptance-receipt`, retries, fallbacks, memory and project-life after acceptance, `browser-qa` for quality_mode full |

Why the writer internals are one node: `start.ts` and `finish.ts` are one loop with shared state (session turns, budgets, breaker, retries, pools). Peeling them into graph nodes is a later step (W3+) and has to come with its own equivalence tests; doing it inside W2 would change behaviour. The `lp-task` node declares the stage ids it owns (`stages`), so a UI can show them.

The step `writer` is settled by polling the attempt (`poll` of the lp-task executor reads the latest attempt of the task): accepted, blocked and canceled end the step. The poll runs in the periodic task-reconcile pass. For this node the engine is a bookkeeping layer over the writer, not a second controller: the writer's own recovery (`resumeOrphans`, merge intents, parking) stays the authority.

Other pipelines in the plugin (docs, onboarding, project-life, night review, memory) are not task pipelines and stay as they are.

## 3. Format: JSON

- JSON files read with `jsonc-parser` (already a dependency), so a user file may carry comments and trailing commas; built-ins are plain JSON imported as modules (the bundler inlines them, no file read at runtime).
- Why not YAML: there is no YAML dependency in the plugin; zod validates parsed JSON directly; the editor (W6) round-trips JSON without loss; PM agents write JSON reliably; Graph Studio stores JSON too. The cost is no comments in built-ins; text lives in `label`/`description` fields and `note` nodes.
- The schema is closed (`.strict()`): a typo is an error, not a silently ignored key (the Maestro `quality-loop` branch that watched a field nobody wrote ran on its default for years).
- `schemaVersion: 1` is in every file.

## 4. Where workflows live

1. Built-in: `workflows/*.json` in the repo, imported by `src/workflow/builtin.ts`. Scope `builtin`, read-only.
2. Global: `~/.lane-pilot/workflows/*.json` on the hub.
3. Project: `<project>/.lane-pilot/workflows/*.json` (in the project's repository, read through the host of the project's machine).

Precedence: project, then global, then built-in, by id. The store takes a `WorkflowFileSource` port (list/read), so the project source can use host calls later; a node-fs adapter is provided for the global directory. An invalid file is reported in `problems` and not loaded; it never shadows a valid workflow of a wider scope. A run pins the exact definition (JSON copy, sha256, version) in its row; editing the file never changes a run in flight.

## 5. Schema (W1)

Workflow: `id`, `name`, `description{en,ru}`, `examples{en[],ru[]}`, `inputs[]`, `outputs[]` (declared fields), `requires{plugins,machines,env,browserSession}`, `status draft|tested|published|deprecated`, `version`, `budget{maxSteps,maxTokens,maxCostUsd,maxWallSeconds}`, `guards{maxSteps,maxFanOut,maxSubworkflowDepth<=3}`, `quality_mode`, `triggers[]`, `scope{level,projectId}`, `nodes[]`, `edges[]`.

Nodes (`type`): `agent`, `lp-task`, `action`, `decision`, `human`, `parallel`, `join`, `subworkflow`, `note`. Every node: `id`, `label`, `output[]` (declared fields: the only things a condition or a mapping may read), `uses` (executor key), `maxVisits`, `maxAttempts`, `timeoutSec`.

Edges: `from`, `to`, `when` (a structured condition or an expression string, section 12), `label`, `with` (mapping name to `node.field`), `pass` = `artifact | same-session | read-prior-session | fork`. Sentinels `start` and `end` (stored as `$start` and `$end`, so a node may be called `start`); edges into `end` carry `with` and form the workflow output.

Conditions: `{field, op, value}`, `{all}`, `{any}`, `{not}`; ops eq, ne, gt, gte, lt, lte, in, notIn, exists. `field` is `name`, `name.sub` or `name.length`. Validation (a save/load error, not a warning): the field root is declared in the output of the edge's source node; the declared type fits the op (numbers for gt/lt); enum literals belong to the enum. At runtime a missing value fails the step closed (`condition_field_missing`), never "false, take the default" (Maestro D2: `x < 60` true for undefined).

Other save/load checks: unique ids; exactly one entry edge from `start`; known endpoints; every node has an outgoing edge; a node has conditional edges plus at most one unconditional fallback; every cycle contains a node with an explicit `maxVisits`; `with` and prompt placeholders `{{node.field}}` reference an ancestor and a declared field; passing modes other than `artifact` need agent nodes on both ends; every `parallel` has a `join` that every branch reaches; `foreach` references a declared array field; subworkflow targets exist and the call chain has depth <= 3 with no recursion (when a resolver is given); agent nodes always carry `handoff` (the compile step adds the field to the declared output; the engine requires a non-empty value).

Guards: node `maxVisits` (per scope; without it a node may be visited any number of times, and every loop must be bounded by a `maxVisits` on one of its nodes or a `visits('node')` condition on one of its edges, checked at save), node `maxAttempts` (per visit, default 1, at most 5), workflow `guards.maxSteps` (steps in a run, default 60), `guards.maxFanOut` (default 12; overflow fails, `onOverflow: truncate` is explicit).

## 6. Engine (W2)

State is a journal in plugin SQLite (migrations appended to `migrations`; the lineage test pins only the first 24):

- `lane_pilot_wf_run`: id, idempotency key (unique), workflow id/version/sha256, pinned definition, links to the LP run/task, parent run and parent step (subworkflow), depth, status (`running|waiting|succeeded|failed|blocked|interrupted|canceled`), reason, inputs, output, `harness_version`, usage counters, `owner_id` and `lease_until`.
- `lane_pilot_wf_step`: run id, step key, node id, visit, scope, `origin` (unique per run: hash of parent step, edge and branch), state (`pending|running|waiting|succeeded|failed|skipped|interrupted|canceled`), attempt, input, output, error, `spawn_key`, `harness_version`, receipt (executor, input and output sha256, thread id, usage, handoff, times), `routed` flag, `fan_count`.
- `lane_pilot_wf_arrival`: branch arrivals at a join (group key, branch index, data).
- `lane_pilot_wf_effect`: the generalized merge intent (below).
- `lane_pilot_wf_event`: append-only log of every transition (a refused transition is logged too), the audit trail the Maestro engine lacks (D4).

Step states move only along a table (`pending -> running|skipped|canceled`, `running -> succeeded|failed|waiting|interrupted|canceled`, `waiting -> succeeded|failed|canceled|interrupted`, `interrupted -> running`), each as a conditional UPDATE (compare and set), so a second writer loses cleanly; an illegal move throws and is journaled.

Driving a run: the engine routes finished steps (successor steps get deterministic origins and are inserted with `INSERT OR IGNORE`, so routing twice after a crash creates nothing twice), runs ready steps, and finishes the run when nothing is pending, running or waiting. Routing is `first` (the first matching conditional edge, else the single unconditional fallback; none matching fails the run with `no_matching_edge`, not a silent default), or all edges for a `parallel` node. Parallel: one branch scope per edge, or per item for `foreach`; branches meet in the `join` (all arrive, results in branch order), then the run continues in the parent scope.

Reload and resume: `engine.resume()` reads the journal. A `succeeded` step whose routing was not recorded is routed; a `pending` step runs; a `running` step is re-run if its executor is `reentrant` and the harness version is the same, else it becomes `interrupted` and the run `interrupted` with the reason. Nothing finished is executed again. The pinned definition is used, not the file on disk. Two instances during a reload (BB builds the new instance before it drains the old one) are kept apart by a lease on the run row (`owner_id`, `lease_until`, renewed while driving, released on dispose, taken over only when expired): the Maestro run without liveness (D11) is what this avoids.

Effects (generalized G2): `ctx.effect(key, kind, fn, {reconcile})` writes `intended` before the external call and `done` with the result after. On re-entry a `done` effect returns its recorded result without calling again; an `intended` one asks `reconcile` (ask the world whether it happened, as `mergeLanded` asks the repository, or `reconcileCritic` asks threads by metadata) and, with no reconcile function, becomes `unknown` and fails the step instead of repeating an effect that may have landed. The existing merge intent stays in KV and is used by the wrapped `finishWriterAttempt`; the periodic reconcile pass runs the merge intent recovery first and the engine poll after it.

Spawn keys (C1): `spawnKey = sha256(runId | stepKey | attempt)`, handed to executors; a generic agent executor (W3) writes it into thread plugin metadata (`lanePilotWorkflowRunId`, `lanePilotWorkflowStep`), so a lost spawn is found by metadata like writers and critics are today. The wrapped stage functions keep their own keys.

Drain: before every step the engine asks the `admit` port. A draining or disposed instance stops at the step boundary and leaves the step `pending`, so the instance that starts next resumes it (a running step is never cut by the engine; the host calls inside it are already drain-gated). The lease is released on dispose.

Budgets (G3): `budget.maxSteps/maxTokens/maxCostUsd/maxWallSeconds`, counted in the run row from the usage that executors report and checked before each step. Exceeded means status `blocked` with `budget_exceeded:<what>`. A tripped guard sets the run to `failed` with `guard:<name>:<node>`.

Harness version (G4): stored on the run and on each step. A different version never re-runs a step that was `running` (it becomes `interrupted: harness_changed`); pending steps go on under the new code.

Subworkflows: child runs (`parent_run_id`, `parent_step_key`, unique), depth counted, more than 3 fails (`subworkflow_depth`); on resume the existing child is found, never created twice. Handoff: an agent node's output must contain a non-empty `handoff`, else the step fails (`handoff_missing`). Data passing: the step input carries `with` (mapped fields only; mode artifact) and `via` (`mode`, source step, source thread id when the source agent reported one), so a generic agent executor can send into the same thread, read the prior session's handoff, or fork.

Waiting: an executor may return `wait` (human answer, attempt in flight). `engine.resolve(runId, stepKey, output)` settles from outside; `engine.poll()` calls each waiting executor's `poll`. A run whose only unfinished steps wait has status `waiting`.

Maestro defects avoided on purpose: D1/D2 (a verdict is a field the code branches on, not text a model interprets), D3 (a block is a terminal status), D4 (budgets, attempts and reasons are stored and enforced), D5 (stage receipts are keyed by input hash), D6-D9 (one SQLite transaction per transition, no file lock), D11 (lease and poll), D16 (idempotent routing, no re-execution of a node with side effects, a condition on a missing value fails closed).

## 7. Quality mode

`quality-mode` is a decision node whose output field `mode` drives edge conditions (quick, standard or full). The stage functions still apply `applyQualityMode`, because inside the writer (code critique, browser check) the mode is read from settings and those stages are not graph nodes yet.

## 8. Kill switch and rollout

`LANE_PILOT_WORKFLOW_ENGINE=0` (also `off`, `false`) selects the old path in `dispatchWriter`; anything else, including unset, selects the engine. No setting, no manual step. A failure to start the engine (journal write error) falls back to the direct path for that dispatch and logs; a dispatch is never lost to bookkeeping.

## 9. Proof of equivalence

1. Existing suites: `tests/stages/server-stage.test.ts` (117 dispatch-to-accepted scenarios) and the dispatch tests run with the default (engine on); the same file was also run with `LANE_PILOT_WORKFLOW_ENGINE=0`, both green (not kept as a permanent twin: it would add 80 s to every full run).
2. `tests/workflow/equivalence.test.ts`: the same dispatch scenarios with the engine on and off produce identical stage receipts (normalized for clocks and thread ids), identical attempt and run states and identical dispatch replies.
3. Engine tests: linear, decision, parallel and join, foreach, guards (visits, attempts, steps, fan-out, budget), reload at every point, subworkflow depth.

## 10. What W3-W6 build on

- W3 (built-in chains): add JSON files to `workflows/`; executors come from a registry (`uses`), so a chain of agent nodes needs only the generic agent executor (spawn by key, handoff) on the `agent.run` port.
- W4 (router): `WorkflowStore.list()` has `description`, `examples`, `status`, `requires` for the catalog.
- W5 (view): the journal tables and the event log are the data of the live graph; `engine.snapshot(runId)` returns nodes with step states.
- W6 (editor): schema and validator are pure; the editor saves through `parseWorkflow` and shows its problems list.
- Later: peel the `lp-task` internals into nodes; the effect table is the place for the merge as an effect.

## 11. Risks

- The journal duplicates information the stage receipts hold; they can drift if an executor changes without the journal (mitigation: the journal records references, the receipts stay the truth).
- The `writer` step is settled by polling every 5 minutes; the journal can lag the attempt by that long (behaviour is unaffected).
- Glue is duplicated between the legacy `runStages` and the executors (on purpose, for the kill switch); the equivalence tests are the guard.
- Leases rely on one clock; the plugin runs on the hub.
- A `writer` step settled as `blocked` can be restarted later by the parked-task sweep as a new attempt; the journal keeps the first verdict of the step (the run record says what the dispatch pipeline did, the attempts say the rest).

## 12. The spelling of the chains spec (workflow-chains-spec.md, section 8)

The schema takes the authoring spelling of the chains spec and normalizes it (`normalizeWorkflow`) before the closed schema runs, so a file in either spelling loads to the same value. JSON is the canonical storage.

- Fields: `out` (map of `name: "type hint"` or a field list), `guards: {maxVisits, maxAttempts, timeoutMin}`, `entry`, `internal`, `not_for`, `tags`, `src`, `model_preset`, `profile{skills}`, `session`, `authorized`, `test`, `test_mode`, `requires{skills, secrets, project}`, `quality_mode{default, effect}`, `budget{max_steps, max_minutes, max_usd, max_fan_out}`, triggers as strings. Type hints: `string int bool any`, `X[]`, `Name` (a named shape), `a|b|c` (enum), `T|null` and `T?` (optional). Inputs are optional unless `required: true`; node outputs are required unless `required: false`; workflow outputs are optional (an emit gives what its path produced).
- Skipping: `applicable_modes` (outside them the node is skipped), `skip_when`, and `skip_out` (the typed output of a skipped node; a skippable node whose fields others read must give them, checked at save). A skipped fan-out skips its join with the same output.
- Terminals: an `emit` action ends the workflow (`status`, `map`); `emit` nodes become nodes with an edge to the exit, and the workflow `outputs` are checked against each emit.
- `parallel` with `for_each` + `child` + `join{policy, out, uses}` in one node. `for_each` is a reference, a literal list, `ref where <condition on the item>`, or `{by: "$inputs.tier" | "$mode", <value>: [...]}`; `batch_size` groups the items; `max_fan_out` caps the branches (overflow fails unless `onOverflow: truncate`). Lowering turns it into `<id>:fan`, `<id>:child` and a join that keeps `<id>`, so `<id>.field` reads the joined result. The default reducer concatenates arrays of the same name; any other join field needs `join.uses` (the validator warns).
- Expressions (`when`, `skip_when`, `where`, value positions): `== != < <= > >= && || ! + - in [...]`, `.length`, `visits('node')`, `$inputs.x`, `$mode`, `ctx.run_id|goal|merged_commits`, `item`, `index`, `node.field`. Checked at save against the declared fields (unknown field, enum literal that can never match, number compared with a string, list compared with `==`); at run time a node that has not run fails the run (`condition_field_missing`), a field it left out compares as nothing. In value positions (`emit.map`, `skip_out`, node `with`) a node that did not run gives nothing instead. A loop is bounded by a `maxVisits` or by a `visits()` condition on one of its edges; a node without `maxVisits` may be visited any number of times (`guards.maxSteps` still caps the run).
- Node `with`: `{{ref}}` templates (a lone placeholder keeps the value's type), nested lists and objects, `{by_mode: {quick, standard, full}}`. `$mode` is the `quality_mode` input, else the parent's mode, else the workflow default.
- `pass` other than `artifact` needs an agent as the target (the agent that goes on in its own earlier session or the one the source left behind).
- Not run yet (the schema accepts them; the engine refuses to start such a workflow with a clear message): `join.policy` other than `all`, `votes` above 1, `order: depends_on`, `on_child_fail`. W3 builds them.
- Fixtures: `tests/workflow/chains/` holds `lp.analyze`, `lp.plan`, `lp.build`, `lp.review`, `lp.close`, `analyze-plan-execute` (the spec's, not the built-in of this repo), `review-fix` and `x-to-telegram-digest` converted from the spec by script; `x-to-telegram-digest` also runs end to end on stubs. The validator found defects in the spec text itself (listed in the report).

## 13. The Workflows tab (W5)

Read side only; the editor (W6) adds saves next to it. `src/server/workflow-library.ts` reads the store (built-in, `~/.lane-pilot/workflows`, the project's files through the host call `listWorkflowFiles`) and the journal; `src/workflow/view.ts` reduces the lowered workflow to what a screen draws (the lowered form, so a run's node ids and edge indexes match). `workflow_run_snapshot` is `engine.snapshot` with each step's chat, handoff and a clipped output. Every journal event goes to `EngineOptions.onEvent`; the server maps it to `lp:<project>` kind `workflow` (with `runId`) and to the global channel `lp:-`. Drafts of the workflow architect arrive as `workflow-draft` signals (`draftId`) and are drawn by `src/workflow/draft-view.ts`, which reads a half-written workflow without the closed schema.
## 13. The Workflow architect (drafts)

An agent profile (`workflow-architect`, `src/workflow-architect.ts`) builds chains with six tools in `src/server/workflow-architect.ts`; the pure parts live in `src/workflow/`.

- **Draft** = a workflow in the authoring spelling (section 12), kept in `lane_pilot_wf_draft` with a counter `version` and a log in `lane_pilot_wf_draft_version`. It may be invalid while it is built; `checkDraft` (the `loadWorkflow` verdict) returns the problems with `node` and `edge` indexes. Operations: `add_node`, `update_node`, `remove_node` (its edges go with it), `add_edge`, `update_edge`, `remove_edge` (by index or by `from`, `to`, `when`), `set_meta` (everything but the graph, the status and the version). An operation that cannot be applied refuses the whole patch (`applyDraftOps`), nothing is saved.
- **Test** = the real `WorkflowEngine` with a stub executor for every key that is not a builtin (`runDraftTest`). A case is the draft's `test.sim`: `input`, `stubs` (node id to output fields), `human_answers`, `expect_path`, `expect_output`, `expect_status`, and `variant_<name>` entries that override it. Without a `test` a smoke case is made from the declared inputs. The runs stay in the journal under the workflow id `draft-test.<id>`, so a screen can open them like any run. A draft is `tested` when every case ran green on its current version; any patch takes it back to `draft`.
- **Publish** writes the parsed workflow (status `published`, `version` raised over an earlier publication of the draft, scope set) as `<id>.json`, after a round trip through the loader. The write is compare-and-swap on the file's hash: only the file this draft published earlier is replaced. The answer lists executors the running instance has not registered (they were stubbed in the test); the file is written anyway.
- **For the screen:** `workflow_draft_list` / `workflow_draft_get` (summary, definition, check, tests), the signal `{kind: "workflow-draft", draftId}` on `lp:<project>`, `useWorkflowDraft` (re-reads on the signal, on a reconnect, and on a slow poll). The graph component takes `definition` through `parseWorkflowObject` like a file and marks `check.problems` on the nodes and edges they name. The launch action: `requestArchitectLaunch(projectId)`, then the project's new-chat composer.
- Join policies, votes, ordering (W3):
  - `join.policy: all` (default) fails the run at the first failed branch. `majority` and `all_or_low_confidence` let a failed branch arrive as failed instead: the join step sees `results` (the finished branches), `failed` (`{branch, item, error, blocked}`), `rows` (every branch in order) and `items` (the list the fan-out walked), whatever reducer builds its output. `majority` fails the join with `join_no_majority` unless more than half of the branches succeeded; `all_or_low_confidence` goes on with whatever finished, even nothing (the chain reads the counts the reducer gives).
  - `votes: N` on an agent child runs the step N times independently (own spawn keys, `ctx.vote`) and code decides: a boolean field is true when more than half of the answers say true (2 of 3), a number is the median, another scalar the most common value; arrays and objects come from the first answer that agrees with the majority. More than half of the votes must answer or the step fails. The answers are kept in the receipt (`detail.votes`).
  - `order: depends_on` on a fan-out over objects with `id` and `depends_on`: branch `i` starts only after the branches its `depends_on` names have arrived at the join (an id outside the list counts as done; a cycle fails the run before anything starts). `on_child_fail: block_dependents` lets a failed branch arrive as failed and blocks what depends on it, transitively (`upstream_blocked:<id>`, step `canceled`); without it a failed branch fails an `all` join as before. The gate is read from the journal, so a reload goes on from where it was.
  - A join that builds more than the concatenation of arrays names its reducer in `join.uses` (`reduce.<workflow>.<node>`, `src/workflow/reducers.ts`).
- Chains: all 37 workflows of the spec are `workflows/*.json` (see section 13).

## 13. The chains (W3)

All 38 workflows of the chains spec are `workflows/*.json`: the 15 built-in chains, the 9 single-step chains, the 6 owner's own chains, 7 internal fragments (`lp.analyze`, `lp.plan`, `lp.build`, `lp.review`, `lp.close`, `lp.brainstorm`, `ins.post`) and the per-task pipeline `lp-task-pipeline`. They were converted from the spec's YAML by script and then checked by the validator and by a test case each (`tests/workflow/chains-*.test.ts`, run on stubs through the real engine with the real reducers and code-only actions; the harness is `chain-harness.ts`). Defects of the spec text found on the way are fixed in the data (skipped nodes without `skip_out`, a missing input, bare words read as literals, loops that could not take their second visit, joins that cut a list at a cap).

Status: `published` means the test case passes on stubs. The owner's own chains (`x-to-telegram-digest`, `insights-post`, `reels`, `seo-cocoon`, `web-research`, `deploy`) stay `tested`: their outside actions (X in a browser session, a Telegram send, ffmpeg, a paid search, a real deploy) are stubs in the case, and `test.note` says what is not live yet. The router offers only `published` workflows, so those six are not offered to a PM until a live run lifts them.

Engine additions the chains needed (besides section 12):
- `parallel.concurrency`: how many branches run at once. `max_fan_out` stays the cap on how many branches there may be; the chains' `max_fan_out` meant concurrency (three roadmap sessions against a limit of 2) and was renamed there, except where it is a real cap. `guards.maxFanOut` (default 12) is the workflow's cap.
- `quality_mode.min` and `quality_mode.fixed`: a refactor is never run `quick`, a companion run is always `quick`.
- `{{node}}` as a whole value in `emit.map`, `skip_out` and `with` (a bare word alone is a literal); a lone placeholder in a list that names nothing leaves no hole.
- `{{slug}}`, `{{date}}`, `{{run_id}}` run variables.
- Same-session and read-prior-session edges find the thread by the target agent's own earlier session first, then the source step's, then the latest helper thread of the branch (a lint between two agent visits has no thread).
- `engine.resolve` and `poll` drive a run after a drive that is just ending; `runtimeFor` rebuilds the runtime of a run that outlived a reload.

### The executors on the host (`src/server/workflow-executors.ts`, `workflow-agent.ts`)

- `agent`: a helper thread of the PM chat (`helperChildPlacement`, `requireHelperSpawn`, `fullAccessSpawn`, the VK spawn key in `spawnId` and the plugin metadata `lanePilotWorkflowRunId`, `lanePilotWorkflowStep`, `lanePilotWorkflowSpawn`), with the profile of the node's role, the skills, provider, model and reasoning of the node, the node's prompt, its data fenced as data, the role method and the typed contract. It waits for the thread to be idle, reads the last JSON block, asks once more in the same thread when there is none, and fails the step when the helper edited a repository file it may not touch (`repo_edited`, as for errands and specialists). `same-session` sends into the earlier thread; `read-prior-session` names it in the prompt. Re-running the step after a reload is safe (`reentrant`) only where the core has the thread keys.
- Roles: `analyst`, `planner`, `auditor`, `debugger` are thin profiles in `ROLE_PROFILES` (read the code graph, nothing else; the owner changes them in Agent access like any role). `plan-critic`, `code-critic`, `triager` (gate-triage), `browser-qa`, `errand`, `council`, `memory`, `project-life` and `specialist:*` use the profiles they already have; a specialist keeps metadata role `specialist` and may write `.agents/`.
- `human`: the node's question as a BB form in the PM chat (`ownerAsk`, the same form as `lane_pilot_ask_owner`), with the values of `answer_kind` as the options. The answer settles the step; after a reload the periodic poll opens the form again; `timeout` answers by the clock where the node allows it.
- `lp-task` in a chain: the contract (or a contract a planner helper writes from `contract_template`) is validated as task-v2, linted, and sent through `dispatchWriter` (the whole writer pipeline); the step waits for the attempt; an accepted attempt gives its merge commit (found by the attempt trailer) and files. The same key still serves the per-task pipeline.
- Actions: code in `src/workflow/actions.ts` (`items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, `lp.propose_workflow`), the plugin's own state (`lp.state_probe`, `lp.run_status`, `lp.lint_contract`, `lp.run_close`, `lp.integration_gate_status`), the PM's checkout (`fs.write`, `git.diff_files`), and through a helper thread with the skill or tool in hand (`telegram.send_rich`, `shell.skill_script`, `shell.repo_script`, `deploy.post_check`, `lp.preflight`, `lp.project_checks`, `bb.tasks.*`).
- Joins: `src/workflow/reducers.ts`, one pure function per join of the chains (`reduce.<workflow>.<node>`).

Known gaps: the integration gate keeps no receipt, so `lp.integration_gate_status` answers `skipped`; the memory and project-life nodes are helper threads that propose, they do not stage through the task-bound stages; the secrets an errand-like action reads are not gated by the project's allowed-secret list (the errand tool does); the shell guard's helper role list (`lane-stack/hooks/guard_shell.py`) does not know the four new roles yet.
