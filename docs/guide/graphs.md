---
title: Everything is a graph
topic: graphs
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, graphs]
updated: 2026-11-06
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/router.ts
  - packages/workflow-engine/src/index.ts
---

# Everything is a graph

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

A workflow is a JSON file (`workflows/*.json`): inputs, outputs, `requires` (skills, plugins, secrets, machines), guards, triggers, nodes and edges. The shared engine (`packages/workflow-engine`) validates it, runs it as a resumable graph, journals every step in SQLite and resolves subworkflows. Node types in the shipped graphs: `agent` (a model step with a role), `action` (code), `jev` (a small judgment), `decision`, `human` (a form to the owner), `parallel`/`join`, `subworkflow` and `lp-task` (the writer task pipeline). The model of a step belongs to its **role**, never to the node (see [Roles, agents and models](roles.md)).

- **Catalog.** 79 graphs ship with the plugin (69 `published`, 10 `tested`). A `tested` graph shows **Run for real** in the Workflows tab; one success makes it published. Owners can add graphs in the global or a project workflow folder.
- **Router.** `lane_pilot_route` matches a request to a published graph: BM25 plus trigram match against names, tags and examples, priority rules in code, `not_for` and `requires` checks, then a Jev choice (an Opus helper thread decides the unclear cases). Under 60 percent confidence it returns up to three questions instead of a guess. `lane_pilot_run_workflow` starts the choice with the inputs and goals the owner confirmed.
- **Triggers.** A graph starts from the PM chat (`chat`), by hand from the Workflows tab (`manual`), from a schedule, or from another plugin (`telegram`). All four go through the same checks.
- **Authoring.** The Workflow architect agent drafts, patches and tests a graph on stubs (nothing is touched); publishing waits for the owner's yes. A published graph can run on a schedule.
- **Runs audit their goals.** A run is checked against the goals the owner confirmed before it closes; a run blocked on unmet goals is fixed or amended with a reason in its journal.

## Shipped graphs

`(tested)` marks graphs that have not yet had a successful live run.

**Writer tasks and phases**

| Graph | What it does |
|---|---|
| `lp-task-pipeline` | The pipeline of every writer task: PM read, plan critique, specialist review, ownership base, the code task in its own worktree with checks, code critique and merge, then the browser check when the task has `qa_cases`. Not offered by the router. |
| `lp.after-accept` | Runs after a task is accepted: the memory maintainer and the project-life maintainer, side by side. |
| `lp.plan` | Turns a goal into task contracts in waves, lints them and has the whole plan critiqued. |
| `lp.build` | Runs task contracts through the pipeline (writer, sandbox verification, code critic, merge queue) and the batch gate. |
| `lp.analyze` | Read-only analysis of an area with locked, free and deferred decisions, risks and a scope verdict. |
| `lp.review` | Multi-dimension review of a diff, PR or file set; the verdict is computed by code. |
| `lp.brainstorm` | Role authors in parallel, a fresh cross-role reviewer, conflicts resolved with the owner, a guidance specification of at most 8 features. |
| `lp.draw` | The design lead draws the screens a plan changes as clickable HTML mock-ups; another role checks them. |
| `lp.close` | Checks each goal's `done_when` against evidence, detects intent drift, stages knowledge candidates, updates project life. |
| `analyze-plan-execute` | Default path for a normal code task: analysis, task contracts, plan critique, writers in worktrees, code critic, merge, goal audit, memory. |
| `companion` | A mechanically clear, bounded change: one writer task in quick mode, no plan, no critics. |
| `issue-quick` | A small issue from a title and text: one cheap call writes the task, the writer builds it. A large issue is proposed to the full path. |
| `issue-quick-legacy` | The previous quick path (triage, plan, build); used when `issue_quick.short_path` is off. |
| `issue-full` | Root cause, plan, build, review; reports fixed only after a green review. |
| `issue-batch` | Several small independent fixes in one request, edits of one file as one task, independent areas built in one wave. |
| `issue-discover` | Eight read-only perspectives (security, performance, reliability and more) scan an area; findings are deduplicated. |
| `plan-only` | Analyze and write task contracts with plan critique, saved as a draft; nothing is built. |
| `plan-review-convergence` | Two critics of different models review a plan for up to three rounds until both approve. |
| `full-lifecycle` | Plan, build, independent review with a fix loop, browser check, owner acceptance for UI, goal audit, knowledge closeout. |
| `blueprint-driven` | For a new product: brief, PRD, architecture decisions, epics, a readiness gate, the spec in the repository, then build per epic. |
| `brainstorm-driven` | From a vague idea: optional research, multi-role brainstorm, guidance spec, plan, build, close. |
| `grill-driven` | For big or risky changes: an adversarial walk through the plan against the real code, then brainstorm, plan, build, close. |
| `grill-plan` | The adversarial review of a plan on its own; changes nothing. |
| `roadmap-driven` | For large goals: a DAG of sessions approved by the owner, each run as `analyze-plan-execute`. |
| `impeccable-build` | A UI from scratch: design brief, DESIGN.md pack, build in worktrees, browser verification at 375 and 1280 px, DESIGN.md from the result. |
| `refactor` | Behaviour-preserving restructuring: baseline first, plan with critique, writers, equivalence check, review. |
| `quality-loop` | Review, missing tests by layer, failure classification, diagnosis, fix and re-check; schedulable at night. |
| `review-fix` | Takes review findings (or runs a review), groups them by root cause, fixes and re-reviews up to two rounds. |
| `test-gen` | Writes missing tests for named gaps in test paths only; never edits source or existing tests. |
| `ai-integration-phase` | Before a phase that ships model behaviour: framework and model choice, research, AI-SPEC.md with guards, evaluation plan and cost ceiling. |

