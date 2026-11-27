---
title: Everything is a graph
topic: graphs
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, graphs]
updated: 2026-11-27
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/engine-clock.ts
  - packages/workflow-engine/src/inbox.ts
  - packages/workflow-engine/src/router.ts
  - packages/workflow-engine/src/validate-rails.ts
  - packages/workflow-engine/src/publish-authority.ts
  - packages/workflow-engine/src/index.ts
  - packages/contracts/src/graph-categories.ts
  - packages/contracts/src/tool-tiers.ts
  - packages/contracts/src/work-kinds.ts
  - packages/contracts/src/publish-grant.ts
  - src/rooms/workflow/server/services/path-save.ts
  - src/rooms/workflow/server/services/project-template.ts
  - src/rooms/workflow/server/services/publish-gate.ts
  - src/rooms/workflow/server/services/workflow-prove.ts
---

# Everything is a graph

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

A workflow is a JSON file (`workflows/*.json`): inputs, outputs, `category`, `not_for` (distinguishing neighbours), `requires` (skills, plugins, secrets, machines), guards, triggers, nodes and edges. The shared engine (`packages/workflow-engine`) validates it, freezes a snapshot per run (`definition_json`), runs it as a resumable graph, journals every step in SQLite and resolves subworkflows. Node types in the shipped graphs: `agent` (a model step with a role, optional node model override and `form`: `agent | plan | script` with `fallback` and mechanical `verify`), `action` (code), `decision`, `human` (a form to the owner), `parallel`/`join`, `subworkflow`, `lp-task` (the writer task pipeline) and `note`. Model steps resolve `node -> role -> default` (with automatic role fallback on auth/quota/subscription errors, see [Roles, agents and models](roles.md)).

- **Catalog.** 120 graphs ship with the plugin (113 `published`, 7 `tested`), organized across 13 categories (`packages/contracts/src/graph-categories.ts`: `code`, `planning`, `qa`, `ops`, `docs`, `seo`, `marketing`, `content`, `research`, `games`, `business`, `routines`, `service`). `builtin.ts` loads `workflows/*.json` from disk. A `tested` graph shows **Run for real** in the Workflows tab; one success makes it published. Owners can add graphs in the global or a project workflow folder.
- **Events, durable waits and one clock.** Events (`LP_EVENTS`) land in `lane_pilot_wf_inbox` via `emitEvent` (insert-or-ignore, filter match, `engine.wake` with compare-and-set on `state='waiting'` and attempt fencing). Every waiting step (`event` or `human`, 72 h default on `human`) carries an absolute epoch `deadline` (`await_json.deadline`) and a routed `timeoutOutput` edge enforced by `validate-rails.ts`; skipped checks record `not_run` rather than `pass`, and judge nodes cannot take worker sessions. One engine clock (`startClock` in `engine-clock.ts`, paused by `schedule.paused_all`) sleeps until the earliest step deadline or due schedule-board row (up to `CLOCK_BEAT_MS` = 60 s), drains up to 25 overdue waits per tick, and enforces per-node and per-run budgets (`maxTokens`, `maxCostUsd`, `maxWallSeconds`, `maxRepeats`), killing child processes/threads on stop.
- **Router.** `lane_pilot_route` ranks graphs deterministically using BM25, trigram matches, rules, exclusions, `not_for` hints and requirements. A concise `intent` selects the task family; optional `request` preserves the complete assignment for goals, inputs and constraints (up to 4,000 characters). Without it, `intent` remains the full assignment. A recognized read-only request conflicting with a selected writing graph returns `clarify`, even if the short intent asks for deployment. This conservative check is not a general semantic validator: the PM must compare the selected graph's actions with the complete assignment. `clarify` permits no launch through candidates, live trials or fallback tools; clarify with the requester and route again. An owner or BB-agent assignment can authorize the selected outcome; graph human confirmations remain unchanged.
- **Triggers.** A graph starts from the PM chat (`chat`), by hand from the Workflows tab (`manual`), from a schedule (`schedule`, synced to schedule-board rows), or on an engine event (`event`). All go through the same checks.
- **Authoring.** The Workflow architect agent drafts, patches and tests a graph on stubs (nothing is touched); publishing waits for the owner's yes. A published graph can run on a schedule.
- **Project loop hooks.** A project may reserve `.lane-pilot/workflows/loop-hooks.manifest.json` with `schemaVersion: 1` and ordered arrays for `plan:pre`, `verify:post` and `ship:post`. Each entry names an existing published workflow id and maps child inputs from `$inputs.<field>` or the existing `ctx.run_id`, `ctx.goal`, `ctx.merged_commits` and `ctx.answers.<human>` context values. Lane Pilot resolves these literal children before preflight and pins them with the normal engine definition; requirements are merged for preflight and human waits/errors remain ordinary child outcomes. The reserved file is excluded from the workflow catalog. Missing manifests are a no-op; malformed manifests, missing/unpublished children, cycles and excessive depth refuse a targeted start. `plan:pre` is inserted at the `lp.plan` entry boundary, `verify:post` immediately before each `lp.close` terminal emit, and `ship:post` immediately before the successful `ship`/`shipped` emit; the original emit remains last, so its output and failure semantics are unchanged. This covers trigger and PM tool starts, including nested `lp.plan`/`lp.close` children; callers that bypass workflow start are outside the contract.
- **Runs audit their goals.** A run is checked against the goals the owner confirmed before it closes; a run blocked on unmet goals is fixed or amended with a reason in its journal.

