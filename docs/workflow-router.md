# Workflow router (W4)

The router maps a request to one of the published workflows of the catalog, or asks. Pure code in `src/workflow/router.ts` (no SDK, no database); the PM tools are in `src/server/workflow-tools.ts`. Source of the rules and of the evaluation set: `workflow-chains-spec.md`, sections 1 and 6.

## What is offered

Only `published`, not `internal` workflows, and never `lp-task-pipeline` (how Lane Pilot runs every writer task). The catalog is `services.workflowCatalog.store()`. A draft, a deprecated workflow and a fragment are not candidates, are not shown to the model and cannot be started by `lane_pilot_run_workflow`.

## Pipeline of `routeIntent({ intent, context?, workflows, state?, model? })`

1. **«Continue» is no workflow.** `продолжай`, `continue`, `what next` return `stateContinue: true` and no choice (spec 4.3: the answer comes from the state of the run).
2. **Search.** Text is folded (case, diacritics, `ё`/`й`, punctuation), split into words, stop words dropped, endings trimmed by cheap suffix lists (Russian and English). Each card is one document of weighted fields: name x3, tags x2.5, description x1.5 (en and ru), examples x1. Score = 0.6 x BM25 (words of the request the catalog never saw count a little against) + 0.4 x best trigram (Dice) match against one example.
3. **Priority rules in code** (spec section 1), each adds or subtracts a fixed amount for named workflows and is recorded in the evidence: a tracker id or URL (`issue-full`/`issue-quick`; `UTF-8` is not an id), UI words (a from-scratch design ask for `impeccable-build`, an evaluation for `ui-audit`, plain UI words nothing), external areas (X and Telegram, social discussions, video, cocoon, deploy, web research), failure without a fix request (`debug`), a request that forbids changes (demotes every writing chain), a short change in a named file (`companion`, only when nothing more specific fired), stages named (`full-lifecycle`), and a dozen more for the neighbouring chains. A rule keyed by an id that is not in the catalog does nothing.
4. **`not_for`.** An entry that is a workflow id lowers this card by a quarter of how much that neighbour (score with its rule hits) beats 0.9 x this card; an entry with spaces is a phrase, and a request close to it lowers the card.
5. **State checks** against `requires` through the `RouterState` port (`skill`, `plugin`, `secret`, `machine`, `project`, `openTasks`). Unknown (`undefined`) means available; only a known `false` excludes the workflow, with the reason in `evidence.rejected` and a warning if it was the closest match. Optional secrets (`TAVILY_API_KEY (only with ...)`) and prose in `requires.machines` never exclude. `milestone-close` with open tasks warns.
6. **The model port.** The top 5 cards (id, name, description, examples, `not_for`, tags, inputs, outputs, requires, score, rules) go to `RouterModel` and it answers `{ choice | null, confidence 0-100, pattern, rejected[], questions[] }`. The production model is Jev first with an escalation to a thread (below); the default without one is `deterministicRouterModel`: the top score and its margin over the second, plus rule hits, mapped to a confidence. Another model is plugged with `setRouterModel(model)` or the `model` option of one call; a model that throws, or names an id outside the candidates, is replaced by the scorer and `evidence.modelFallback` says so.
7. **Decision.** Confidence under 60, a broad request (fewer than two significant words and no strong rule) or a null choice gives `decision: "clarify"`, no `workflowId`, and up to three questions: the model's own, else the signal that tells the top two apart, the required inputs still missing, then scope, constraints and done-criteria. Otherwise `decision: "route"` with `workflowId`, `confidence`, `evidence { pattern, rejected, rules, model }`, `boundary_contract { in_scope, out_of_scope, constraints, guesses }`, `goals [{ id, done_when, evidence }]`, `inputs`, `missingInputs`, `guessedInputs`, `warnings`.

## What is a guess