**Read-only analysis and audits**

| Graph | What it does |
|---|---|
| `analyze-code` | Understand or evaluate a module or change; reports decisions, risks and confidence. |
| `code-review` | Independent review of a branch, PR, commit range or file set with file:line findings. |
| `debug` | Scientific-method diagnosis (hypotheses, evidence log, at most 3 refuted); returns the diagnosis, touches no code. |
| `security-audit` | Tiered audit (OWASP Top 10, dependencies, secrets, CI/CD, STRIDE on the deep tier); secrets reported by location only. |
| `ui-audit` | Live UI audit in the browser on six dimensions with scored findings and screenshots. |
| `eval-review` | Audits the evaluation of an AI feature (gold set independence, metric honesty, gaming, leakage). |
| `validate-phase` | Checks that every promise of a phase has a check that would fail without the work; writes VALIDATION.md. |
| `spike` | A time-boxed throw-away experiment answering one technical question. |

**Delivery, milestones and housekeeping**

| Graph | What it does |
|---|---|
| `ship` | Turns a verified phase into a pull request and runs post-ship hooks. |
| `pr-branch` | Makes a review branch without the planning commits. |
| `deploy` (tested) | Preflight, owner approval for production, deploy by the repo script or an errand, post-deploy check, rollback offer. |
| `project-start` | Value map first, a preview of stack, tests and memory, infra profile, working style, recap with next steps. |
| `new-milestone` | Starts the next milestone: goals, requirements, roadmap phases. |
| `milestone-close` | Checks the run is finished, audits goals, runs a retrospective, stages knowledge candidates, archives the run. |
| `retrospective` | Four lenses (technical, process, quality, decision); stages rule or note candidates, writes no knowledge without approval. |
| `cleanup` | Archives finished phases, stale spikes, merged review branches and leftover worktrees; lists before moving. |

**Helpers outside the writer path**