## Shipped graphs

`(tested)` marks graphs that have not yet had a successful live run.

**Code (`code` and core service building blocks)**

| Graph | What it does |
|---|---|
| `lp-task-pipeline` | The pipeline of every writer task: admission wait (`lp.task.settled`), PM read, plan critique, specialist review, ownership base, the code task in its own worktree with checks, code critique and merge, then the browser check when the task has `qa_cases`. Not offered by the router (`service`). |
| `lp.after-accept` | Runs on `lp.attempt.merged`: triggers the memory maintainer (`service`). |
| `lp.plan` | Turns a goal into task contracts in waves, lints them and has the whole plan critiqued. |
| `lp.build` | Runs task contracts through the pipeline (writer, sandbox verification, code critic, merge queue) and the batch gate. |
| `lp.analyze` | Read-only analysis of an area with locked, free and deferred decisions, risks and a scope verdict. |
| `lp.review` | Multi-dimension review of a diff, PR or file set; the verdict is computed by code. |
| `lp.brainstorm` | Role authors in parallel, a fresh cross-role reviewer, conflicts resolved with the owner, a guidance specification of at most 8 features. |
| `lp.draw` | The design lead draws the screens a plan changes as clickable HTML mock-ups; another role checks them. |
| `lp.close` | Checks each goal's `done_when` against evidence, detects intent drift and stages knowledge candidates. |
| `lp.clarify` | Disambiguates an unclear request into scope and questions (`service`). |
| `analyze-plan-execute` | Default path for a normal code task: analysis, task contracts, plan critique, writers in worktrees, code critic, merge, goal audit, memory. |
| `companion` | A mechanically clear, bounded change: one writer task in quick mode, no plan, no critics. |
| `issue-quick` | A small issue from a title and text: one cheap call writes the task, the writer builds it. A large issue is proposed to the full path. |
| `issue-quick-legacy` | The previous quick path (triage, plan, build); used when `issue_quick.short_path` is off. |
| `issue-full` | Root cause, plan, build, review; reports fixed only after a green review. |
| `issue-batch` | Several small independent fixes in one request, edits of one file as one task, independent areas built in one wave. |
| `issue-discover` | Eight read-only perspectives (security, performance, reliability and more) scan an area; findings are deduplicated. |
| `full-lifecycle` | Plan, build, independent review with a fix loop, browser check, owner acceptance for UI, goal audit, knowledge closeout. |
| `grill-driven` | For big or risky changes: an adversarial walk through the plan against the real code, then brainstorm, plan, build, close. |
| `impeccable-build` | A UI from scratch: design brief, DESIGN.md pack, build in worktrees, browser verification at 375 and 1280 px, DESIGN.md from the result. |
| `refactor` | Behaviour-preserving restructuring: baseline first, plan with critique, writers, equivalence check, review. |
| `quality-loop` | Review, missing tests by layer, failure classification, diagnosis, fix and re-check; schedulable at night. |
| `review-fix` | Takes review findings (or runs a review), groups them by root cause, fixes and re-reviews up to two rounds. |
| `ai-integration-phase` | Before shipping model behaviour: framework and model choice, research, AI-SPEC.md with guards, evaluation plan and cost ceiling. |
| `analyze-code` | Understand or evaluate a module or change; reports decisions, risks and confidence. |
| `code-review` | Independent review of a branch, PR, commit range or file set with file:line findings. Exports the criterion checks from `lp.review` alongside findings, so the report and goal auditor can see checks that produced no finding. |
| `debug` | Scientific-method diagnosis (hypotheses, evidence log, at most 3 refuted); returns the diagnosis, touches no code. |
| `security-audit` | Tiered audit (OWASP Top 10, dependencies, secrets, CI/CD, STRIDE on the deep tier); secrets reported by location only. |
| `spike` | A time-boxed throw-away experiment answering one technical question. |
| `scout` | Read-only codebase reconnaissance returning facts and file locations. |