- `boundary_contract.in_scope` is the request as written plus the files and links in it. `out_of_scope` is the negations found in the request (`do not change anything`), so it can be empty (and `guesses` says so). Constraints come from the rules (read-only, behaviour kept) and from sentences of `context` that read like a constraint; `guesses` names each one that is inferred.
- `goals`: the first, `request`, is marked `guess: true` (the request restated); the others come from the workflow's declared outputs, `status` first, at most four.
- `inputs`: tracker ids, PR numbers, links and files are read from the request; free-text inputs (`goal`, `question`, `topic`, `query`, ...) get the request as is and are listed in `guessedInputs`. Everything else required is in `missingInputs`.
- Confidence of the deterministic scorer (the fallback) is a heuristic, not a probability. Most correct choices rest on a rule hit; a request in none of the rules' words is decided by the card text alone.

## Tools

- `lane_pilot_route { intent, context? }`: runs the pipeline on the catalog; nothing starts. The answer adds `next` (what the PM does with it). With nothing published it says to work the usual way.
- `lane_pilot_run_workflow { workflowId, inputs }`: finds the PM's Lane Pilot run (the open one, else the latest of the chat), refuses an unknown, unpublished, fragment or pipeline id and missing required inputs, then `engine.start({ workflow, inputs, key, runtime, link })` with the `ChainRuntime` of `workflow-runtime.ts`. The key is `wf:<run id>:<workflow id>:<hash of the sorted inputs>`, so a repeated call is the same workflow run. `done` is not awaited (a rejection is logged). A refusal of the engine (a node's executor not registered, an input that does not fit) comes back as `{ status: "refused", reason: "cannot_start: ..." }`.
- `lane_pilot_workflow_status { runId }`: status, reason, steps as node/state/visit, waiting steps, output (fenced as data from outside). A run of another project is answered as not found.

## Evaluation

`tests/workflow/router-eval.test.ts` runs the 30 phrases of spec 6.2 (expected workflow, or `clarify` for no workflow) on the real catalog with every non-internal workflow set to `published`, deterministic scorer; it requires 27 of 30 (90 percent), recall at 5 with at most one miss, and that phrase 30 returns `clarify` with confidence under 60. It also routes the 8 reserve phrases and a set of paraphrases. A miss is a catalog gap (add an example, a tag or a `not_for`; never an example equal to an eval phrase), not a test to loosen. Run it again whenever a chain is added to the catalog.

## The model step: Jev first, a thread for the unclear case

`createJevRouterModel` (`src/jev/route-model.ts`, the judgment `route.workflow` in `src/jev/judgments/route-workflow.ts`) is the model of `lane_pilot_route`. One request to Jev (TypeSafe `systemone`, about 0.3 s and 2.6k input tokens) carries the top candidates and asks a Choice over them plus «none of these», a «too broad» question, and, for each candidate input that is an enum or a switch, a closed question; the chosen workflow's stated inputs fill `inputs`. Jev's answers are probabilities and code decides:

- A clear pick (`min_p` 0.6, `min_margin` 0.25 over the runner-up, «none of these» under `max_none` 0.3, «too broad» under `max_broad` 0.9) is the answer. A very broad request (`broad_clarify` 0.95) is a `clarify` at once.
- Anything else is **escalated to the helper thread** that decided every route before Jev (an Opus thread in the PM's run, tens of seconds). Its answer is stored next to Jev's as an `agree` / `disagree` label in `lane_pilot_jev_receipt`, the instrument for calibrating the thresholds. A chat without a run has no thread to escalate to: the scorer answers.
- No key (`TYPESAFE_API_KEY` in Env Catalog), a failed call or an open breaker: the model throws and the router's scorer decides, with the reason in `evidence.modelFallback`.

Mode per project in the `jev.modes` setting, `route.workflow=` `active` (the default, above), `shadow` (the thread decides, Jev is recorded) or `off` (the thread alone, as before Jev); `jev.enabled=false` turns every judgment off; `jev.thresholds` sets the numbers above (`route.workflow.min_p=0.7`, clamped to their ranges). If routing misbehaves, raise `max_broad` / `broad_clarify` first, not `min_p`. `scripts/jev-router-eval.ts` runs the evaluation phrases against the live Jev; numbers and the way to read the receipts are in the 0.1.191 notes of CHANGELOG.md.

## What is not here

Probes that feed `RouterState` with installed skills, plugins and secrets (only `openTasks` is read from the database today), and the `lane_pilot_run_start` of the spec (the run tool above replaces it).