| Graph | What it does |
|---|---|
| `specialist` | One specialist (design-lead, copy-lead, seo-specialist, tavily, video-lead or an owner-created agent) does a task as a child thread of the PM chat. |
| `agent-routine` | What a schedule of kind `agent` runs: a named agent does its standing task with its own prompt, skills and memory of earlier runs. |
| `errand` | A non-code job done end to end by one helper: a browser, a mailbox, a cloud console, a deploy with Env Catalog accounts. Accounts are checked first. |
| `browser-step` | One goal in the owner's signed-in Chrome on the browser machine with agent-desktop (an LLM agent drives it through the accessibility tree), then the page it ends on. |
| `lp.browser-qa` | The browser check of an accepted task: a verdict per case and viewport. |
| `lp.route` | The model step of `lane_pilot_route` when Jev cannot decide a request alone. |
| `council` | A council of directors: a chair, role-bound seats each on its own model, a written decision. |

**Research, content and media**

| Graph | What it does |
|---|---|
| `web-research` (tested) | Sub-questions, parallel search, claims checked against independent sources, a cited report. |
| `research-dossier` | Sources found, links and quotes verified, unverified sources discarded, a verified dossier. |
| `insights-post` (tested) | Finds the most discussed posts on a topic, mines comments into insight artifacts, hands the author a writing pack. |
| `ins.post` | Collects the comments of one post and analyzes them by lenses, with a critic and a validator. |
| `social-post` | A topic to an audience-validated post in the author's voice, formatted as a Telegram Rich Message. |
| `x-to-telegram-digest` (tested) | A digest of recent public X posts on a topic, quotes checked in code, sent to Telegram. |
| `seo-cocoon` (tested) | Semantic cocoon: audience evidence, page architecture, content briefs, audit; changes no site. |
| `seo-page` | A targeted SEO page built on `seo-cocoon`, proofread and exported to site files. |
| `reels` (tested) | Long video to vertical clips, or a short code-rendered animated film from a subject. |
| `3d-asset` | Brief, concept images, modeling in Blender, geometry QA, export. |
| `roblox-asset` | A Roblox model or accessory, scale and collision checked, deployed via Rojo or Studio. |
| `macos-routine` | Operational routines on the Mac mini with screenshot evidence. |
| `invoice-send` (tested) | An invoice in Kontur.Elba made, checked in code and by a Jev judgment, approved by the owner, then sent. |
| `billing-batch` | A list of clients and services invoiced through `invoice-send`, with a summary registry and owner approval before dispatch. |

**Owner profile (Anamnesis)**

| Graph | What it does |
|---|---|
| `resume` (tested) | A one-page resume from the confirmed, public anamnesis records. |
| `about-site` (tested) | A one-page personal site from the same records, with no link or address the facts lack. |
| `year-review` (tested) | The year in review from the public records. |

**Self-improvement and maintenance (started by Lane Pilot itself)**

| Graph | What it does |
|---|---|
| `lp.self-repair` | One repair of a failure that is Lane Pilot's own fault, in its own worktree, with a test. |
| `lp.wall-hunt` | The night loop's model work on one wall: read-only hunters from three sides over one evidence pack, citations held by code. |
| `lp.rules-scan` | The night scan of a project's writer failures that writes project rules and judges rules on trial. |
| `lp.rules-ask` | One prompt to the rules analyzer (the learning review of the owner's messages). |
| `lp.harness-edit` | One improvement round of the writer harness for a key (project, area, writer model), put on trial in alternation. |
| `lp.harness-reflect` | After a decided harness trial: a reflection session and at most one lesson that transfers. |
| `lp.critic-edit` | Monthly: reads each critic's verdict accuracy and writes a prompt proposal when it is under half on four or more verdicts. |
| `lp.docs-maintenance` | The docs maintainer of one accepted task: edits returned as JSON, validated by code, written. |
| `lp.docs-night` | One docs folder brought up to date overnight, with Jev anchors and gap finding. |

## Sources

Where this page's claims start in the code: `packages/workflow-engine/src/engine.ts:33-53`, `packages/workflow-engine/src/router.ts:14-34`, `packages/workflow-engine/src/index.ts:1-21`. The deep pages linked above cite the rest.