**Planning (`planning`) and QA (`qa`)**

| Graph | What it does |
|---|---|
| `plan-only` | Analyze and write task contracts with plan critique, saved as a draft; nothing is built. |
| `plan-review-convergence-proof` | Two critics of different models review a plan for up to three rounds until both approve. |
| `blueprint-driven` | For a new product: brief, PRD, architecture decisions, epics, a readiness gate, the spec in the repository, then build per epic. |
| `brainstorm-driven` | From a vague idea: optional research, multi-role brainstorm, guidance spec, plan, build, close. |
| `grill-plan` | The adversarial review of a plan on its own; changes nothing. |
| `idea-shootdown` | Stress-tests an idea against failure modes, existing alternatives and constraints before writing a plan. |
| `roadmap-driven` | For large goals: a DAG of sub-goals approved by the owner, each run as `analyze-plan-execute`. |
| `project-start` | Value map first, a preview of stack, tests and memory, infra profile, working style, recap with next steps. |
| `new-milestone` | Starts the next milestone: goals, requirements, roadmap entries. |
| `milestone-summary` | Summarizes completed tasks and changes across a milestone. |
| `milestone-close` | Checks the run is finished, audits goals, runs a retrospective, stages knowledge candidates, archives the run. |
| `mvp-phase` | Scopes an MVP increment down to the minimum verifiable tasks. |
| `spec-phase` | Turns an approved outline into a concrete specification before planning. |
| `phase-assumptions` | Surfaces and verifies unstated assumptions in a plan before execution. |
| `plan-import` | Imports an existing markdown plan into executable task contracts. |
| `sketch-wrap-up` | Closes out a sketch session into structured deliverables and follow-ups. |
| `retrospective` | Four lenses (technical, process, quality, decision); stages note candidates, writes no knowledge without approval. |
| `backlog-add`, `note-add`, `todo-add` | Add structured backlog items, project notes or TODO entries without code edits. |
| `test-gen` | Writes missing tests for named gaps in test paths only; never edits source or existing tests (`qa`). |
| `ui-audit` | Live UI audit in the browser on six dimensions with scored findings and screenshots (`qa`). |
| `audit-uat` | Runs user acceptance checks against the stated requirements (`qa`). |
| `validate-phase` | Checks that every promise of a scope has a check that would fail without the work; writes VALIDATION.md (`qa`). |
| `secure-phase` | Verifies security posture and trust boundaries for a planned scope (`qa`). |
| `eval-review` | Audits the evaluation of an AI feature (gold set independence, metric honesty, gaming, leakage) (`qa`). |

**Delivery, ops and internal service loops (`ops` and `service`)**

| Graph | What it does |
|---|---|
| `ship` | Turns a verified batch into a pull request and runs post-ship hooks (`ops`). |
| `pr-branch` | Makes a review branch without the planning commits (`ops`). |
| `deploy` (tested) | Preflight, owner approval for production, deploy by the repo script or an errand, post-deploy check, rollback offer (`ops`). |
| `cleanup` | Archives finished goals, stale spikes, merged review branches and leftover worktrees; lists before moving (`ops`). |
| `specialist` | One specialist (`design-lead`, `copy-lead`, `seo-specialist`, `growth-marketer`, `tavily`, `video-lead` or an owner-created agent) does a task as a child thread of the PM chat (`service`). |
| `errand` | A non-code job done end to end by one helper: a browser, a mailbox, a cloud console, a deploy with Env Catalog accounts (`service`). |
| `browser-step` | One goal in the owner's signed-in Chrome on the browser machine with agent-desktop, then the page it ends on (`service`). |
| `lp.browser-qa` | The browser check of an accepted task: a verdict per case and viewport (`service`). |
| `lp.landing-suite` | Runs the integration gate when triggered by `lp.attempt.merged` (`service`). |
| `lp.canary-check` | Triggered by `lp.attempt.finished` to watch own-fault rate on a fresh build (`service`). |
| `lp.daily-report` | Daily 09:00 summary delivered to Telegram (`service`). |
| `lp.owner-bell`, `lp.owner-push` | Immediate `lp.owner.item-created` notifier with quiet-hours/cap wait (`lp.owner-bell`) and 30-minute Telegram owner digest (`lp.owner-push`) (`service`). |
| `lp.backlog-scan` | Scans repository TODOs and findings into the backlog (`service`). |
| `lp.schedule-script` | Runs scheduled host script entries under the workflow engine (`service`). |
| `lp.worktree-cleanup`, `lp.worktree-release` | Scheduled worktree cleanup and post-attempt worktree release (`service`). |
| `lead-tick` | Hourly work-graph / nearest-unit scan surfacing hypotheses for graphless work (`service`). |
| `sp-specialist-tick` | Periodic tick driving specialist background maintenance (`service`). |
| `lp.evolve` | Event-driven evolution graph (run-finished ingest, node proposals, held-out replay, canary decide, catalog re-proof; `service`). |
| `lp.review-desk` | Scheduled weekly review desk composing all learning loop decisions with conservative defaults (`internal: true`, `service`). |

**Docs, SEO, marketing, research, content, games, business and routines**

| Category | Graphs |
|---|---|
| `docs` | `docs-synthesis`, `docs-synthesis-rank`, `docs-synthesis-check` |
| `seo` | `seo-project-intake`, `seo-research`, `seo-cocoon` (tested), `seo-brief`, `seo-page`, `seo-page-refresh`, `seo-tech-audit`, `seo-structure-audit`, `seo-drop-diagnosis`, `seo-monitor`, `seo-ai-visibility`, `seo-mentions`, `seo-linkbuilding`, `seo-outreach`, `seo-trust`, `seo-template-scale`, `seo-release` |
| `marketing` | `mkt-project-intake`, `mkt-landing-cro-audit`, `mkt-direct-search-campaign`, `mkt-tg-ads-campaign`, `mkt-tracking-setup`, `mkt-experiment-cycle`, `mkt-pulse-monitor` |
| `research` | `web-research` (tested), `research-dossier`, `insights-post` (tested), `ins.post` |
| `content` | `social-post`, `x-to-telegram-digest` (tested), `reels` (tested), `telegram-send`, `deliver` (`internal: true`, shared delivery brick) |
| `games` | `3d-asset`, `roblox-asset` |
| `business` | `api-recon`, `invoice-send` (tested), `billing-batch` |
| `routines` | `agent-routine`, `macos-routine` |

## Step effect

Every node can declare an optional `effect` from the single shared `TOOL_TIERS` vocabulary (`R | D | L | S` in `packages/contracts/src/tool-tiers.ts`), reusing the same rank order (`TIER_RANK`) as specialist tools:

- **`R` (read-only)** — reads or checks; safe to replay live in the sandbox (`replayPolicy(tier) === "live"`). Example: `check` (`invoice.check`) in `workflows/invoice-send.json`.
- **`D` (draft / idempotent local write)** — reversible or stubbed work; replayed with stubbed side effects (`"stubbed"`).
- **`L` (live local/external mutation)** — creates or modifies state with side effects; never replayed (`"forbidden"`), only checked on recorded outputs. Example: `create` in `workflows/invoice-send.json` (`effect: "L"`, `form: "plan"`, `fallback: "agent"`).
- **`S` (irreversible / send / spend)** — external delivery, payment, or destructive change; never replayed (`"forbidden"`). Example: `send` and `topic` in `workflows/invoice-send.json` (`effect: "S"`).

Two static rails and one runtime guard enforce `effect`:

- **Ungated irreversible warning.** `validateWorkflowRails` (`packages/workflow-engine/src/validate-rails.ts`) emits `effect_irreversible_ungated` if a `script` or `plan` node with `effect: "S"` is reachable from `start` without passing a `human` node or an `authorized: true` gate.
- **Instruction budget warnings.** `validateNodeForms` (`packages/workflow-engine/src/validate-form.ts`) warns `prompt_over_budget` above 100 non-empty lines and `plan_over_budget` above 10 plan steps so steps stay compact.
- **Per-model proof (`proven_on`).** `bb lane-pilot workflow prove <workflowId> --provider <p> --model <m> [--cases <n>]` runs a graph's authored and replay cases on stubs with non-judge agent nodes pinned to that model and records receipts in `lane_pilot_wf_proof`, exposed as `proven_on` in `workflow_get`.
- **Runtime MCP effect check (and its limitation).** When a step declares `effect`, Lane Pilot exports `LANE_PILOT_NODE_EFFECT` into the helper environment and `lane-stack/hooks/guard_shell.py` denies any `mcp__<server>__<tool>` whose tier in `policy/ohmy-tool-tiers.json` exceeds `TIER_RANK[effect]`. **Limitation:** this runtime check only runs on clients where `guard_shell.py` is active (Claude Code and hook-compatible clients); providers/clients without `guard_shell.py` do not enforce `LANE_PILOT_NODE_EFFECT` on MCP calls.

## Work kinds

Workflows carry a top-level `kind` from `WORK_KINDS` (`routine | employee | project` in `packages/contracts/src/work-kinds.ts`), defaulting to `routine`:

- **`routine`** — one-shot or scheduled task graphs (`workflows/invoice-send.json`, `workflows/telegram-send.json`).
- **`employee`** — recurring domain shift graphs tied to a Specialist OS case folder (`workflows/sp-specialist-tick.json`).
- **`project`** — multi-stage goal delivery (`workflows/full-lifecycle.json`, `workflows/roadmap-driven.json`, `workflows/project-start.json`).

Long-running `project` runs pin the graph revision of every stage: when a workflow is updated or published over an older version, the previous revision is archived in `lane_pilot_wf_definition` (`definition-archive.ts`) so active runs continue resolving their pinned version across restarts and upgrades.

## Bricks: `deliver`

Shared multi-graph steps are extracted into reusable internal subworkflows ("bricks"). `workflows/deliver.json` is the channel-agnostic delivery brick: it accepts `{ channel, recipient, file_path, text, send_at }`, routes by channel (`telegram` -> `telegram-send`), and returns the delivery status unchanged. `workflows/invoice-send.json` (`send` node), `workflows/reels.json`, and `workflows/web-research.json` call `deliver` as a `subworkflow` instead of duplicating channel logic.

## Saving a path

When an errand or ad-hoc workflow run succeeds, the PM can capture it as a reusable project workflow draft with the `lane_pilot_path_save` PM tool or `bb lane-pilot path save <runId> [--note "<text>"]` (`src/rooms/workflow/server/services/path-save.ts`):

- Reads the finished run's errand episode trace (`lane_pilot_errand_episode`) or executed step trace, plus any trajectory deltas (`lane_pilot_trajectory_delta`) and owner verdict (`lane_pilot_wf_run_verdict`), and creates a `source: "path-capture"` draft via `createWorkflowArchitect`.
- Runs through the structural dedup gate (`createDedupeGate` in `dedupe-gate.ts`, comparing `graphSignature` / `traceSignature` against all library graphs and pending drafts at `paths.dedupe_threshold`, default `0.8`). If a near-twin already exists, path save refuses with `near_twin` and suggests adding a branch to that graph instead.
- `lead` (`listPathCandidates` in `src/rooms/lead/server/services/path-candidates.ts`) aggregates repeated episodes, catalog misses (`lane_pilot_route_miss`), and trajectory deltas, surfacing the top discovery candidate in the daily report and on the weekly review desk.

## Branches from deviations

Repeated owner interventions on an existing graph (`lane_pilot_trajectory_delta`, recorded by `recordTrajectoryDelta` when the owner steps in or amends a run) cluster into branch candidates (`branchCandidateKey` in `packages/workflow-engine`). Once a candidate reaches `paths.branch_draft_repeats` (default `3`) within `paths.branch_window_days` (default `30`), or when requested explicitly, `lane_pilot_path_save` (with `branch: { graphId, candidateKey }`) or `bb lane-pilot path branch <graphId> <candidateKey> [--project <id>] [--note "<text>"]` opens a `source: "branch-capture"` draft from `graphId` (exempting `graphId` itself from dedup).

- **Conditions into data.** When a `decision` node grows beyond 6 conditional `when` edges (`MAX_DECISION_WHEN_EDGES`), `validateWorkflowRails` warns `branches_into_data` to move conditions out of graph branching into a rule table or knowledge cards.

## Project templates

When a top-level `kind: "project"` run finishes (`succeeded`), passes its goal audit (`goal_audit`), and receives an owner `accept` verdict in `lane_pilot_wf_run_verdict`, `extractProjectTemplateFromRun` (`src/rooms/workflow/server/services/project-template.ts`) extracts a reusable `kind: "project"` draft (`source: "project-template"`) from its stage child runs and passes it through `createDedupeGate`:

- If a near-twin template already exists, it does not create a duplicate draft; instead it records a `class: "branch"` proposal on `lane_pilot_lead_road`.
- During intake (`createIntakeTrain`), matching published `project` templates are ranked and preferred over building a fresh chain from scratch.

## Publishing: grants and receipts

Every draft — from the Workflow architect, path capture, branch capture, project templates, or `lp.evolve` — passes through one draft store, one structural dedup gate, one permission-widening guard, and one publish authority gate (`lane_pilot_wf_publish_authority` in `packages/workflow-engine/src/publish-authority.ts`):

- **Publish authority (`PublishAuthority`).** Publishing consumes a single-use row bound to `(draft_id, draft_sha256)`. It is either:
  - an **owner grant** (`kind: "owner"`, `via: "desk" | "cli" | "chat"`), issued by `bb lane-pilot workflow publish <draftId> --owner`, by the weekly review desk (`workflow_draft_publish`), or by explicit owner confirmation in chat (`grantOwnerFromChatConfirmation`); or
  - an **evolution receipt** (`kind: "evolution"`, `trialId`, `decision: "promote" | "demote"`), issued only by `lp.evolve` when a hypothesis passes the statistical and held-out gates above the sample threshold.
- **Permission-widening guard (`draft-guard-policy.ts`).** Any learned draft (`path-capture`, `branch-capture`, `project-template`, `branch`) whose diff widens node effects, tools, skills, MCP access, or removes a human gate is flagged `needs_owner_review: "widens"` and posts a `workflow_draft_widens` item until granted by the owner (`workflow_draft_grant`). An `evolve` draft that widens permissions or touches evaluators is refused outright.
- **Durability export (`npm run graphs:export`).** Graphs published or evolved on the hub live in SQLite (`lane_pilot_wf_definition`); run `npm run graphs:export` (`scripts/export-hub-graphs.ts`) in a clean checkout to export them back to `workflows/*.json` and mark the export timestamp (`bb lane-pilot graphs status`, `bb lane-pilot graphs mark-exported`).

## Sources

Where this page's claims start in the code: `packages/workflow-engine/src/engine.ts`, `packages/workflow-engine/src/engine-clock.ts`, `packages/workflow-engine/src/inbox.ts`, `packages/workflow-engine/src/router.ts`, `packages/contracts/src/graph-categories.ts`. The deep pages linked above cite the rest.

### Evidence at the goal audit

The inferred request goal keeps the complete routing request (up to 4,000 characters). A longer request is returned for clarification; it is not silently shortened. The request is retained in the run journal, PM status and helper regrounding, and changing it changes the audit cache identity.

Durable reports are written without prompt-length clipping. Audit blocks exceeding their inline limits are delivered through the existing content-addressed packet files. The auditor must read those references before deciding; inability to read one is missing evidence.

Engine-registered root output files are read on their recorded host and checkout and checked against the stored content hash and byte count. Helper receipts also carry repository observations at the start and end of the observed interval, including nested graph and vote receipts. These are endpoint observations, not proof of every action: temporary write-and-revert, ignored files, untracked file contents and external effects are outside their scope. Missing or incomplete observations cannot be counted as a clean run. Live acceptance must separately show that the auditor actually consumed the references and that the graph met its goals.

Root execution has its own observations: an initial snapshot is journaled before the first executor, including a builtin subworkflow; the final snapshot is journaled after execution and before the goal audit. The initial observation is never reconstructed on reload. A historical run without it explicitly reports an unavailable initial state. Final observations and cached positive audits are bound to the current execution revision, so rerunning a node with identical output still requires fresh observations and an audit. Child helper windows remain separate. The root interval includes any idle time and other users of the checkout; it does not attribute their effects to the graph.

Large repeated filename lists are presented as counts, hashes and bounded filename differences, with a reference to the complete measured windows. Omitted names and unknown fingerprints stay explicit. Root endpoint comparisons require matching host and checkout; a missing snapshot or different checkout cannot establish equality. Verified registered report files explain those recorded writes, not every possible effect in the checkout.
